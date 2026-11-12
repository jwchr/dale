import { isServiceActive, tripTimeAt } from '../src/domain/schedule';
import { addDays, localYmd } from '../src/domain/time';
import { validServiceDate } from '../src/domain/liveBus';
import type { Dataset, Trip } from '../src/domain/types';

/**
 * How far before the scheduled first departure and after the scheduled last
 * arrival an undated report still counts as that day's run. It only separates
 * one service day from the next; the trip ID itself comes from NJ Transit.
 */
export const OMITTED_DATE_MARGIN_MS = 3 * 3600_000;
/** Longest trip (last GTFS time, seconds) the bounded date scan below can see. */
const MAX_TRIP_SECONDS = 60 * 3600;

/**
 * Resolve an omitted GTFS-Realtime start date from the report's own source
 * timestamp. A date qualifies only if the trip's calendar is active on it and
 * the report falls inside that day's scheduled trip window (plus the margin).
 * Exactly one qualifying date resolves; zero or several stay unknown. Receipt
 * time, today and the nearest departure are never used.
 */
export function resolveOmittedDate(ds: Dataset, trip: Trip, observedAt: number | undefined): string | undefined {
  if (!observedAt || ds.meta.realtime?.provider !== 'njt-bus-g2' || ds.meta.demo || ds.meta.transcribed) return;
  const last = trip.times.length - 1;
  if (last < 0 || !trip.times.every((s) => Number.isSafeInteger(s) && s >= 0) || trip.times[last]! > MAX_TRIP_SECONDS) return;
  const cal = ds.calendars[trip.serviceId], day = localYmd(observedAt, ds.meta.timezone);
  // A service date D runs from about D 00:00 (minus margin and a DST hour) to
  // D + 60 h + margin, so only D in [day - 3, day + 1] can contain the report.
  const fits: string[] = [];
  for (let offset = -3; offset <= 1; offset++) {
    const date = addDays(day, offset);
    if (!validServiceDate(date) || !isServiceActive(cal, date)) continue;
    const start = tripTimeAt(ds, trip, date, 0) - OMITTED_DATE_MARGIN_MS, end = tripTimeAt(ds, trip, date, last) + OMITTED_DATE_MARGIN_MS;
    if (observedAt >= start && observedAt <= end) fits.push(date);
  }
  return fits.length === 1 ? fits[0] : undefined;
}
