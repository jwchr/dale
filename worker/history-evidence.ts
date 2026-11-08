import type { Dataset } from '../src/domain/types';
import type { VehicleObservation } from '../src/domain/lock';
import { isServiceActive } from '../src/domain/schedule';
import { LIVE_MAX_AGE_MS, LIVE_SOURCE, validServiceDate, validVehicleId } from '../src/domain/liveBus';
import type { NormalizedFeed } from './normalize';

export interface HistoryWatermark { observedAt: number; fingerprint: string }
export interface HistoryEvidence {
  source: typeof LIVE_SOURCE;
  feedVersion: string;
  generatedAt: number;
  receivedAt: number;
  route: string;
  direction: number;
  serviceDate: string;
  observation: VehicleObservation;
}
export interface HistorySelection {
  records: HistoryEvidence[];
  watermarks: Record<string, HistoryWatermark>;
  duplicates: number;
  rejected: number;
  conflicts: number;
  outOfOrder: number;
  feedUsable: boolean;
}

/** Select normalized official corridor samples, never predictions or derived arrivals.
 * Watermarks belong to the private journal transaction: callers must persist them
 * atomically with records, so a failed write cannot acknowledge missing evidence. */
export function createHistorySelector(ds: Dataset) {
  const trips = new Map(ds.trips.map(t => [t.id, t]));
  const patterns = new Map(ds.patterns.map(p => [p.id, p]));
  const routes = new Map(ds.routes.map(r => [r.id, r]));
  const allowed = new Set(['163', '164', '165', '165T']);
  return (feed: NormalizedFeed, receivedAt: number, previous: Record<string, HistoryWatermark> = {}): HistorySelection => {
    const watermarks: Record<string, HistoryWatermark> = Object.fromEntries(Object.entries(previous)
      .filter(([, mark]) => Number.isSafeInteger(mark.observedAt) && mark.observedAt <= receivedAt && receivedAt - mark.observedAt <= LIVE_MAX_AGE_MS));
    const result: HistorySelection = { records: [], watermarks, duplicates: 0, rejected: 0, conflicts: 0, outOfOrder: 0, feedUsable: false };
    const generatedAt = feed.feed.timestamp;
    if (ds.meta.demo || ds.meta.transcribed || ds.meta.realtime?.provider !== 'njt-bus-g2'
      || !Number.isSafeInteger(receivedAt) || receivedAt <= 0 || feed.feed.state !== 'ok' || generatedAt === undefined
      || !Number.isSafeInteger(generatedAt) || generatedAt > receivedAt || receivedAt - generatedAt > LIVE_MAX_AGE_MS) return result;
    result.feedUsable = true;
    const candidates = new Map<string, { key: string; evidence: HistoryEvidence; fingerprint: string; conflict: boolean }>();
    for (const point of feed.observations) {
      const split = point.tripInstanceId.lastIndexOf('@');
      const trip = trips.get(point.tripInstanceId.slice(0, split)), serviceDate = point.tripInstanceId.slice(split + 1);
      const pattern = trip && patterns.get(trip.patternId), route = pattern && routes.get(pattern.routeId);
      if (!trip || !pattern || !route || !allowed.has(route.shortName) || !validServiceDate(serviceDate)
        || !isServiceActive(ds.calendars[trip.serviceId], serviceDate) || !validVehicleId(point.vehicleId)
        || !Number.isSafeInteger(point.observedAt) || point.observedAt <= 0 || point.observedAt > receivedAt || receivedAt - point.observedAt > LIVE_MAX_AGE_MS
        || !Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat!) > 90 || Math.abs(point.lon!) > 180) {
        result.rejected++; continue;
      }
      // Copy only normalized bus fields, never arbitrary feed extensions or credentials.
      const observation: VehicleObservation = { tripInstanceId: point.tripInstanceId, vehicleId: point.vehicleId, observedAt: point.observedAt, lat: point.lat, lon: point.lon };
      if (point.stopCall) {
        const call = point.stopCall;
        if (call.status !== 'stopped_at' || !Number.isSafeInteger(call.stopIndex) || call.stopIndex < 0
          || typeof call.stopId !== 'string' || pattern.stopIds[call.stopIndex] !== call.stopId) {
          result.rejected++; continue;
        }
        observation.stopCall = { status: 'stopped_at', stopId: call.stopId, stopIndex: call.stopIndex };
      }
      const key = JSON.stringify([ds.meta.feedVersion, point.tripInstanceId, point.vehicleId]);
      const fingerprint = JSON.stringify(observation), saved = watermarks[key];
      if (saved && point.observedAt <= saved.observedAt) {
        if (point.observedAt === saved.observedAt && fingerprint !== saved.fingerprint) result.conflicts++;
        else if (point.observedAt < saved.observedAt) result.outOfOrder++;
        else result.duplicates++;
        continue;
      }
      const sampleKey = JSON.stringify([key, point.observedAt]), prior = candidates.get(sampleKey);
      if (prior) {
        if (fingerprint !== prior.fingerprint) prior.conflict = true;
        else result.duplicates++;
        continue;
      }
      candidates.set(sampleKey, { key, evidence: { source: LIVE_SOURCE, feedVersion: ds.meta.feedVersion, generatedAt, receivedAt,
        route: route.shortName, direction: pattern.directionId, serviceDate, observation }, fingerprint, conflict: false });
    }
    for (const candidate of [...candidates.values()].sort((a, b) => a.evidence.observation.observedAt - b.evidence.observation.observedAt)) {
      if (candidate.conflict) { result.conflicts++; continue; }
      result.records.push(candidate.evidence);
      watermarks[candidate.key] = { observedAt: candidate.evidence.observation.observedAt, fingerprint: candidate.fingerprint };
    }
    return result;
  };
}
