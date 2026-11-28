import { addDays, localYmd, serviceTimeToInstant, type TimeBase, weekdayIndex } from './time';
import { boardIndex, dropIndex } from './place';
import { type Dataset, type Departure, type LockableDeparture, type Pattern, type Route, type ServiceCalendar, type Trip, tripInstanceId } from './types';

export function isServiceActive(cal: ServiceCalendar | undefined, ymd: string): boolean {
  if (!cal) return false;
  if (cal.removed.includes(ymd)) return false;
  if (cal.added.includes(ymd)) return true;
  return ymd >= cal.start && ymd <= cal.end && cal.days[weekdayIndex(ymd)] === true;
}

/** A timetable typed in from print gives wall-clock times; NJ Transit's GTFS feed uses the GTFS rule. */
export const timeBaseOf = (ds: Dataset): TimeBase => (ds.meta.transcribed ? 'wall' : 'gtfs');

/**
 * Epoch ms of a trip's `i`-th time on `serviceDate`. With printed wall-clock times the first time is read
 * on the clock and later stops add the printed running times, so a bus that keeps running through a
 * clock change keeps its real pace. On the fall-back night that shows a printed 2:03 AM as 1:03 AM, the
 * safe side (nothing printed says the bus waits out the repeated hour); on the spring-forward night it
 * matches the clock (a printed 2:03 AM, which does not exist, shows as 3:03 AM).
 */
export function tripTimeAt(ds: Dataset, trip: Trip, serviceDate: string, i: number): number {
  const tz = ds.meta.timezone;
  const secs = trip.times[i] ?? 0;
  if (timeBaseOf(ds) === 'gtfs') return serviceTimeToInstant(serviceDate, secs, tz);
  const first = trip.times[0] ?? 0;
  return serviceTimeToInstant(serviceDate, first, tz, 'wall') + (secs - first) * 1000;
}

/** Explicit scheduled arrival at the selected stop; unknown is not a departure time. */
export function tripArrivalAt(ds: Dataset, trip: Trip, serviceDate: string, index: number): number | undefined {
  const seconds = trip.arrivals?.[index];
  if (seconds !== undefined && seconds !== null) {
    return timeBaseOf(ds) === 'gtfs' ? serviceTimeToInstant(serviceDate, seconds, ds.meta.timezone)
      : tripTimeAt(ds, trip, serviceDate, 0) + (seconds - (trip.times[0] ?? 0)) * 1000;
  }
  // The existing demo/printed timepoints have no separate arrival/departure fields.
  return ds.meta.demo || ds.meta.transcribed ? tripTimeAt(ds, trip, serviceDate, index) : undefined;
}

export interface DepartureQuery {
  stopId: string;
  /** Local calendar date YYYYMMDD whose departures we want (midnight to midnight). */
  date: string;
  routeIds?: string[];
  directionId?: 0 | 1;
  /** Only patterns that later reach this stop (a trip "to" somewhere). */
  toStopId?: string;
}

/**
 * Every scheduled departure from a stop on one local calendar date, both from that date's service
 * and from the previous service date's after-midnight trips (GTFS times past 24:00).
 * The last stop of a pattern is not a departure.
 */
export function departuresOn(ds: Dataset, q: DepartureQuery): Departure[] {
  const tz = ds.meta.timezone;
  const patterns = new Map(ds.patterns.map((p) => [p.id, p]));
  const routes = new Map(ds.routes.map((r) => [r.id, r]));
  const out: Departure[] = [];
  // Previous service day: trips past 24:00. Next service day: on a spring-forward date, GTFS times
  // before 01:00 fall on the evening before (noon-minus-12h rule), so they belong to q.date.
  for (const serviceDate of [addDays(q.date, -1), q.date, addDays(q.date, 1)]) {
    for (const trip of ds.trips) {
      if (!isServiceActive(ds.calendars[trip.serviceId], serviceDate)) continue;
      const pattern = patterns.get(trip.patternId);
      if (!pattern || !matchesPattern(ds, pattern, q)) continue;
      const stopIndex = boardIndex(ds, pattern, q.stopId);
      if (stopIndex < 0 || stopIndex === pattern.stopIds.length - 1 || pattern.noPickup?.includes(stopIndex)) continue;
      const route = routes.get(pattern.routeId);
      const dep = route && scheduledDeparture(ds, trip, pattern, route, serviceDate, stopIndex);
      if (dep && localYmd(dep.departs, tz) === q.date) out.push(dep);
    }
  }
  return out.sort((a, b) => a.departs - b.departs || a.route.shortName.localeCompare(b.route.shortName));
}

/** One construction path for a dated scheduled row, including missing-time checks. */
function scheduledDeparture(ds: Dataset, trip: Trip, pattern: Pattern, route: Route, serviceDate: string, stopIndex: number): Departure | undefined {
  if (trip.times[stopIndex] === undefined || trip.times[trip.times.length - 1] === undefined) return;
  return {
    tripInstanceId: tripInstanceId(trip.id, serviceDate), tripId: trip.id, serviceDate, route, pattern, stopIndex,
    departs: tripTimeAt(ds, trip, serviceDate, stopIndex), estimated: trip.estimated?.includes(stopIndex) ?? false,
    arrivesEnd: tripTimeAt(ds, trip, serviceDate, trip.times.length - 1),
  };
}

function matchesPattern(ds: Dataset, p: Pattern, q: DepartureQuery): boolean {
  if (q.routeIds && q.routeIds.length && !q.routeIds.includes(p.routeId)) return false;
  if (q.directionId !== undefined && p.directionId !== q.directionId) return false;
  if (q.toStopId) {
    const from = boardIndex(ds, p, q.stopId);
    const to = from < 0 ? -1 : dropIndex(ds, p, q.toStopId, from + 1);
    if (from < 0 || to <= from || p.noDropOff?.includes(to)) return false;
  }
  return true;
}

/** The next `n` departures at or after `now`, crossing into tomorrow if needed. */
export function nextDepartures(ds: Dataset, q: Omit<DepartureQuery, 'date'>, now: number, n: number): Departure[] {
  const today = localYmd(now, ds.meta.timezone);
  const list = [...departuresOn(ds, { ...q, date: today }), ...departuresOn(ds, { ...q, date: addDays(today, 1) })];
  return list.filter((d) => d.departs >= now - 60_000).slice(0, n);
}

/** Scheduled time (epoch ms) at every stop of a departure's trip, for the stop list. `estimated` marks Dale's filled-in times. */
export function tripStopTimes(ds: Dataset, d: Pick<Departure, 'tripId' | 'serviceDate' | 'pattern'>): { stopId: string; at: number; estimated: boolean }[] {
  const trip = ds.trips.find((t) => t.id === d.tripId);
  if (!trip) return [];
  const first = trip.times[0] ?? 0;
  const start = tripTimeAt(ds, trip, d.serviceDate, 0);
  return d.pattern.stopIds.map((stopId, i) => ({
    stopId,
    at: start + ((trip.times[i] ?? 0) - first) * 1000,
    estimated: trip.estimated?.includes(i) ?? false,
  }));
}

/** Today's service and yesterday's trips whose scheduled end reaches today, including already-left rows.
 * Each row retains its own service date. No live/history evidence or current-location guess is used. */
export function lockableTrips(ds: Dataset, q: { stopId?: string; routeIds?: string[]; directionId?: 0 | 1 }, now: number): LockableDeparture[] {
  if (!Number.isFinite(now)) return [];
  const today = localYmd(now, ds.meta.timezone), yesterday = addDays(today, -1);
  const inPool = (d: LockableDeparture) => d.serviceDate === today
    || (d.serviceDate === yesterday && localYmd(d.arrivesEnd, ds.meta.timezone) >= today);
  const patterns = new Map(ds.patterns.map(p => [p.id, p])), routes = new Map(ds.routes.map(r => [r.id, r]));
  const rows: LockableDeparture[] = [];
  for (const serviceDate of [yesterday, today]) for (const trip of ds.trips) {
    if (!isServiceActive(ds.calendars[trip.serviceId], serviceDate)) continue;
    const pattern = patterns.get(trip.patternId), route = pattern && routes.get(pattern.routeId);
    if (!pattern || !route || !trip.times.length || trip.times.length !== pattern.stopIds.length
      || (q.routeIds?.length && !q.routeIds.includes(route.id))
      || (q.directionId !== undefined && pattern.directionId !== q.directionId)) continue;
    const stopIndex = q.stopId === undefined ? 0 : boardIndex(ds, pattern, q.stopId);
    if (stopIndex < 0 || (q.stopId !== undefined && (stopIndex === pattern.stopIds.length - 1 || pattern.noPickup?.includes(stopIndex)))) continue;
    const scheduled = scheduledDeparture(ds, trip, pattern, route, serviceDate, stopIndex);
    if (!scheduled) continue;
    const row: LockableDeparture = { ...scheduled, stopIndex: q.stopId === undefined ? null : stopIndex };
    if (inPool(row)) rows.push(row);
  }
  return rows.sort((a, b) => a.departs - b.departs || a.tripInstanceId.localeCompare(b.tripInstanceId));
}
