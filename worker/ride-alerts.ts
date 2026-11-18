// Stop alerts while the phone is locked (#176 step C). Design: docs/LOCKED_STOP_ALERTS.md.
// The server watches only the exact trip instance and vehicle the rider locked, and decides the stage with
// the app's own rules (busLock/lock, rideGuide, stopAlertStep): it never switches buses, never alerts from a
// stale, ambiguous or unmatched position, and never sends a countdown while NJ Transit reports skipped stops.
// A ride row lives only for one ride. Endpoints are capability URLs: never logged, returned or shown in health.
import { createBusSession, reduceBusSession, type BusSession } from '../src/domain/busLock';
import { DEFAULT_TIMING } from '../src/domain/lock';
import { rideGuide, STAGE_RANK, type RideStage } from '../src/domain/rideGuide';
import { stageMessage, stopAlertStep } from '../src/domain/stopAlert';
import { LIVE_MAX_AGE_MS, validServiceDate, validVehicleId, type LiveBusSnapshot } from '../src/domain/liveBus';
import { isServiceActive, tripArrivalAt, tripTimeAt } from '../src/domain/schedule';
import { addDays, localYmd } from '../src/domain/time';
import { tripInstanceId, type Dataset, type Departure } from '../src/domain/types';
import { strings, type Lang } from '../src/ui/i18n';
import type { HistorySql } from './history-journal';
import { loadVapid, sendPush, toBase64Url } from './web-push';

export const MAX_RIDES = 20;
/** A ride the app has not activated (its service-worker record is not written) is deleted after this. */
export const PENDING_MS = 2 * 60_000;
/** No ride outlives this, counted from creation. */
export const RIDE_CAP_MS = 3 * 3600_000;
/** Expiry is this long after the later of the scheduled and predicted arrival (or the latest fresh position). */
export const AFTER_ARRIVAL_MS = 30 * 60_000;
/** A prediction observed longer ago than this is no prediction. */
export const PREDICTION_FRESH_MS = 2 * 60_000;
/** Build requirement 2 (#176): a predicted arrival this far in the past is no prediction either. */
export const PREDICTION_PAST_MS = 30 * 60_000;
/** A sent but unconfirmed stage is pushed again at most this often, and only while it is still current. */
export const REPUSH_MS = 30_000;
/** A pending service-change notice is pushed again this often, at most NOTICE_REPUSHES times. */
export const NOTICE_REPUSH_MS = 2 * 60_000;
export const NOTICE_REPUSHES = 5;
/** A ride's lock and history are written at least this often, and sooner only when something that matters changed. */
export const SAVE_MS = 2 * 60_000;
/** Consecutive refused pushes (a 4xx other than 404/410, such as 403 after a key change) before the ride ends. */
export const MAX_PUSH_FAILURES = 3;
/** A tombstone (id and reason only) answers "ended" until the ride's expiry, and at least this long. */
export const TOMBSTONE_MIN_MS = 10 * 60_000;
export const MAX_BODY_BYTES = 4096;
const WRONG_WINDOW_MS = 10 * 60_000, WRONG_LIMIT = 5, WRONG_LOCKOUT_MS = 3600_000, WRONG_ADDRESSES = 1000;

export type EndReason = 'unlocked' | 'got_off' | 'arrived' | 'passed' | 'expired' | 'replaced' | 'push_failed';
export type NoticeState = 'none' | 'pending' | 'shown';
export interface RideRow {
  id: string; state: 'pending' | 'active' | 'ended'; reason: EndReason | null; endpoint: string; trip: string; date: string; vehicle: string;
  board: number; alight: number; lang: Lang; createdAt: number; expiresAt: number; sentStage: RideStage | null; shown: number;
  serviceChange: boolean; notice: NoticeState; noticePushes: number; noticeAt: number | null; lastPushAt: number | null; session: string | null;
  savedAt: number | null; failures: number;
}
/** What one check writes, in a single statement: the lock and history with flag and expiry, and push results that must outlive a restart. */
export interface RidePatch {
  session?: string; serviceChange?: boolean; expiresAt?: number; savedAt?: number;
  sentStage?: RideStage; lastPushAt?: number; noticeAt?: number; failures?: number;
}
export interface RideEnv { VAPID_PRIVATE_KEY?: string; HOUSEHOLD_CODE_HASH?: string }
interface RideStorage { sql: HistorySql; transactionSync<T>(callback: () => T): T }
type SavedSession = Pick<BusSession, 'lock' | 'history' | 'stopChanges' | 'pendingPosition'> & { feed?: 'ok' | 'missing' | 'ambiguous' };

export const RIDE_PATH = /^\/v1\/ride-alerts\/([A-Za-z0-9_-]{22})(?:\/(activate|latest|ack|notice-ack))?$/;
const STAGES = Object.keys(STAGE_RANK) as RideStage[];
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** Push endpoints only on the known browser push services, so the Worker can never be pointed elsewhere. */
export function allowedEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1024) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.href !== value || url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname;
  return ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(host)
    || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com');
}

export const validCodeHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** The household code (docs/RIDER_GPS.md), normalized, hashed and compared in constant time. */
export async function codeMatches(code: unknown, hash: string): Promise<boolean> {
  const text = typeof code === 'string' && code.length <= 128 ? code.trim().toUpperCase().replace(/[\s-]/g, '') : '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const hex = [...digest].map((n) => n.toString(16).padStart(2, '0')).join('');
  let difference = hex.length ^ hash.length;
  for (let i = 0; i < hex.length; i++) difference |= hex.charCodeAt(i) ^ (hash.charCodeAt(i) || 0);
  return typeof code === 'string' && code.length <= 128 && difference === 0;
}

/** Wrong codes per network address, in memory only. A correct code is always accepted. */
export class WrongCodes {
  private readonly seen = new Map<string, { times: number[]; lockedUntil: number }>();
  locked(address: string, now: number) { return (this.seen.get(address)?.lockedUntil ?? 0) > now; }
  record(address: string, now: number) {
    for (const [key, entry] of this.seen) if (entry.lockedUntil <= now && entry.times.every((t) => now - t > WRONG_WINDOW_MS)) this.seen.delete(key);
    if (!this.seen.has(address) && this.seen.size >= WRONG_ADDRESSES) return;
    const entry = this.seen.get(address) ?? { times: [], lockedUntil: 0 };
    entry.times = [...entry.times.filter((t) => now - t <= WRONG_WINDOW_MS), now];
    if (entry.times.length >= WRONG_LIMIT) entry.lockedUntil = now + WRONG_LOCKOUT_MS;
    this.seen.set(address, entry);
  }
}

export class RideStore {
  constructor(private readonly storage: RideStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS dale_ride_alerts (id TEXT PRIMARY KEY, state TEXT NOT NULL, reason TEXT, endpoint TEXT, trip TEXT,
      date TEXT, vehicle TEXT, board INTEGER, alight INTEGER, lang TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, sent_stage TEXT,
      shown INTEGER NOT NULL DEFAULT 0, service_change INTEGER NOT NULL DEFAULT 0, notice TEXT NOT NULL DEFAULT 'none',
      notice_pushes INTEGER NOT NULL DEFAULT 0, notice_at INTEGER, last_push_at INTEGER, session TEXT, saved_at INTEGER,
      failures INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID`);
  }
  private rows(query: string, ...bindings: (string | number | null)[]): RideRow[] {
    return this.storage.sql.exec(query, ...bindings).toArray().map((r) => ({
      id: String(r.id), state: r.state as RideRow['state'], reason: (r.reason ?? null) as EndReason | null, endpoint: String(r.endpoint ?? ''),
      trip: String(r.trip ?? ''), date: String(r.date ?? ''), vehicle: String(r.vehicle ?? ''), board: Number(r.board ?? 0), alight: Number(r.alight ?? 0),
      lang: r.lang === 'es' ? 'es' : 'en', createdAt: Number(r.created_at), expiresAt: Number(r.expires_at),
      sentStage: STAGES.includes(r.sent_stage as RideStage) ? r.sent_stage as RideStage : null, shown: Number(r.shown),
      serviceChange: Number(r.service_change) === 1, notice: (['pending', 'shown'].includes(String(r.notice)) ? r.notice : 'none') as NoticeState,
      noticePushes: Number(r.notice_pushes), noticeAt: r.notice_at == null ? null : Number(r.notice_at),
      lastPushAt: r.last_push_at == null ? null : Number(r.last_push_at), session: r.session == null ? null : String(r.session),
      savedAt: r.saved_at == null ? null : Number(r.saved_at), failures: Number(r.failures ?? 0),
    }));
  }
  get(id: string) { return this.rows('SELECT * FROM dale_ride_alerts WHERE id=?', id)[0]; }
  ids(state: 'active' | 'pending') { return this.rows('SELECT * FROM dale_ride_alerts WHERE state=? ORDER BY created_at', state).map((r) => r.id); }
  count(state: 'active' | 'pending') { return Number(this.storage.sql.exec('SELECT COUNT(*) AS n FROM dale_ride_alerts WHERE state=?', state).toArray()[0]?.n ?? 0); }
  /** When the next alarm is needed: the global poll pace while a ride is active, a pending ride's deadline otherwise. */
  nextWake(pollDue: number): number | null {
    if (this.count('active') > 0) return pollDue;
    const first = this.storage.sql.exec("SELECT MIN(created_at) AS t FROM dale_ride_alerts WHERE state='pending'").toArray()[0]?.t;
    return first == null ? null : Number(first) + PENDING_MS;
  }
  /** Keep only the id, reason and times: no push address, trip, vehicle, stops or language. */
  end(id: string, reason: EndReason, now: number) {
    this.storage.sql.exec(`UPDATE dale_ride_alerts SET state='ended', reason=?, endpoint=NULL, trip=NULL, date=NULL, vehicle=NULL, board=NULL, alight=NULL,
      lang=NULL, sent_stage=NULL, session=NULL, expires_at=MAX(expires_at, ?) WHERE id=? AND state<>'ended'`, reason, now + TOMBSTONE_MIN_MS, id);
  }
  /** Pending rides past 2 minutes and active rides past expiry end; tombstones past expiry go entirely. */
  purge(now: number) {
    this.storage.transactionSync(() => {
      for (const r of this.rows("SELECT * FROM dale_ride_alerts WHERE (state='pending' AND created_at<=?) OR (state='active' AND expires_at<=?)", now - PENDING_MS, now)) this.end(r.id, 'expired', now);
      this.storage.sql.exec("DELETE FROM dale_ride_alerts WHERE state='ended' AND expires_at<=?", now);
    });
  }
  /** One active ride per push subscription (the newer replaces the older) and at most MAX_RIDES in all. */
  create(row: Pick<RideRow, 'id' | 'endpoint' | 'trip' | 'date' | 'vehicle' | 'board' | 'alight' | 'lang' | 'createdAt' | 'expiresAt' | 'session'>): boolean {
    return this.storage.transactionSync(() => {
      const others = Number(this.storage.sql.exec("SELECT COUNT(*) AS n FROM dale_ride_alerts WHERE state<>'ended' AND endpoint<>?", row.endpoint).toArray()[0]?.n ?? 0);
      if (others >= MAX_RIDES) return false;
      for (const r of this.rows("SELECT * FROM dale_ride_alerts WHERE state<>'ended' AND endpoint=?", row.endpoint)) this.end(r.id, 'replaced', row.createdAt);
      this.storage.sql.exec(`INSERT INTO dale_ride_alerts (id, state, endpoint, trip, date, vehicle, board, alight, lang, created_at, expires_at, session, saved_at)
        VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.id, row.endpoint, row.trip, row.date, row.vehicle, row.board, row.alight, row.lang,
      row.createdAt, row.expiresAt, row.session, row.createdAt);
      return true;
    });
  }
  activate(id: string) { this.storage.sql.exec("UPDATE dale_ride_alerts SET state='active' WHERE id=? AND state='pending'", id); }
  /** Only ever raises "last shown". */
  ack(id: string, rank: number) { this.storage.sql.exec("UPDATE dale_ride_alerts SET shown=MAX(shown, ?) WHERE id=? AND state<>'ended'", rank, id); }
  /** The phone showed a service-change answer: keep the flag and stop the notice. */
  noticeAck(id: string) { this.storage.sql.exec("UPDATE dale_ride_alerts SET notice='shown', service_change=1 WHERE id=? AND state<>'ended'", id); }
  /** One check's write, at most one statement. Column names are fixed here; only values are bound. */
  update(id: string, patch: RidePatch) {
    const sets: string[] = [], values: (string | number | null)[] = [];
    const set = (sql: string, value: string | number | null) => { sets.push(sql); values.push(value); };
    if (patch.session !== undefined) set('session=?', patch.session);
    if (patch.serviceChange !== undefined) set('service_change=MAX(service_change, ?)', patch.serviceChange ? 1 : 0);
    if (patch.expiresAt !== undefined) set('expires_at=?', patch.expiresAt);
    if (patch.savedAt !== undefined) set('saved_at=?', patch.savedAt);
    if (patch.sentStage !== undefined) set('sent_stage=?', patch.sentStage);
    if (patch.lastPushAt !== undefined) set('last_push_at=?', patch.lastPushAt);
    if (patch.failures !== undefined) set('failures=?', patch.failures);
    // An accepted notice push: pending until the phone confirms it. Only accepted pushes count toward the limit.
    if (patch.noticeAt !== undefined) {
      sets.push("notice=CASE WHEN notice='shown' THEN 'shown' ELSE 'pending' END", 'notice_pushes=notice_pushes+1');
      set('notice_at=?', patch.noticeAt);
    }
    if (!sets.length) return;
    this.storage.sql.exec(`UPDATE dale_ride_alerts SET ${sets.join(', ')} WHERE id=? AND state='active'`, ...values, id);
  }
}

/** What the ride shows right now, from the same rules as the screen (RideMode). */
export type RideNow =
  | { kind: 'service_change' }
  | { kind: 'uncertain' }
  | { kind: 'stage'; stage: RideStage; stopsAway: number; observedAt: number };
export type RideAction = { push: 'notice' } | { push: 'stage'; stage: RideStage } | { end: 'arrived' | 'passed' } | undefined;

/**
 * One check's decision. Service change: a notice, pushed again every 2 minutes (at most 5 more times) until the
 * phone confirms it, and never a countdown. Otherwise stopAlertStep from the last stage the phone confirmed
 * (starting at rank 0, "riding"), so a ride registered inside 3 stops still alerts once. A sent but unconfirmed
 * stage is pushed again at most every 30 seconds while it is still current; a stage the bus has passed never is.
 */
export function decideRide(row: Pick<RideRow, 'shown' | 'sentStage' | 'lastPushAt' | 'notice' | 'noticePushes' | 'noticeAt'> & { failAt?: number | null }, now: number, state: RideNow): RideAction {
  const action = decide(row, now, state);
  // A push the push service did not accept stays due, but is tried again at most every 30 seconds.
  if (action && 'push' in action && row.failAt != null && now - row.failAt < REPUSH_MS) return;
  return action;
}
function decide(row: Pick<RideRow, 'shown' | 'sentStage' | 'lastPushAt' | 'notice' | 'noticePushes' | 'noticeAt'>, now: number, state: RideNow): RideAction {
  if (state.kind === 'service_change') {
    if (row.notice === 'none') return { push: 'notice' };
    if (row.notice === 'pending' && row.noticePushes < 1 + NOTICE_REPUSHES && now - (row.noticeAt ?? 0) >= NOTICE_REPUSH_MS) return { push: 'notice' };
    return;
  }
  if (state.kind !== 'stage') return;
  if (state.stage === 'arrived' || state.stage === 'passed') return { end: state.stage };
  if (!stopAlertStep(row.shown, state.stage).alert) return;
  if (row.sentStage && STAGE_RANK[state.stage] < STAGE_RANK[row.sentStage]) return;
  if (state.stage !== row.sentStage) return { push: 'stage', stage: state.stage };
  return now - (row.lastPushAt ?? 0) >= REPUSH_MS ? { push: 'stage', stage: state.stage } : undefined;
}

export function createRideRules(ds: Dataset) {
  const trips = new Map(ds.trips.map((t) => [t.id, t])), patterns = new Map(ds.patterns.map((p) => [p.id, p]));
  const routes = new Map(ds.routes.map((r) => [r.id, r])), stops = new Map(ds.stops.map((s) => [s.id, s]));
  function departure(tripId: string, date: string, board: number): Departure | undefined {
    const trip = trips.get(tripId), pattern = trip && patterns.get(trip.patternId), route = pattern && routes.get(pattern.routeId);
    if (!trip || !pattern || !route || trip.times.length !== pattern.stopIds.length) return;
    return { tripInstanceId: tripInstanceId(trip.id, date), tripId, serviceDate: date, route, pattern, stopIndex: board,
      departs: tripTimeAt(ds, trip, date, board), estimated: trip.estimated?.includes(board) ?? false, arrivesEnd: tripTimeAt(ds, trip, date, trip.times.length - 1) };
  }
  /** Request checks: a trip active today (or yesterday's late service), stops on it in order, a valid vehicle. */
  function validRide(body: Record<string, unknown>, now: number) {
    const { trip, date, vehicle, board, alight, lang } = body;
    if (typeof trip !== 'string' || typeof date !== 'string' || !validServiceDate(date) || !validVehicleId(vehicle)) return;
    const today = localYmd(now, ds.meta.timezone), t = trips.get(trip), pattern = t && patterns.get(t.patternId);
    if (!t || !pattern || (date !== today && date !== addDays(today, -1)) || !isServiceActive(ds.calendars[t.serviceId], date)) return;
    if (!Number.isInteger(board) || !Number.isInteger(alight) || (board as number) < 0 || (alight as number) <= (board as number) || (alight as number) >= pattern.stopIds.length) return;
    if (lang !== 'en' && lang !== 'es') return;
    return { trip, date, vehicle, board: board as number, alight: alight as number, lang: lang as Lang };
  }
  /** The ride's lock and history, as the phone would hold them: locked to exactly this trip instance and vehicle. */
  function session(row: Pick<RideRow, 'id' | 'trip' | 'date' | 'vehicle' | 'board' | 'createdAt' | 'session'>): BusSession | undefined {
    const dep = departure(row.trip, row.date, row.board);
    if (!dep) return;
    const base = createBusSession(dep, row.createdAt, row.id);
    const fresh: BusSession = { ...base, phase: 'onboard', lock: { ...base.lock, vehicleId: row.vehicle } };
    if (!row.session) return fresh;
    try {
      const saved = JSON.parse(row.session) as SavedSession;
      // Only this ride's own lock: the server never confirms a different bus or trip.
      if (saved.lock?.tripInstanceId !== dep.tripInstanceId || saved.lock.vehicleId !== row.vehicle || !Array.isArray(saved.history)) return fresh;
      return { ...fresh, lock: saved.lock, history: saved.history, ...(saved.stopChanges ? { stopChanges: saved.stopChanges } : {}),
        ...(saved.pendingPosition ? { pendingPosition: saved.pendingPosition } : {}), ...(saved.feed ? { officialFeed: { state: saved.feed, checkedAt: row.createdAt } } : {}) };
    } catch { return fresh; }
  }
  /** Stored form: positions older than the guide ever uses are dropped; check times are not stored, so an unchanged check writes nothing. */
  function saveSession(s: BusSession, now: number): string {
    const saved: SavedSession = { lock: s.lock, history: s.history.filter((h) => now - h.observedAt <= DEFAULT_TIMING.staleAfterMs),
      ...(s.stopChanges ? { stopChanges: s.stopChanges } : {}), ...(s.pendingPosition ? { pendingPosition: s.pendingPosition } : {}), ...(s.officialFeed ? { feed: s.officialFeed.state } : {}) };
    return JSON.stringify(saved);
  }
  /** The same snapshot-to-lock steps the app takes for each /v1/live answer (src/ui/useLiveBus.ts). */
  function apply(s: BusSession, snapshot: LiveBusSnapshot, now: number): BusSession {
    const instance = s.departure.tripInstanceId;
    const fresh = snapshot.vehicles.state === 'ok' && now - snapshot.receivedAt <= LIVE_MAX_AGE_MS;
    const points = fresh ? snapshot.observations.filter((p) => now - p.observedAt <= LIVE_MAX_AGE_MS && p.observedAt <= now) : [];
    const exact = points.filter((p) => p.tripInstanceId === instance);
    const unique = new Set(exact.map((p) => p.vehicleId)).size <= 1;
    const state = !unique ? 'ambiguous' : exact.length ? 'ok' : 'missing';
    s = reduceBusSession(s, { type: 'feed_status', tripInstanceId: instance, state, now });
    if (unique) {
      const ordered = points.filter((p) => p.tripInstanceId === instance || p.vehicleId === s.lock.vehicleId).sort((a, b) => a.observedAt - b.observedAt);
      for (const obs of ordered) s = reduceBusSession(s, { type: 'observation', obs, source: 'official', receivedAt: now });
    }
    if (snapshot.updates.state === 'ok' && snapshot.updatedAt && snapshot.updatedAt <= now && now - snapshot.updatedAt <= LIVE_MAX_AGE_MS
      && now - snapshot.receivedAt <= LIVE_MAX_AGE_MS && snapshot.skippedStops.length) {
      s = reduceBusSession(s, { type: 'official_skips', tripInstanceId: instance, indices: snapshot.skippedStops, observedAt: snapshot.updatedAt, now });
    }
    if (snapshot.updates.state === 'ok' && snapshot.cancelledAt && snapshot.cancelledAt <= now && now - snapshot.cancelledAt <= LIVE_MAX_AGE_MS && now - snapshot.receivedAt <= LIVE_MAX_AGE_MS) {
      s = reduceBusSession(s, { type: 'official_cancellation', tripInstanceId: instance, now });
    }
    return s;
  }
  /** RideMode's rule: reported skipped stops pause the countdown; otherwise rideGuide from the locked bus. */
  function current(row: Pick<RideRow, 'serviceChange' | 'board' | 'alight'>, s: BusSession, now: number): RideNow {
    if (row.serviceChange || s.stopChanges?.indices.length) return { kind: 'service_change' };
    const guide = rideGuide(ds, s.departure.pattern.stopIds, row.board, row.alight, s.lock, now, s.history);
    return guide.basis === 'gps' ? { kind: 'stage', stage: guide.stage, stopsAway: guide.stopsAway, observedAt: guide.observedAt } : { kind: 'uncertain' };
  }
  /**
   * 30 minutes after the later of the scheduled and predicted arrival at the alighting stop. A prediction
   * observed over 2 minutes ago, or for a time over 30 minutes past, is no prediction; without one, a fresh
   * position of the locked bus on this trip keeps the ride until 30 minutes after it. Never past the 3-hour cap.
   */
  function expiry(row: Pick<RideRow, 'trip' | 'date' | 'board' | 'alight' | 'createdAt'>, s: BusSession, snapshot: LiveBusSnapshot, now: number): number {
    const trip = trips.get(row.trip)!;
    let until = (tripArrivalAt(ds, trip, row.date, row.alight) ?? tripTimeAt(ds, trip, row.date, row.alight)) + AFTER_ARRIVAL_MS;
    const predictions = snapshot.updates.state === 'ok' ? snapshot.predictions.filter((p) => p.stopIndex === row.alight
      && now - p.observedAt <= PREDICTION_FRESH_MS && p.observedAt <= now && now - p.at <= PREDICTION_PAST_MS) : [];
    const prediction = predictions.find((p) => p.kind === 'arrival') ?? predictions[0];
    if (prediction) until = Math.max(until, prediction.at + AFTER_ARRIVAL_MS);
    else if (s.lock.status === 'tracked' && s.lock.last && s.lock.last.tripInstanceId === s.departure.tripInstanceId && now - s.lock.last.observedAt <= LIVE_MAX_AGE_MS) {
      // Only while the ride's own guide places the bus short of the alighting stop: a bus reporting at or past
      // it, or one the guide cannot place, never keeps the ride open.
      const guide = rideGuide(ds, s.departure.pattern.stopIds, row.board, row.alight, s.lock, now, s.history);
      if (guide.basis === 'gps' && guide.stage !== 'arrived' && guide.stage !== 'passed' && guide.reachedIndex < row.alight) {
        until = Math.max(until, guide.observedAt + AFTER_ARRIVAL_MS);
      }
    }
    return Math.min(row.createdAt + RIDE_CAP_MS, until);
  }
  const stopName = (id: string | undefined) => (id && stops.get(id)?.name) || id || '';
  return { departure, validRide, session, saveSession, apply, current, expiry, stopName };
}

export interface RideHost {
  /** The /v1/live snapshot for this trip instance and locked vehicle, from the latest poll, built at `now`. */
  snapshot(trip: string, date: string, vehicle: string, now: number): LiveBusSnapshot;
  /** Re-arm (or, with nothing left to do, delete) the object's alarm. */
  arm(ridesChanged: boolean): Promise<void>;
}

/** The ride routes and the per-alarm check, inside the single BusFeed Durable Object. */
export class RideAlerts {
  readonly store: RideStore;
  private readonly rules;
  private readonly wrong = new WrongCodes();
  /** In memory only: when each ride's push was last accepted (a repeat of the same stage is not written) and last not accepted. */
  private readonly pushedAt = new Map<string, number>();
  private readonly failedAt = new Map<string, number>();
  /**
   * In memory only: each active ride's lock and position history as of its last check, so every position the
   * guide accepted counts until the ride ends, exactly as on the phone, even between the bounded writes. The
   * stored row is only the fallback after a restart. Dropped when the ride ends.
   */
  private readonly sessions = new Map<string, BusSession>();
  /** In memory only: when each ride was last checked, so a check cut short by the history run's deadline resumes with the rides it skipped. */
  private readonly checkedAt = new Map<string, number>();
  constructor(storage: RideStorage, ds: Dataset, private readonly host: RideHost, private readonly clock: () => number, private readonly fetchImpl: typeof fetch) {
    this.store = new RideStore(storage);
    this.rules = createRideRules(ds);
  }
  nextWake(pollDue: number) { return this.store.nextWake(pollDue); }
  /** The ride's session now: the one kept in memory since its last check, or the stored one after a restart. */
  private session(row: RideRow): BusSession | undefined {
    const kept = this.sessions.get(row.id);
    return kept && kept.lock.tripInstanceId === tripInstanceId(row.trip, row.date) && kept.lock.vehicleId === row.vehicle ? kept : this.rules.session(row);
  }
  private forget(id: string) { for (const map of [this.sessions, this.checkedAt, this.pushedAt, this.failedAt]) map.delete(id); }
  /** Drops the in-memory state (lock, stops, bus history, times) of every ride that is no longer active. */
  private forgetInactive(active = this.store.ids('active')) {
    for (const map of [this.sessions, this.checkedAt, this.pushedAt, this.failedAt]) for (const id of map.keys()) if (!active.includes(id)) map.delete(id);
  }
  /** Ends rides past their time (see RideStore.purge), and forgets in memory every ride that is not still active. */
  purge(now: number) { this.store.purge(now); this.forgetInactive(); }
  activeCount() { return this.store.count('active'); }

  async handle(request: Request, env: RideEnv): Promise<Response> {
    const url = new URL(request.url), now = this.clock();
    const vapid = await loadVapid(env.VAPID_PRIVATE_KEY), available = !!vapid && validCodeHash(env.HOUSEHOLD_CODE_HASH);
    if (url.pathname === '/v1/ride-alerts/config' && request.method === 'GET') return json(available ? { v: 1, available: true, publicKey: vapid!.publicKey } : { v: 1, available: false });
    if (!available) return json({ v: 1, available: false }, 503);
    this.purge(now);
    if (url.pathname === '/v1/ride-alerts' && request.method === 'POST') return this.create(request, env.HOUSEHOLD_CODE_HASH!, now);
    const match = RIDE_PATH.exec(url.pathname);
    if (!match) return json({ v: 1, error: 'unknown' }, 404);
    const [, id, action] = match as unknown as [string, string, string | undefined];
    const row = this.store.get(id);
    if (request.method === 'DELETE' && !action) {
      if (row && row.state !== 'ended') {
        this.store.end(id, url.searchParams.get('reason') === 'got_off' ? 'got_off' : 'unlocked', now);
        this.forget(id);
        await this.host.arm(true);
      }
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }
    if (!row) return json({ v: 1, error: 'unknown' }, 404);
    if (row.state === 'ended') return json({ v: 1, kind: 'ended', reason: row.reason ?? 'expired' }, 410);
    if (action === 'latest' && request.method === 'GET') return this.latest(row, now);
    if (request.method !== 'POST') return json({ v: 1, error: 'method' }, 405);
    const body = await readBody(request);
    if (!body) return json({ v: 1, error: 'invalid' }, 400);
    if (action === 'activate') {
      this.store.activate(id);
      await this.host.arm(true);
      return json({ v: 1, state: 'active' });
    }
    if (action === 'ack') {
      if (!STAGES.includes(body.stage as RideStage)) return json({ v: 1, error: 'invalid' }, 400);
      this.store.ack(id, STAGE_RANK[body.stage as RideStage]);
      return json({ v: 1 });
    }
    if (action === 'notice-ack') { this.store.noticeAck(id); return json({ v: 1 }); }
    return json({ v: 1, error: 'unknown' }, 404);
  }

  private async create(request: Request, hash: string, now: number): Promise<Response> {
    const body = await readBody(request);
    if (!body || body.v !== 1) return json({ v: 1, error: 'invalid' }, 400);
    const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (!await codeMatches(body.code, hash)) {
      if (this.wrong.locked(address, now)) return json({ v: 1, error: 'later' }, 429);
      this.wrong.record(address, now);
      return json({ v: 1, error: 'code' }, 401);
    }
    const ride = this.rules.validRide(body, now);
    if (!ride || !allowedEndpoint(body.endpoint)) return json({ v: 1, error: 'invalid' }, 400);
    const id = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const draft = { id, ...ride, createdAt: now, session: null };
    const fresh = this.rules.session(draft);
    if (!fresh) return json({ v: 1, error: 'invalid' }, 400);
    const snapshot = this.host.snapshot(ride.trip, ride.date, ride.vehicle, now);
    const s = this.rules.apply(fresh, snapshot, now);
    const expiresAt = Math.max(now + PENDING_MS, this.rules.expiry(draft, s, snapshot, now));
    if (!this.store.create({ ...draft, endpoint: body.endpoint, expiresAt, session: this.rules.saveSession(s, now) })) return json({ v: 1, error: 'full' }, 429);
    await this.host.arm(true);
    return json({ v: 1, id, expiresAt }, 201);
  }

  /** Recomputed at request time from the latest poll, never replayed. Nothing is written. */
  private latest(row: RideRow, now: number): Response {
    const snapshot = this.host.snapshot(row.trip, row.date, row.vehicle, now);
    const restored = this.session(row);
    const t = strings[row.lang].ride, title = t.notifyTitle;
    if (!restored) return json({ v: 1, kind: 'uncertain', title, body: t.lockedPush.cantCheck });
    const state = this.rules.current(row, this.rules.apply(restored, snapshot, now), now);
    if (state.kind === 'service_change') return json({ v: 1, kind: 'service_change', title, body: t.lockedPush.serviceChange });
    if (state.kind === 'uncertain') return json({ v: 1, kind: 'uncertain', title, body: t.lockedPush.cantCheck });
    if (state.stage === 'arrived' || state.stage === 'passed') return json({ v: 1, kind: 'ended', reason: state.stage }, 410);
    const stop = this.rules.stopName(this.rules.departure(row.trip, row.date, row.board)?.pattern.stopIds[row.alight]);
    return json({ v: 1, kind: 'stage', stage: state.stage, rank: STAGE_RANK[state.stage], stopsAway: state.stopsAway, observedAt: state.observedAt,
      receivedAt: snapshot.receivedAt, title, body: stageMessage(t, state.stage, state.stopsAway, stop) });
  }

  /**
   * One alarm's check of every active ride, after the poll. Send, then record: only a push the push service
   * accepted counts as sent. Writes are bounded (docs/LOCKED_STOP_ALERTS.md, "Writes per ride"): one statement
   * per check at most, and the lock and history only when the sent stage, notice, lock status, service-change flag
   * or expiry changed, otherwise at most every 2 minutes. A repeat of the same stage is not written.
   */
  async watch(env: RideEnv, deadline: number | null = null): Promise<void> {
    const vapid = await loadVapid(env.VAPID_PRIVATE_KEY), active = this.store.ids('active');
    this.forgetInactive(active);
    // Rides checked longest ago go first, so a check stopped at the deadline resumes where it left off. Each ride
    // is still checked (and pushed) one at a time, in alarm order, so its own stages stay in order.
    const ids = [...active].sort((a, b) => (this.checkedAt.get(a) ?? 0) - (this.checkedAt.get(b) ?? 0));
    for (const [index, id] of ids.entries()) {
      // Pushes never hold up the history run: once it is due, the remaining rides wait for the next alarm.
      if (index > 0 && deadline !== null && this.clock() >= deadline) break;
      const row = this.store.get(id), now = this.clock();
      if (!row || row.state !== 'active') continue;
      this.checkedAt.set(id, now);
      const restored = this.session(row);
      if (!restored) { this.store.end(id, 'expired', now); this.forget(id); continue; }
      const snapshot = this.host.snapshot(row.trip, row.date, row.vehicle, now);
      const s = this.rules.apply(restored, snapshot, now);
      this.sessions.set(id, s);
      const serviceChange = row.serviceChange || !!s.stopChanges?.indices.length;
      // Expiry only moves later, so one gap in the feed cannot end a late bus's ride early; the 3-hour cap still holds.
      const expiresAt = Math.min(row.createdAt + RIDE_CAP_MS, Math.max(row.expiresAt, this.rules.expiry(row, s, snapshot, now)));
      if (expiresAt <= now) { this.store.end(id, 'expired', now); this.forget(id); continue; }
      const lastPushAt = Math.max(row.lastPushAt ?? 0, this.pushedAt.get(id) ?? 0) || null;
      const action = decideRide({ ...row, lastPushAt, failAt: this.failedAt.get(id) ?? null }, now, this.rules.current({ ...row, serviceChange }, s, now));
      if (action && 'end' in action) { this.store.end(id, action.end, now); this.forget(id); continue; }
      const patch: RidePatch = {};
      if (action && vapid) {
        const result = await sendPush(vapid, row.endpoint, id, now, this.fetchImpl), at = this.clock();
        // 404/410: the phone dropped this subscription (unlocked, got off or turned the setting off).
        if (result === 'gone') { this.store.end(id, 'unlocked', at); this.forget(id); continue; }
        if (result === 'ok') {
          // Accepted, not shown: the stage is recorded as sent; only the phone's ack marks it shown.
          this.failedAt.delete(id); this.pushedAt.set(id, at);
          if (row.failures) patch.failures = 0;
          if (action.push === 'notice') patch.noticeAt = at;
          else if (action.stage !== row.sentStage) { patch.sentStage = action.stage; patch.lastPushAt = at; }
        } else {
          // Not accepted: nothing is recorded as sent, so it stays due for the next check.
          this.failedAt.set(id, at);
          if (result === 'failed') {
            if (row.failures + 1 >= MAX_PUSH_FAILURES) { this.store.end(id, 'push_failed', at); this.forget(id); continue; }
            patch.failures = row.failures + 1;
          }
        }
      }
      const material = Object.keys(patch).length > 0 || serviceChange !== row.serviceChange || restored.lock.status !== s.lock.status
        || expiresAt - row.expiresAt >= SAVE_MS || (expiresAt !== row.expiresAt && row.expiresAt - now <= SAVE_MS);
      if (material || row.savedAt === null || now - row.savedAt >= SAVE_MS) {
        Object.assign(patch, { session: this.rules.saveSession(s, now), serviceChange, expiresAt, savedAt: now });
      }
      this.store.update(id, patch);
    }
  }
}

async function readBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return;
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return; }
}
