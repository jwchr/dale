import bindings from 'gtfs-realtime-bindings';
import { isServiceActive } from '../src/domain/schedule';
import { validServiceDate, validVehicleId, LIVE_MAX_AGE_MS, type LiveFeed, type LivePrediction } from '../src/domain/liveBus';
import { tripInstanceId, type Dataset, type Pattern } from '../src/domain/types';
import type { VehicleObservation } from '../src/domain/lock';
import { uniqueCalendarDate, dateContainsReport } from './service-date';
type Descriptor = bindings.transit_realtime.ITripDescriptor;
export interface NormalizedUpdate { tripInstanceId: string; observedAt: number; cancelled: boolean; predictions: LivePrediction[]; skippedStops: number[] }
export interface FeedDiagnostics { entities: number; knownTrips: number; corridorRoutes: number; missingServiceDates: number; missingObservationTimes: number }
export interface VehiclePresence { vehicleId: string; tripId?: string; tripInstanceId?: string; routeId?: string; observedAt?: number; qualification: 'unmatched' | 'invalid-position-or-time' | 'unsupported-service' | 'stale' | 'matched' }
export interface NormalizedFeed { presence?: VehiclePresence[]; unresolvedDateTrips?: string[]; diagnostics?: FeedDiagnostics; feed: LiveFeed; observations: VehicleObservation[]; updates: NormalizedUpdate[] }
const seconds = (v: unknown) => { const n = Number(v), ms = n * 1000; return Number.isSafeInteger(n) && n > 0 && Number.isSafeInteger(ms) && Number.isFinite(new Date(ms).getTime()) ? ms : undefined; };

export function createNormalizer(ds: Dataset) {
  const trips = new Map(ds.trips.map((t) => [t.id, t])), patterns = new Map(ds.patterns.map((p) => [p.id, p]));
  const routes = new Map(ds.routes.map((r) => [r.id, r]));
  const uniqueDates = new Map(Object.entries(ds.calendars).map(([id, cal]) => [id, uniqueCalendarDate(cal)]));
  function identify(d: Descriptor | null | undefined, observedAt: number | undefined): { id: string; pattern: Pattern } | undefined {
    if (!d?.tripId || !observedAt) return;
    const trip = trips.get(d.tripId), pattern = trip && patterns.get(trip.patternId), route = pattern && routes.get(pattern.routeId);
    if (!trip || !pattern || !route) return;
    // Empty protobuf strings convey no date; a nonempty invalid date is never repaired.
    const explicit = !!d.startDate;
    if (d.startTime) {
      const parts = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(d.startTime);
      const start = parts && Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]);
      if (!Number.isSafeInteger(start) || start !== trip.times[0]) return;
    }
    const date = explicit ? d.startDate : uniqueDates.get(trip.serviceId);
    if (!date || !validServiceDate(date) || !isServiceActive(ds.calendars[trip.serviceId], date)) return;
    if (!explicit && (ds.meta.realtime?.provider !== 'njt-bus-g2' || ds.meta.demo || ds.meta.transcribed || !dateContainsReport(ds, trip, date, observedAt))) return;
    if (d.routeId && d.routeId !== (route.feedRouteId ?? route.id)) return;
    if (d.directionId != null && Object.hasOwn(d, 'directionId') && d.directionId !== pattern.directionId) return;
    // Ambiguous/malformed dates and added/duplicated/unscheduled trips remain unknown.
    return { id: tripInstanceId(trip.id, date), pattern };
  }
  return function normalize(bytes: Uint8Array, kind: 'vehicles' | 'updates', now: number): NormalizedFeed {
    const empty: NormalizedFeed = { feed: { state: 'invalid' }, observations: [], updates: [] };
    try {
      const data = bindings.transit_realtime.FeedMessage.decode(bytes), at = seconds(data.header.timestamp);
      if (!at || at > now || data.header.incrementality === 1) return empty;
      const diagnostics: FeedDiagnostics = { entities: data.entity.length, knownTrips: 0, corridorRoutes: 0, missingServiceDates: 0, missingObservationTimes: 0 };
      const feedRoutes = new Set(ds.routes.map((r) => r.feedRouteId ?? r.id));
      const output: NormalizedFeed = { ...(kind === 'vehicles' ? { presence: [] } : {}), unresolvedDateTrips: [], diagnostics, feed: { state: now - at > LIVE_MAX_AGE_MS ? 'stale' : 'ok', timestamp: at }, observations: [], updates: [] };
      for (const entity of data.entity) {
        if (entity.isDeleted) continue;
        const report = kind === 'vehicles' ? entity.vehicle : entity.tripUpdate;
        if (report?.trip) {
          if (feedRoutes.has(report.trip.routeId ?? '')) diagnostics.corridorRoutes++;
          if (trips.has(report.trip.tripId ?? '')) {
            diagnostics.knownTrips++;
            if (!report.trip.startDate && !uniqueDates.get(trips.get(report.trip.tripId!)!.serviceId) && !output.unresolvedDateTrips!.includes(report.trip.tripId!)) output.unresolvedDateTrips!.push(report.trip.tripId!);
            if (!report.trip.startDate) diagnostics.missingServiceDates++;
            if (!seconds(report.timestamp)) diagnostics.missingObservationTimes++;
          }
        }
        if (kind === 'vehicles' && entity.vehicle) {
          const vehicle = entity.vehicle, observedAt = seconds(vehicle.timestamp), match = identify(vehicle.trip, observedAt), pos = vehicle.position;
          let presence: VehiclePresence | undefined;
          // Corridor-only timestamp census preserves unchanged/rejected presence
          // for cadence analysis, without storing any systemwide coordinates.
          if (validVehicleId(vehicle.vehicle?.id) && (feedRoutes.has(vehicle.trip?.routeId ?? '') || trips.has(vehicle.trip?.tripId ?? ''))) {
            presence = { vehicleId: vehicle.vehicle.id, ...(vehicle.trip?.tripId && vehicle.trip.tripId.length <= 256 ? { tripId: vehicle.trip.tripId } : {}),
              ...(match ? { tripInstanceId: match.id } : {}),
              ...(feedRoutes.has(vehicle.trip?.routeId ?? '') ? { routeId: vehicle.trip!.routeId! } : {}),
              ...(observedAt !== undefined ? { observedAt } : {}), qualification: match ? 'invalid-position-or-time' : 'unmatched' };
            output.presence!.push(presence);
          }
          if (presence && (vehicle.trip?.scheduleRelationship ?? 0) !== 0) presence.qualification = 'unsupported-service';
          if (!match || !observedAt || observedAt > now || !validVehicleId(vehicle.vehicle?.id) || !pos
            || !Object.hasOwn(pos, 'latitude') || !Object.hasOwn(pos, 'longitude') || !Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)
            || Math.abs(pos.latitude) > 90 || Math.abs(pos.longitude) > 180 || (vehicle.trip?.scheduleRelationship ?? 0) !== 0) continue;
          if (presence) presence.qualification = now - observedAt > LIVE_MAX_AGE_MS ? 'stale' : 'matched';
          const candidates = match.pattern.stopIds.flatMap((id, i) => (!vehicle.stopId || vehicle.stopId === id)
            && (!Object.hasOwn(vehicle, 'currentStopSequence') || vehicle.currentStopSequence === match.pattern.stopSequences?.[i]) ? [i] : []);
          const index = candidates.length === 1 ? candidates[0]! : undefined;
          const stopCall = Object.hasOwn(vehicle, 'currentStatus') && vehicle.currentStatus === 1 && index !== undefined
            && (!!vehicle.stopId || Object.hasOwn(vehicle, 'currentStopSequence'))
            ? { stopId: match.pattern.stopIds[index]!, stopIndex: index, status: 'stopped_at' as const } : undefined;
          output.observations.push({ tripInstanceId: match.id, vehicleId: vehicle.vehicle.id, observedAt, lat: pos.latitude, lon: pos.longitude, ...(stopCall ? { stopCall } : {}) });
        }
        if (kind === 'updates' && entity.tripUpdate) {
          const update = entity.tripUpdate, observedAt = seconds(update.timestamp), match = identify(update.trip, observedAt);
          if (!match || !observedAt || observedAt > now || ![0, 3].includes(update.trip.scheduleRelationship ?? 0)) continue;
          const normalized: NormalizedUpdate = { tripInstanceId: match.id, observedAt, cancelled: update.trip.scheduleRelationship === 3, predictions: [], skippedStops: [] };
          for (const stop of update.stopTimeUpdate ?? []) {
            const candidates = match.pattern.stopIds.flatMap((id, i) => (!stop.stopId || stop.stopId === id)
              && (!Object.hasOwn(stop, 'stopSequence') || stop.stopSequence === match.pattern.stopSequences?.[i]) ? [i] : []);
            if (candidates.length !== 1) continue;
            const stopIndex = candidates[0]!;
            if (stop.scheduleRelationship === 1) { normalized.skippedStops.push(stopIndex); continue; }
            if (stop.scheduleRelationship === 2 || normalized.cancelled) continue;
            for (const key of ['arrival', 'departure'] as const) {
              const prediction = stop[key], time = prediction && seconds(prediction.time);
              if (time) normalized.predictions.push({ stopIndex, at: time, observedAt, kind: key });
            }
          }
          output.updates.push(normalized);
        }
      }
      return new TextEncoder().encode(JSON.stringify(output)).byteLength <= 700_000 ? output : empty;
    } catch { return empty; }
  };
}
