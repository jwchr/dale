// Bus Lock keeps three kinds of evidence separate: the published trip, actual vehicle
// observations, and a rider's explicit reports. A timer or phone location never creates a report.
import { validDestinationArrival, type DestinationArrival } from './destinationArrival';
import { createLock, reduceLock, type TripLock, type VehicleObservation } from './lock';
import type { Departure, TripInstanceId } from './types';

export type RiderPhase = 'viewing' | 'waiting' | 'arrived' | 'onboard' | 'left' | 'ended';
export type RiderReportKind = 'no_bus' | 'arrived' | 'boarded' | 'left' | 'passed_without_stopping' | 'capacity';
/** A rider's own look at how full the bus was (issue #33). Not an official occupancy reading. */
export type CapacityLevel = 'seats' | 'standing' | 'full';
export type PositionSource = 'official' | 'demo';

export interface PositionRecord extends VehicleObservation {
  source: PositionSource;
  /** Receipt time is deliberately separate from the vehicle's observedAt timestamp. */
  receivedAt: number;
}

export interface RiderReport {
  /** An ephemeral observation-session identifier, not a person or device identifier. */
  sessionId: string;
  tripInstanceId: TripInstanceId;
  stopId: string;
  stopIndex: number;
  kind: RiderReportKind;
  /** Updated only by a rider action, never by polling or a foreground heartbeat. */
  reportedAt: number;
  /** The rider's wait began here. Required for no_bus; late check-ins do not cover earlier time. */
  waitingSince?: number;
  /** Only on a capacity report: what this rider saw. */
  capacity?: CapacityLevel;
}

export interface BusSession {
  id: string;
  /** The originally selected departure stays fixed, including date, direction and boarding stop. */
  departure: Departure;
  lock: TripLock;
  phase: RiderPhase;
  waitingSince?: number;
  /** Last explicit rider action; ticks and fetched GPS do not imply an active observer. */
  lastActionAt: number;
  reports: RiderReport[];
  /** Actual accepted GPS observations only. Unreported intervals remain gaps. */
  history: PositionRecord[];
  lastReceivedAt?: number;
  /** A checked feed gap is separate from the age of the last actual vehicle report. */
  /** Known skipped stops remain a warning for this trip until it ends; never assume a detour was undone. */
  stopChanges?: { indices: number[]; observedAt: number };
  officialFeed?: { state: 'ok' | 'missing' | 'ambiguous'; checkedAt: number };
  /** Source and receipt time for the pending identity change, which is not accepted history. */
  pendingPosition?: PositionRecord;
  /** First supported destination event, retained through ride completion. */
  destinationArrival?: DestinationArrival;
}

/** A bounded in-memory history, not an archive or a promise of pre-lock coverage. */
export const MAX_POSITION_HISTORY = 120;
/** A provisional report lifetime, to be calibrated on real rides; not an operational guarantee. */
export const REPORT_TTL_MS = 10 * 60_000;

export function createBusSession(dep: Departure, now: number, sessionId?: string): BusSession {
  return {
    // A caller creating shared sessions must supply a server-validated random identifier.
    // The deterministic fallback is sufficient for this device-local, pure domain layer.
    id: sessionId ?? `${dep.tripInstanceId}/${dep.stopIndex}/${now}`,
    departure: { ...dep, route: { ...dep.route }, pattern: { ...dep.pattern, stopIds: [...dep.pattern.stopIds] } },
    lock: createLock(dep.tripInstanceId, now),
    phase: 'viewing',
    lastActionAt: now,
    reports: [],
    history: [],
  };
}

export type BusSessionEvent =
  | { type: 'destination_arrival'; arrival: DestinationArrival; now: number }
  | { type: 'start_waiting' | Exclude<RiderReportKind, 'capacity'> | 'end' | 'tick' | 'confirm_pending' | 'reject_pending'; now: number }
  | { type: 'capacity'; level: CapacityLevel; now: number }
  | { type: 'observation'; obs: VehicleObservation; source: PositionSource; receivedAt: number }
  | { type: 'official_skips'; tripInstanceId: TripInstanceId; indices: number[]; observedAt: number; now: number }
  | { type: 'feed_status'; tripInstanceId: TripInstanceId; state: 'ok' | 'missing' | 'ambiguous'; now: number }
  | { type: 'official_cancellation'; tripInstanceId: TripInstanceId; now: number };

const finiteTime = (n: number): boolean => Number.isFinite(n) && n >= 0;
const isClosed = (s: BusSession): boolean => s.phase === 'left' || s.phase === 'ended';

function validObservation(o: VehicleObservation, receivedAt: number): boolean {
  return typeof o.tripInstanceId === 'string' && o.tripInstanceId.trim().length > 0
    && typeof o.vehicleId === 'string' && o.vehicleId.trim().length > 0
    && finiteTime(receivedAt) && finiteTime(o.observedAt) && o.observedAt > 0 && o.observedAt <= receivedAt
    && Number.isFinite(o.lat) && o.lat >= -90 && o.lat <= 90
    && Number.isFinite(o.lon) && o.lon >= -180 && o.lon <= 180;
}

function historyWith(history: PositionRecord[], record: PositionRecord): PositionRecord[] {
  if (history.some((p) => p.vehicleId === record.vehicleId && p.tripInstanceId === record.tripInstanceId && p.observedAt === record.observedAt)) return history;
  return [...history, record].sort((a, b) => a.observedAt - b.observedAt).slice(-MAX_POSITION_HISTORY);
}

function riderReport(s: BusSession, kind: RiderReportKind, now: number, phase: RiderPhase = s.phase, capacity?: CapacityLevel): BusSession {
  const stopId = s.departure.pattern.stopIds[s.departure.stopIndex];
  if (!stopId) return s;
  const report: RiderReport = {
    sessionId: s.id,
    tripInstanceId: s.departure.tripInstanceId,
    stopId,
    stopIndex: s.departure.stopIndex,
    kind,
    reportedAt: now,
    // A crowding answer does not need to say when this rider started waiting.
    ...(s.waitingSince === undefined || kind === 'capacity' ? {} : { waitingSince: s.waitingSince }),
    ...(capacity === undefined ? {} : { capacity }),
  };
  // Repeated "still no bus" taps refresh one observation, never create extra votes.
  const reports = s.reports.filter((r) => !(r.sessionId === report.sessionId && r.stopId === report.stopId && r.kind === report.kind));
  return { ...s, phase, lastActionAt: now, reports: [...reports, report] };
}

export function reduceBusSession(session: BusSession, event: BusSessionEvent): BusSession {
  if (isClosed(session)) return session;
  const now = event.type === 'observation' ? event.receivedAt : event.now;
  if (!finiteTime(now) || now < session.lock.lockedAt) return session;

  switch (event.type) {
    case 'destination_arrival': {
      const a = event.arrival, dep = session.departure;
      return !session.destinationArrival && validDestinationArrival(a) && a.tripInstanceId === dep.tripInstanceId
        && a.stopIndex > dep.stopIndex && dep.pattern.stopIds[a.stopIndex] === a.stopId && !dep.pattern.noDropOff?.includes(a.stopIndex)
        && a.recordedAt === now && a.at >= session.lock.lockedAt && a.at <= now && session.lock.status !== 'needs_confirmation'
        && session.lock.status !== 'cancelled' && (a.source !== 'rider' || session.phase === 'onboard')
        ? { ...session, destinationArrival: { ...a } } : session;
    }
    case 'observation': {
      if (!validObservation(event.obs, now) || (event.source !== 'official' && event.source !== 'demo')) return session;
      if (session.lastReceivedAt !== undefined && now < session.lastReceivedAt) return session;
      const o: VehicleObservation = {
        tripInstanceId: event.obs.tripInstanceId, vehicleId: event.obs.vehicleId,
        observedAt: event.obs.observedAt, lat: event.obs.lat, lon: event.obs.lon,
        ...(event.obs.stopCall ? { stopCall: { ...event.obs.stopCall } } : {}),
      };
      if (o.tripInstanceId !== session.departure.tripInstanceId && o.vehicleId !== session.lock.vehicleId) return session;
      // An old vehicle reassignment must not displace a more recent pending match or observation.
      if (o.tripInstanceId === session.departure.tripInstanceId && o.vehicleId !== session.lock.vehicleId
        && session.lock.last && o.observedAt <= session.lock.last.observedAt) return session;
      const conflicts = (o.tripInstanceId === session.departure.tripInstanceId && o.vehicleId !== session.lock.vehicleId)
        || (o.tripInstanceId !== session.departure.tripInstanceId && o.vehicleId === session.lock.vehicleId);
      if (conflicts && session.pendingPosition && o.observedAt <= session.pendingPosition.observedAt) return session;

      const record: PositionRecord = { ...o, source: event.source, receivedAt: now };
      // Age the observation immediately. Fetching a ten-minute-old position now does not make it live.
      let lock = reduceLock(session.lock, { type: 'observation', obs: o });
      lock = reduceLock(lock, { type: 'tick', now });
      if (session.officialFeed && session.officialFeed.state !== 'ok' && lock.last && lock.status === 'tracked') lock = { ...lock, status: 'stale' };
      const accepted = lock.last === o;
      const pending = lock.pending === o;
      return {
        ...session, lock, lastReceivedAt: now,
        history: accepted ? historyWith(session.history, record) : session.history,
        pendingPosition: pending ? record : session.pendingPosition,
      };
    }
    case 'official_skips': {
      if (event.tripInstanceId !== session.departure.tripInstanceId || !finiteTime(event.observedAt) || event.observedAt > now) return session;
      const indices = event.indices.filter((i) => Number.isInteger(i) && i >= 0 && i < session.departure.pattern.stopIds.length);
      if (!indices.length) return session;
      return { ...session, stopChanges: { indices: [...new Set([...(session.stopChanges?.indices ?? []), ...indices])], observedAt: Math.max(session.stopChanges?.observedAt ?? 0, event.observedAt) } };
    }
    case 'feed_status': {
      if (event.tripInstanceId !== session.departure.tripInstanceId) return session;
      const next = { ...session, officialFeed: { state: event.state, checkedAt: now } };
      const lock = reduceLock(session.lock, { type: 'tick', now });
      next.lock = next.officialFeed.state !== 'ok' && lock.last && lock.status === 'tracked' ? { ...lock, status: 'stale' } : lock;
      return next;
    }
    case 'tick': {
      let lock = reduceLock(session.lock, { type: 'tick', now });
      if (session.officialFeed && session.officialFeed.state !== 'ok' && lock.last && lock.status === 'tracked') lock = { ...lock, status: 'stale' };
      return lock === session.lock ? session : { ...session, lock };
    }
    case 'official_cancellation': {
      const lock = reduceLock(session.lock, event);
      return lock === session.lock ? session : { ...session, lock: { ...lock, pending: undefined }, pendingPosition: undefined };
    }
    case 'confirm_pending': {
      const pending = session.lock.pending;
      // A replacement vehicle may be accepted on this trip. A different trip/date must be
      // selected explicitly as a NEW departure so its schedule and boarding stop cannot drift.
      if (session.lock.status !== 'needs_confirmation' || !pending || pending.tripInstanceId !== session.departure.tripInstanceId) return session;
      let lock = reduceLock(session.lock, { type: 'confirm_pending' });
      lock = reduceLock(lock, { type: 'tick', now });
      if (session.officialFeed && session.officialFeed.state !== 'ok' && lock.last && lock.status === 'tracked') lock = { ...lock, status: 'stale' };
      const record = session.pendingPosition;
      return {
        ...session, lock, pendingPosition: undefined,
        history: record && lock.last === pending ? historyWith(session.history, record) : session.history,
      };
    }
    case 'reject_pending': {
      let lock = reduceLock(session.lock, { type: 'reject_pending' });
      lock = reduceLock(lock, { type: 'tick', now });
      if (session.officialFeed && session.officialFeed.state !== 'ok' && lock.last && lock.status === 'tracked') lock = { ...lock, status: 'stale' };
      return { ...session, lock, pendingPosition: undefined };
    }
    case 'start_waiting':
      return session.phase === 'viewing' && now >= session.lastActionAt
        ? { ...session, phase: 'waiting', waitingSince: now, lastActionAt: now } : session;
    case 'no_bus':
      return session.phase === 'waiting' && session.waitingSince !== undefined
        && !session.reports.some((r) => r.kind === 'passed_without_stopping')
        && now >= session.departure.departs && now >= session.lastActionAt
        ? riderReport(session, 'no_bus', now) : session;
    case 'passed_without_stopping':
      return session.phase === 'waiting' && now >= session.lastActionAt
        ? riderReport(session, event.type, now) : session;
    case 'arrived':
      return session.phase === 'waiting' && now >= session.lastActionAt
        ? riderReport(session, 'arrived', now, 'arrived') : session;
    case 'capacity': {
      // Only someone who saw the bus can say how full it was: after it arrived, on board, or as it passed by.
      const sawIt = session.phase === 'arrived' || session.phase === 'onboard'
        || (session.phase === 'waiting' && session.reports.some((r) => r.kind === 'passed_without_stopping'));
      return sawIt && ['seats', 'standing', 'full'].includes(event.level) && now >= session.lastActionAt
        ? riderReport(session, 'capacity', now, session.phase, event.level) : session;
    }
    case 'boarded':
      return (session.phase === 'waiting' || session.phase === 'arrived') && now >= session.lastActionAt
        ? riderReport(session, 'boarded', now, 'onboard') : session;
    case 'left': {
      if ((session.phase !== 'waiting' && session.phase !== 'arrived') || now < session.lastActionAt) return session;
      const s = riderReport(session, 'left', now, 'left');
      return { ...s, lock: reduceLock(s.lock, { type: 'end' }) };
    }
    case 'end':
      return now >= session.lastActionAt
        ? { ...session, phase: 'ended', lastActionAt: now, lock: reduceLock(session.lock, { type: 'end' }) } : session;
  }
}

export interface ScheduleProjection {
  /** This is timetable progress, never an observed geographic location or arrival confirmation. */
  estimated: true;
  basis: 'schedule';
  computedAt: number;
  kind: 'before_start' | 'between' | 'after_end' | 'overdue_unknown' | 'unavailable';
  fromIndex?: number;
  toIndex?: number;
  fraction?: number;
  reason?: 'invalid_schedule' | 'identity_conflict' | 'cancelled' | 'session_ended';
}

export function getScheduleProjection(session: BusSession, stopTimes: readonly { stopId: string; at: number }[], now: number): ScheduleProjection {
  const base = { estimated: true as const, basis: 'schedule' as const, computedAt: now };
  if (isClosed(session)) return { ...base, kind: 'unavailable', reason: 'session_ended' };
  if (session.lock.status === 'cancelled') return { ...base, kind: 'unavailable', reason: 'cancelled' };
  if (session.lock.status === 'needs_confirmation') return { ...base, kind: 'unavailable', reason: 'identity_conflict' };
  const valid = finiteTime(now) && stopTimes.length > 1
    && stopTimes.length === session.departure.pattern.stopIds.length
    && stopTimes.every((t, i) => finiteTime(t.at) && t.stopId === session.departure.pattern.stopIds[i]
      && (i === 0 || t.at >= stopTimes[i - 1]!.at));
  if (!valid) return { ...base, kind: 'unavailable', reason: 'invalid_schedule' };
  // The rider still waiting after their scheduled time does not see an invented bus travel
  // past them. A no-bus report supplies no position from which to extrapolate a fresh ETA.
  if (session.phase === 'waiting' && now >= session.departure.departs) return { ...base, kind: 'overdue_unknown' };
  const first = stopTimes[0]!;
  const last = stopTimes[stopTimes.length - 1]!;
  if (now < first.at) return { ...base, kind: 'before_start', fromIndex: 0, toIndex: 0, fraction: 0 };
  if (now >= last.at) return { ...base, kind: 'after_end', fromIndex: stopTimes.length - 1, toIndex: stopTimes.length - 1, fraction: 1 };
  // Find the next strictly later time; equal-time stops are valid and never divide by zero.
  const toIndex = stopTimes.findIndex((t) => t.at > now);
  const fromIndex = Math.max(0, toIndex - 1);
  const from = stopTimes[fromIndex]!;
  const to = stopTimes[toIndex]!;
  return { ...base, kind: 'between', fromIndex, toIndex, fraction: (now - from.at) / (to.at - from.at) };
}

/**
 * Select only fresh, unresolved upstream warnings for this exact trip instance. It does not
 * infer cancellation, confidence percentages, crowd size or an ongoing observer from a report.
 * A Worker must validate input/session identity and enforce expiry server-side before sharing.
 */
export function activeDownstreamReports(reports: readonly RiderReport[], tripInstanceId: TripInstanceId, targetStopIndex: number, now: number, ttlMs = REPORT_TTL_MS): RiderReport[] {
  if (!finiteTime(now) || !Number.isInteger(targetStopIndex) || targetStopIndex < 0 || !Number.isFinite(ttlMs) || ttlMs <= 0) return [];
  const relevant = reports.filter((r) => r.tripInstanceId === tripInstanceId
    && typeof r.sessionId === 'string' && r.sessionId.length > 0 && typeof r.stopId === 'string' && r.stopId.length > 0
    && Number.isInteger(r.stopIndex) && r.stopIndex >= 0 && r.stopIndex < targetStopIndex
    && finiteTime(r.reportedAt) && r.reportedAt <= now && now - r.reportedAt < ttlMs
    && (r.kind !== 'no_bus' || (r.waitingSince !== undefined && finiteTime(r.waitingSince) && r.waitingSince <= r.reportedAt)));

  const candidates = relevant.filter((r) => r.kind === 'no_bus' || r.kind === 'passed_without_stopping');
  const latest = new Map<string, RiderReport>();
  for (const report of candidates) {
    // A pass-up is an explicit sighting. This observer cannot subsequently claim this
    // same departure has never been seen; keep the pass-up instead of changing its meaning.
    if (report.kind === 'no_bus' && relevant.some((other) => other.sessionId === report.sessionId
      && other.kind === 'passed_without_stopping')) continue;
    if (report.kind === 'no_bus' && relevant.some((other) => other.stopId === report.stopId && other.stopIndex === report.stopIndex
      && (other.kind === 'arrived' || other.kind === 'boarded' || other.kind === 'passed_without_stopping') && other.reportedAt >= report.reportedAt)) continue;
    // The most recent check-in for a session is one report, regardless of repeated taps.
    const key = report.sessionId;
    const prev = latest.get(key);
    if (!prev || report.reportedAt > prev.reportedAt || (report.reportedAt === prev.reportedAt && report.kind === 'passed_without_stopping')) latest.set(key, report);
  }
  return [...latest.values()].sort((a, b) => b.reportedAt - a.reportedAt);
}
