// A return-plan calculation, not a promise of the last operating bus. Keep the published
// service-day boundary visible and show the following departure whenever it is known.
import { returnLeg } from './direction';
import { boardIndex, dropIndex } from './place';
import { isNjtHoliday } from './holidays';
import { departuresOn, tripStopTimes } from './schedule';
import { addDays, localYmd, parseYmd, zonedWallTime } from './time';
import type { Dataset, Departure } from './types';

export type LastReturnStatus = 'available' | 'continues_overnight' | 'unconfirmed' | 'no_return_listed' | 'not_applicable';
export type LastReturnLimitation =
  | 'schedule_only' | 'same_line_only' | 'service_day_boundary'
  | 'demo_schedule' | 'printed_timepoints_only' | 'printed_validity_unconfirmed'
  | 'different_return_stop' | 'holiday_schedule_missing' | 'calendar_missing'
  | 'schedule_coverage_missing' | 'following_departure_unknown' | 'estimated_departure'
  | 'no_reverse_stop' | 'no_return_on_service_day' | 'outbound_arrives_after_last'
  | 'not_outbound_to_pabt' | 'invalid_outbound';

export interface LastReturnResult {
  status: LastReturnStatus;
  routeId: string;
  serviceDate: string;
  returnLeg?: { fromStopId: string; toStopId: string };
  window?: {
    /** Scheduled arrival of the chosen outbound trip at its PABT destination. */
    from: number;
    /** Explicit overnight comparison window, through 5 AM after the selected service date. */
    overnightEndsAt: number;
    /** Final local calendar date examined for the following listed departure (YYYYMMDD). */
    searchedThrough: string;
  };
  /** Last matching return listed on this operating/service date, including times past 24:00. */
  lastForServiceDay?: Departure;
  /** An earlier return on that service date which is not before scheduled outbound arrival. */
  previous?: Departure;
  /** First later matching departure, even if it belongs to another day or follows the window. */
  nextAfterLast?: Departure;
  /** First matching return at or after the outbound trip's scheduled PABT arrival. */
  firstReturn?: Departure;
  limitations: LastReturnLimitation[];
}

/**
 * Same-line return planning for a selected trip into PABT. Route IDs are compared exactly:
 * no suffix decoding, no hidden fallback to another line, and no guessed reverse stop.
 *
 * "available" means these scheduled facts are available, not that the trip is operating,
 * has seats, is the last possible way home, or can be caught after an actual late arrival.
 * "continues_overnight" means another service day's departures continue inside the explicit
 * overnight window; it makes no claim about frequency or uninterrupted service.
 */
export function lastReturn(ds: Dataset, outbound: Departure, toStopId: string): LastReturnResult {
  const base = { routeId: outbound.route.id, serviceDate: outbound.serviceDate };
  const limitations: LastReturnLimitation[] = ['schedule_only', 'same_line_only', 'service_day_boundary'];
  const homeStopId = outbound.pattern.stopIds[outbound.stopIndex];
  const toIndex = dropIndex(ds, outbound.pattern, toStopId, outbound.stopIndex + 1);
  if (ds.stops.find((s) => s.id === toStopId)?.terminal !== 'PABT' || toIndex <= outbound.stopIndex) {
    return { ...base, status: 'not_applicable', limitations: [...limitations, 'not_outbound_to_pabt'] };
  }
  const date = outbound.serviceDate;
  if (!/^\d{8}$/.test(date) || addDays(date, 0) !== date || !homeStopId || outbound.pattern.routeId !== outbound.route.id) {
    return { ...base, status: 'unconfirmed', limitations: [...limitations, 'invalid_outbound'] };
  }
  const arrival = tripStopTimes(ds, outbound)[toIndex];
  if (!arrival || !Number.isFinite(arrival.at) || arrival.at < outbound.departs) {
    return { ...base, status: 'unconfirmed', limitations: [...limitations, 'invalid_outbound'] };
  }
  if (ds.meta.demo) limitations.push('demo_schedule');
  if (ds.meta.transcribed) limitations.push('printed_timepoints_only', 'printed_validity_unconfirmed');

  const leg = returnLeg(ds, homeStopId, toStopId, [outbound.route.id]);
  if (!leg) return { ...base, status: 'unconfirmed', limitations: [...limitations, 'no_reverse_stop'] };
  if (leg.toStopId !== homeStopId || leg.fromStopId !== toStopId) limitations.push('different_return_stop');

  const tomorrow = addDays(date, 1);
  const [y, m, d] = parseYmd(tomorrow);
  const window = {
    from: arrival.at,
    overnightEndsAt: zonedWallTime(y, m, d, 5, 0, ds.meta.timezone),
    searchedThrough: addDays(date, 7),
  };
  const query = { stopId: leg.fromStopId, toStopId: leg.toStopId, routeIds: [outbound.route.id] };
  const distinct = new Map<string, Departure>();
  // The previous calendar day also matters on GTFS clock-change dates. departuresOn keeps
  // each actual service date, including the after-midnight trips in the printed timetable.
  for (let offset = -1; offset <= 7; offset++) {
    for (const dep of departuresOn(ds, { ...query, date: addDays(date, offset) })) distinct.set(dep.tripInstanceId, dep);
  }
  const all = [...distinct.values()].sort((a, b) => a.departs - b.departs || a.tripInstanceId.localeCompare(b.tripInstanceId));
  const sameDay = all.filter((dep) => dep.serviceDate === date);
  const lastForServiceDay = sameDay.at(-1);
  const previous = lastForServiceDay
    ? sameDay.filter((dep) => dep.departs >= arrival.at && dep.departs < lastForServiceDay.departs).at(-1) : undefined;
  const nextAfterLast = lastForServiceDay ? all.find((dep) => dep.departs > lastForServiceDay.departs) : undefined;
  const firstReturn = all.find((dep) => dep.departs >= arrival.at);

  // Validate availability for the line/stop pair, not a different route's far-future calendar.
  const patterns = new Set(ds.patterns.filter((p) => p.routeId === outbound.route.id
    && boardIndex(ds, p, leg.fromStopId) >= 0 && dropIndex(ds, p, leg.toStopId, boardIndex(ds, p, leg.fromStopId) + 1) >= 0).map((p) => p.id));
  const serviceIds = [...new Set(ds.trips.filter((t) => patterns.has(t.patternId)).map((t) => t.serviceId))];
  const calendars = serviceIds.map((id) => ds.calendars[id]);
  if (!serviceIds.length || calendars.some((c) => !c)) limitations.push('calendar_missing');
  const checkThrough = [tomorrow, nextAfterLast?.serviceDate, nextAfterLast && localYmd(nextAfterLast.departs, ds.meta.timezone)]
    .filter((day): day is string => !!day).sort().at(-1)!;
  const checkedDates: string[] = [];
  for (let day = date; day <= checkThrough; day = addDays(day, 1)) checkedDates.push(day);
  const covered = checkedDates.every((day) => calendars.some((c) => c && ((day >= c.start && day <= c.end) || c.added.includes(day))));
  if (!covered) limitations.push('schedule_coverage_missing');
  if (ds.meta.transcribed && checkedDates.some(isNjtHoliday)) limitations.push('holiday_schedule_missing');
  if (lastForServiceDay && !nextAfterLast) limitations.push('following_departure_unknown');
  if (lastForServiceDay?.estimated || nextAfterLast?.estimated) limitations.push('estimated_departure');
  if (!lastForServiceDay) limitations.push('no_return_on_service_day');
  if (lastForServiceDay && lastForServiceDay.departs < arrival.at) limitations.push('outbound_arrives_after_last');

  const uncertain = limitations.some((l) => ['calendar_missing', 'schedule_coverage_missing', 'holiday_schedule_missing', 'following_departure_unknown', 'estimated_departure'].includes(l));
  const laterOvernight = all.some((dep) => dep.serviceDate !== date && dep.departs >= arrival.at
    && dep.departs < window.overnightEndsAt && (!lastForServiceDay || dep.departs > lastForServiceDay.departs));
  const status: LastReturnStatus = uncertain ? 'unconfirmed'
    : laterOvernight ? 'continues_overnight'
      : !lastForServiceDay || lastForServiceDay.departs < arrival.at ? 'no_return_listed' : 'available';
  return { ...base, status, returnLeg: leg, window, lastForServiceDay, previous, nextAfterLast, firstReturn, limitations };
}
