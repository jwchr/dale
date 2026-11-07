import { validDestinationArrival } from './destinationArrival';
// Bus Lock on this phone across a refresh or a closed app (issue #53). The saved lock keeps its
// original timestamps, so a report from 8:10 still reads 8:10 after reopening, and GPS ages honestly.
// A saved lock is only offered back (never resumed silently) and only while it still matches the
// loaded schedule, its trip, and its day. The invented demo is never saved.
import type { BusSession } from './busLock';
import type { Dataset, Departure } from './types';
import { tripTimeAt } from './schedule';

export const LOCK_KEY = 'arriba.lock.v1';
/** A lock is offered back until this long after its trip's scheduled end. */
export const RESUME_AFTER_END_MS = 2 * 3600_000;

export interface SavedLock<L> {
  v: 1;
  feedVersion: string;
  savedAt: number;
  dep: Departure;
  leg: L;
  session: BusSession;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;

export function saveLock<L>(store: Store, ds: Dataset, lock: { dep: Departure; leg: L; session: BusSession } | undefined, now: number): void {
  try {
    // The invented demo neither reads nor writes the saved lock, so opening it never touches a real one.
    if (ds.meta.demo) return;
    if (!lock || lock.session.phase === 'left' || lock.session.phase === 'ended') { store?.removeItem(LOCK_KEY); return; }
    const saved: SavedLock<L> = { v: 1, feedVersion: ds.meta.feedVersion, savedAt: now, dep: lock.dep, leg: lock.leg, session: lock.session };
    store?.setItem(LOCK_KEY, JSON.stringify(saved));
  } catch { /* storage full or blocked: the lock simply is not kept */ }
}

/** The saved lock, if it is still valid for this dataset and time; otherwise undefined (and forgotten). */
export function loadLock<L>(store: Store, ds: Dataset, now: number): SavedLock<L> | undefined {
  if (ds.meta.demo) return undefined;
  try {
    const saved = JSON.parse(store?.getItem(LOCK_KEY) ?? 'null') as SavedLock<L> | null;
    if (saved && saved.v === 1 && saved.feedVersion === ds.meta.feedVersion && validFor(ds, saved, now)) return saved;
  } catch { /* Corrupt nested state must not prevent the app from opening. */ }
  forgetLock(store);
  return undefined;
}

export function forgetLock(store: Store): void {
  try { store?.removeItem(LOCK_KEY); } catch { /* nothing to forget */ }
}

function validFor<L>(ds: Dataset, s: SavedLock<L>, now: number): boolean {
  const dep = s.dep;
  const session = s.session;
  if (!dep || !session || typeof session.id !== 'string' || typeof dep.tripId !== 'string' || !Number.isFinite(dep.departs) || !Number.isFinite(dep.arrivesEnd)) return false;
  // The saved shape must be the one this version understands (bump `v` whenever BusSession changes).
  if (!Array.isArray(session.reports) || !Array.isArray(session.history) || !session.lock || !Number.isFinite(session.lastActionAt)) return false;
  if (session.stopChanges && (!Array.isArray(session.stopChanges.indices) || !session.stopChanges.indices.every((i) => Number.isInteger(i) && i >= 0 && i < dep.pattern.stopIds.length) || !Number.isFinite(session.stopChanges.observedAt))) return false;
  if (session.officialFeed && (!['ok', 'missing', 'ambiguous'].includes(session.officialFeed.state) || !Number.isFinite(session.officialFeed.checkedAt))) return false;
  const optionalTime = (n: unknown) => n === undefined || (typeof n === 'number' && Number.isFinite(n) && n >= 0);
  if (!optionalTime(session.waitingSince) || !optionalTime(session.lastReceivedAt)
    || (session.phase === 'waiting' && session.waitingSince === undefined)
    || !Number.isFinite(session.lock.lockedAt) || (session.lock.vehicleId !== undefined && typeof session.lock.vehicleId !== 'string')) return false;
  // Same trip, same pattern, same boarding stop as the schedule now loaded.
  if (!Array.isArray(dep.pattern?.stopIds) || !dep.pattern.stopIds.every((id) => typeof id === 'string')) return false;
  if (!Number.isInteger(dep.stopIndex) || !/^\d{8}$/.test(dep.serviceDate) || dep.tripInstanceId !== `${dep.tripId}@${dep.serviceDate}`) return false;
  if (!['viewing', 'waiting', 'arrived', 'onboard'].includes(session.phase) || session.lock.tripInstanceId !== dep.tripInstanceId) return false;
  if (!['scheduled_only', 'tracked', 'stale', 'vanished', 'needs_confirmation', 'cancelled'].includes(session.lock.status)) return false;
  const position = (p: NonNullable<BusSession['lock']['last']>) => p && typeof p.vehicleId === 'string' && typeof p.tripInstanceId === 'string'
    && (p.stopCall === undefined || (p.stopCall.status === 'stopped_at' && Number.isInteger(p.stopCall.stopIndex) && p.stopCall.stopIndex >= 0 && typeof p.stopCall.stopId === 'string'))
    && Number.isFinite(p.observedAt) && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180;
  if (session.lock.last && !position(session.lock.last) || session.lock.pending && !position(session.lock.pending)) return false;
  const record = (p: NonNullable<BusSession['pendingPosition']>) => position(p) && ['demo', 'official'].includes(p.source) && Number.isFinite(p.receivedAt);
  if (!session.history.every(record) || (session.pendingPosition !== undefined && !record(session.pendingPosition))) return false;
  if (!session.reports.every((r) => r && ['no_bus', 'arrived', 'boarded', 'left', 'passed_without_stopping', 'capacity'].includes(r.kind)
    && Number.isFinite(r.reportedAt) && optionalTime(r.waitingSince) && typeof r.sessionId === 'string'
    && Number.isInteger(r.stopIndex) && r.stopId === dep.pattern.stopIds[r.stopIndex] && r.tripInstanceId === dep.tripInstanceId
    && (r.kind !== 'capacity' || ['seats', 'standing', 'full'].includes(r.capacity ?? '')))) return false;
  const leg = s.leg as { fromStopId?: unknown; toStopId?: unknown; routeIds?: unknown } | null;
  if (session.destinationArrival && (!validDestinationArrival(session.destinationArrival) || session.destinationArrival.tripInstanceId !== dep.tripInstanceId || session.destinationArrival.stopId !== leg?.toStopId || dep.pattern.stopIds[session.destinationArrival.stopIndex] !== session.destinationArrival.stopId || session.destinationArrival.at < session.lock.lockedAt || session.destinationArrival.recordedAt > now)) return false;
  if (!leg || typeof leg.fromStopId !== 'string' || typeof leg.toStopId !== 'string' || !Array.isArray(leg.routeIds)
    || !leg.routeIds.every((id) => typeof id === 'string') || leg.fromStopId !== dep.pattern.stopIds[dep.stopIndex]) return false;
  const trip = ds.trips.find((t) => t.id === dep.tripId);
  const pattern = ds.patterns.find((p) => p.id === dep.pattern?.id);
  if (!trip || !pattern || trip.patternId !== pattern.id || pattern.stopIds.join() !== dep.pattern.stopIds.join()) return false;
  if (dep.route?.id !== pattern.routeId || typeof dep.route.shortName !== 'string' || typeof dep.pattern.headsign !== 'string') return false;
  if (dep.departs !== tripTimeAt(ds, trip, dep.serviceDate, dep.stopIndex) || dep.arrivesEnd !== tripTimeAt(ds, trip, dep.serviceDate, trip.times.length - 1)) return false;
  // Both saved copies must describe the same trip; use the checked copy on resume.
  if (JSON.stringify(session.departure) !== JSON.stringify(dep)) return false;
  if (pattern.stopIds[dep.stopIndex] === undefined || session.departure?.tripInstanceId !== dep.tripInstanceId) return false;
  if (session.phase === 'left' || session.phase === 'ended') return false;
  // Not before it was made (a clock set back), and not long after the trip's scheduled end.
  if (!(now >= session.lock.lockedAt) || !(now >= session.lastActionAt) || now > dep.arrivesEnd + RESUME_AFTER_END_MS) return false;
  return true;
}
