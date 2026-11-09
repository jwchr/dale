import type { VehicleObservation } from './lock';
import { isServiceActive } from './schedule';
import { LIVE_MAX_AGE_MS, LIVE_SOURCE, parseLiveSnapshot, validServiceDate, type LiveFeed, type LivePrediction } from './liveBus';
import type { Dataset, Departure } from './types';
export const MAX_DEPARTURE_QUERIES = 50;
export interface DepartureRequest { tripId: string; serviceDate: string; stopIndex: number; toStopIndex: number }
export interface DepartureReport {
  query: DepartureRequest; updatedAt?: number; cancelledAt?: number;
  departure?: LivePrediction; boardingArrival?: LivePrediction; arrival?: LivePrediction; gpsObservedAt?: number; gps?: VehicleObservation; gpsProblem?: 'ambiguous';
  boardingSkipped?: boolean; destinationSkipped?: boolean; problem?: 'ambiguous' | 'date-unknown';
}
export interface DepartureBatch { v: 1; source: typeof LIVE_SOURCE; feedVersion: string; receivedAt: number; vehicles: LiveFeed; updates: LiveFeed; items: DepartureReport[] }
export const departureKey = (q: DepartureRequest) => JSON.stringify([q.tripId, q.serviceDate, q.stopIndex, q.toStopIndex]);
export const requestFor = (d: Departure, toStopId: string): DepartureRequest => ({ tripId: d.tripId, serviceDate: d.serviceDate, stopIndex: d.stopIndex, toStopIndex: d.pattern.stopIds.indexOf(toStopId) });
/** Reject malformed/oversized selectors before any upstream work. */
export function readDepartureRequests(ds: Dataset, raw: string | null): DepartureRequest[] {
  if (!raw || raw.length > 16_000) throw new Error('Invalid departure request');
  const values: unknown = JSON.parse(raw), trips = new Map(ds.trips.map(t => [t.id, t])), patterns = new Map(ds.patterns.map(p => [p.id, p]));
  if (!Array.isArray(values) || !values.length || values.length > MAX_DEPARTURE_QUERIES) throw new Error('Invalid departure request');
  const seen = new Set<string>();
  return values.map(q => {
    if (!q || typeof q !== 'object' || typeof q.tripId !== 'string' || typeof q.serviceDate !== 'string' || !validServiceDate(q.serviceDate)) throw new Error('Invalid departure request');
    const trip = trips.get(q.tripId), pattern = trip && patterns.get(trip.patternId);
    if (!trip || !pattern || !isServiceActive(ds.calendars[trip.serviceId], q.serviceDate)
      || !Number.isInteger(q.stopIndex) || !Number.isInteger(q.toStopIndex) || q.stopIndex < 0 || q.toStopIndex <= q.stopIndex
      || q.toStopIndex >= pattern.stopIds.length || pattern.noPickup?.includes(q.stopIndex) || pattern.noDropOff?.includes(q.toStopIndex)) throw new Error('Invalid departure request');
    const query = { tripId: q.tripId, serviceDate: q.serviceDate, stopIndex: q.stopIndex, toStopIndex: q.toStopIndex };
    const key = departureKey(query); if (seen.has(key)) throw new Error('Duplicate departure request'); seen.add(key); return query;
  });
}
/** Reuse the exact-trip protocol validator; never treat arbitrary server text as a live estimate. */
export function parseDepartureBatch(raw: unknown, ds: Dataset, queries: DepartureRequest[], now: number): DepartureBatch {
  const fail = (): never => { throw new Error('Invalid arrival response'); };
  if (!raw || typeof raw !== 'object') return fail();
  const batch = raw as DepartureBatch;
  if (!Array.isArray(batch.items) || batch.items.length !== queries.length || batch.items.length > MAX_DEPARTURE_QUERIES) return fail();
  const expected = new Map(queries.map(q => [departureKey(q), q])), seen = new Set<string>();
  const time = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && Number.isFinite(new Date(n).getTime()) && n <= batch.receivedAt;
  for (const item of batch.items) {
    if (!item || !item.query) return fail();
    const key = departureKey(item.query), q = expected.get(key); if (!q || seen.has(key)) return fail(); seen.add(key);
    if (item.gpsProblem !== undefined && item.gpsProblem !== 'ambiguous') return fail();
    if (item.problem !== undefined && !['ambiguous', 'date-unknown'].includes(item.problem)) return fail();
    if ((item.boardingSkipped !== undefined && typeof item.boardingSkipped !== 'boolean') || (item.destinationSkipped !== undefined && typeof item.destinationSkipped !== 'boolean')
      || (item.gpsObservedAt !== undefined && !time(item.gpsObservedAt))) return fail();
    if ([item.departure, item.boardingArrival, item.arrival].some(p => p && p.observedAt !== item.updatedAt)
      || (item.cancelledAt !== undefined && item.cancelledAt !== item.updatedAt)
      || ((item.boardingSkipped || item.destinationSkipped) && !time(item.updatedAt))) return fail();
    if (item.gps && (item.gps.tripInstanceId !== q.tripId + '@' + q.serviceDate || item.gps.observedAt !== item.gpsObservedAt || item.problem || item.gpsProblem)) return fail();
    if (item.departure && (item.departure.stopIndex !== q.stopIndex || item.departure.kind !== 'departure')) return fail();
    if (item.boardingArrival) {
      const trip = ds.trips.find(t => t.id === q.tripId)!, pattern = ds.patterns.find(p => p.id === trip.patternId)!;
      if (item.boardingArrival.stopIndex !== q.stopIndex || item.boardingArrival.kind !== 'arrival' || ds.stops.find(s => s.id === pattern.stopIds[q.stopIndex])?.terminal === 'PABT') return fail();
    }
    if (item.arrival && (item.arrival.stopIndex !== q.toStopIndex || item.arrival.kind !== 'arrival')) return fail();
    parseLiveSnapshot({ ...batch, tripInstanceId: q.tripId + '@' + q.serviceDate, observations: item.gps ? [item.gps] : [], predictions: [item.departure, item.boardingArrival, item.arrival].filter(Boolean), skippedStops: [], updatedAt: item.updatedAt, cancelledAt: item.cancelledAt }, ds, q.tripId, q.serviceDate, now);
  }
  return batch;
}
export type DepartureEvidenceKind = 'live' | 'checking' | 'unavailable' | 'stale' | 'ambiguous' | 'date-unknown' | 'no-prediction' | 'passed' | 'cancelled' | 'boarding-skipped' | 'destination-skipped' | 'limited';
export interface DepartureEvidence { kind: DepartureEvidenceKind; boarding?: LivePrediction; arrival?: LivePrediction; gpsObservedAt?: number }
/** Freshness is evaluated at render time too, so a suspended/failed poll cannot prolong Live. */
export function departureEvidence(batch: DepartureBatch | undefined, item: DepartureReport | undefined, now: number): DepartureEvidence {
  if (!batch || batch.receivedAt > now + 30_000) return { kind: 'unavailable' };
  // The rendered app clock can precede this response by a tick; use the already-validated receipt
  // as a conservative lower bound for age, without changing any source timestamp.
  const checkedAt = Math.max(now, batch.receivedAt);
  const fresh = (at: number | undefined) => at !== undefined && at <= checkedAt && checkedAt - at <= LIVE_MAX_AGE_MS;
  if (!fresh(batch.receivedAt)) return { kind: 'stale' };
  if (!item) return { kind: 'limited' };
  const gpsObservedAt = batch.vehicles.state === 'ok' && fresh(batch.vehicles.timestamp) && fresh(item.gpsObservedAt) ? item.gpsObservedAt : undefined;
  if (item.problem === 'ambiguous') return { kind: 'ambiguous', gpsObservedAt };
  if (batch.updates.state !== 'ok') return { kind: batch.updates.state === 'stale' ? 'stale' : 'unavailable', gpsObservedAt };
  if (!fresh(batch.updates.timestamp)) return { kind: 'stale', gpsObservedAt };
  if (fresh(item.cancelledAt)) return { kind: 'cancelled', gpsObservedAt };
  if (fresh(item.updatedAt) && item.boardingSkipped) return { kind: 'boarding-skipped', gpsObservedAt };
  if (fresh(item.updatedAt) && item.destinationSkipped) return { kind: 'destination-skipped', gpsObservedAt };
  const prediction = (p: LivePrediction | undefined) => p && fresh(p.observedAt) && p.at >= checkedAt ? p : undefined;
  const boarding = prediction(item.departure) ?? prediction(item.boardingArrival), arrival = prediction(item.arrival);
  return { kind: boarding ? 'live' : item.problem === 'date-unknown' ? 'date-unknown' : item.departure && fresh(item.departure.observedAt) && item.departure.at < checkedAt ? 'passed' : 'no-prediction', boarding, arrival, gpsObservedAt };
}
