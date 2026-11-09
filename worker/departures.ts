import { LIVE_MAX_AGE_MS } from '../src/domain/liveBus';
import type { DepartureReport, DepartureRequest } from '../src/domain/liveDepartures';
import type { Dataset } from '../src/domain/types';
import type { NormalizedFeed } from './normalize';
/** Read-only summaries from the same coalesced snapshots; no new NJ Transit polling path. */
export function summarizeDepartures(ds: Dataset, queries: DepartureRequest[], vehicles: NormalizedFeed, updates: NormalizedFeed, now: number): DepartureReport[] {
  return queries.map(query => {
    const id = query.tripId + '@' + query.serviceDate;
    const matches = updates.updates.filter(u => u.tripInstanceId === id), update = matches.length === 1 ? matches[0] : undefined;
    const points = vehicles.observations.filter(o => o.tripInstanceId === id && o.observedAt <= now && now - o.observedAt <= LIVE_MAX_AGE_MS);
    const ambiguous = matches.length > 1 || new Set(points.map(o => o.vehicleId)).size > 1;
    const missingDate = vehicles.unresolvedDateTrips?.includes(query.tripId) || updates.unresolvedDateTrips?.includes(query.tripId);
    const report: DepartureReport = { query, ...(ambiguous ? { problem: 'ambiguous' } : missingDate ? { problem: 'date-unknown' } : {}) };
    if (points.length && !ambiguous) report.gpsObservedAt = Math.max(...points.map(p => p.observedAt));
    if (update && !ambiguous) {
      report.updatedAt = update.observedAt;
      if (update.cancelled) report.cancelledAt = update.observedAt;
      report.boardingSkipped = update.skippedStops.includes(query.stopIndex); report.destinationSkipped = update.skippedStops.includes(query.toStopIndex);
      const dep = update.predictions.filter(p => p.stopIndex === query.stopIndex && p.kind === 'departure');
      const trip = ds.trips.find(t => t.id === query.tripId)!, pattern = ds.patterns.find(p => p.id === trip.patternId)!;
      const boardArrival = ds.stops.find(s => s.id === pattern.stopIds[query.stopIndex])?.terminal === 'PABT' ? [] : update.predictions.filter(p => p.stopIndex === query.stopIndex && p.kind === 'arrival');
      const arr = update.predictions.filter(p => p.stopIndex === query.toStopIndex && p.kind === 'arrival');
      if (dep.length > 1 || arr.length > 1 || boardArrival.length > 1 || (dep[0] && boardArrival[0] && boardArrival[0].at > dep[0].at) || (arr[0] && (dep[0] ?? boardArrival[0]) && arr[0].at < (dep[0] ?? boardArrival[0])!.at)) report.problem = 'ambiguous';
      else { report.departure = dep[0]; report.boardingArrival = boardArrival[0]; report.arrival = arr[0]; }
    }
    // Same snapshot, same exact trip: no additional upstream request. Equal-time
    // contradictory fixes remain unknown rather than choosing arbitrary coordinates.
    if (!report.problem && report.gpsObservedAt !== undefined) {
      const latest = points.filter(p => p.observedAt === report.gpsObservedAt);
      const unique = new Set(latest.map(p => JSON.stringify([p.vehicleId, p.lat, p.lon, p.stopCall ?? null])));
      if (unique.size === 1) report.gps = latest[0];
    }
    return report;
  });
}
