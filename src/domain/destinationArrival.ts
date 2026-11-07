// Destination evidence is separate from seeing the bus at the boarding stop or ending a ride.
import type { BusSession } from './busLock';
import type { Dataset } from './types';
import { tripArrivalAt } from './schedule';
import { distanceM } from './direction';
import { LIVE_MAX_AGE_MS, validServiceDate } from './liveBus';
export interface DestinationArrival {
  tripInstanceId: string; stopId: string; stopIndex: number; destination: string; route: string;
  source: 'njt_stopped_at' | 'rider'; at: number; recordedAt: number; scheduledAt?: number; vehicleId?: string;
}
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && Number.isFinite(new Date(v).getTime());
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 300 && !/[\u0000-\u001f\u007f]/.test(v);
export function validDestinationArrival(v: unknown): v is DestinationArrival {
  if (!v || typeof v !== 'object') return false;
  const a = v as DestinationArrival, date = typeof a.tripInstanceId === 'string' && a.tripInstanceId.split('@');
  return !!date && date.length === 2 && text(date[0]) && validServiceDate(date[1]!) && text(a.stopId) && text(a.destination) && text(a.route)
    && Number.isInteger(a.stopIndex) && a.stopIndex > 0 && a.stopIndex < 5000
    && ['njt_stopped_at', 'rider'].includes(a.source) && time(a.at) && time(a.recordedAt) && a.at <= a.recordedAt
    && (a.scheduledAt === undefined || time(a.scheduledAt)) && (a.vehicleId === undefined || text(a.vehicleId))
    && (a.source !== 'njt_stopped_at' || text(a.vehicleId));
}
function base(ds: Dataset, s: BusSession, index: number, now: number) {
  const dep = s.departure, stop = ds.stops.find(x => x.id === dep.pattern.stopIds[index]);
  const trip = ds.trips.find(t => t.id === dep.tripId);
  if (!stop || !trip || index <= dep.stopIndex || dep.pattern.noDropOff?.includes(index) || !time(now) || now < s.lastActionAt) return;
  const scheduledAt = tripArrivalAt(ds, trip, dep.serviceDate, index);
  return { tripInstanceId: dep.tripInstanceId, stopId: stop.id, stopIndex: index, destination: stop.name, route: dep.route.shortName,
    recordedAt: now, ...(scheduledAt === undefined ? {} : { scheduledAt }) };
}
export function reportedDestinationArrival(ds: Dataset, s: BusSession, index: number, now: number): DestinationArrival | undefined {
  if (s.destinationArrival || s.phase !== 'onboard' || ['needs_confirmation', 'cancelled', 'ended'].includes(s.lock.status)) return;
  const value = base(ds, s, index, now);
  return value && { ...value, source: 'rider', at: now, ...(s.lock.vehicleId ? { vehicleId: s.lock.vehicleId } : {}) };
}
/** First fresh official STOPPED_AT sample at the exact selected drop-off, not an exact arrival instant. */
export function observedDestinationArrival(ds: Dataset, s: BusSession, index: number, now: number): DestinationArrival | undefined {
  if (ds.meta.demo || s.destinationArrival || ['left', 'ended'].includes(s.phase) || s.lock.status !== 'tracked'
    || s.officialFeed?.state !== 'ok' || s.stopChanges?.indices.includes(index)) return;
  const value = base(ds, s, index, now), last = s.lock.last;
  const record = [...s.history].reverse().find(p => p.source === 'official' && p.tripInstanceId === s.departure.tripInstanceId
    && p.vehicleId === s.lock.vehicleId && p.observedAt === last?.observedAt);
  if (!value || !record || record.observedAt < s.lock.lockedAt || record.observedAt > now || now - record.observedAt > LIVE_MAX_AGE_MS
    || record.receivedAt > now || now - record.receivedAt > LIVE_MAX_AGE_MS || s.officialFeed.checkedAt > now || now - s.officialFeed.checkedAt > LIVE_MAX_AGE_MS
    || record.stopCall?.stopIndex !== index || record.stopCall.stopId !== value.stopId || record.stopCall.status !== 'stopped_at') return;
  const stop = ds.stops.find(x => x.id === value.stopId)!;
  // Port Authority intermediate staging is never the final terminal arrival.
  if (stop.terminal === 'PABT' && index !== s.departure.pattern.stopIds.length - 1) return;
  if (stop.lat === undefined || stop.lon === undefined || distanceM(record, { lat: stop.lat, lon: stop.lon }) > 60) return;
  return { ...value, source: 'njt_stopped_at', vehicleId: record.vehicleId, at: record.observedAt };
}
export const ARRIVAL_KEY = 'arriba.arrival.v1';
export const ARRIVAL_RETENTION_MS = 7 * 86400_000;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
export function readLastArrival(store: Store, now: number): DestinationArrival | undefined {
  try {
    const value: unknown = JSON.parse(store?.getItem(ARRIVAL_KEY) ?? 'null');
    if (validDestinationArrival(value) && value.recordedAt <= now && now - value.recordedAt <= ARRIVAL_RETENTION_MS) return value;
    if (!(value && typeof value === 'object' && time((value as { clearedAt?: unknown }).clearedAt))) store?.removeItem(ARRIVAL_KEY);
  } catch { /* Corrupt or blocked storage never prevents riding. */ }
}
export function saveLastArrival(store: Store, arrival: DestinationArrival | undefined, now = Date.now()): boolean {
  try {
    // Explicit scalar allowlist: no GPS history or additional packet fields are archived here.
    if (!arrival) { store?.setItem(ARRIVAL_KEY, JSON.stringify({ clearedAt: now })); return true; }
    if (!validDestinationArrival(arrival)) return false;
    let previous: { clearedAt?: unknown } | undefined;
    try { previous = JSON.parse(store?.getItem(ARRIVAL_KEY) ?? 'null'); } catch { /* A malformed old result is replaced. */ }
    if (previous && time(previous.clearedAt) && previous.clearedAt <= now && arrival.recordedAt <= previous.clearedAt) return false;
    const { tripInstanceId, stopId, stopIndex, destination, route, source, at, recordedAt, scheduledAt, vehicleId } = arrival;
    store?.setItem(ARRIVAL_KEY, JSON.stringify({ tripInstanceId, stopId, stopIndex, destination, route, source, at, recordedAt, scheduledAt, vehicleId }));
  } catch { /* Device-local convenience only. */ }
  return true;
}
