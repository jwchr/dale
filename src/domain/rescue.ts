// "Get me the fuck home" (issue #32, D45): when the usual bus is late, missing or full, list every
// scheduled way Dale's data knows from here (or the stop across the street) to home (or the stop
// across from it), ranked by arrival. Coverage is stated, never implied: routes outside Dale's data
// are unknown, not absent. With the wider official schedule (src/domain/rescueSchedule.ts) the search
// also covers routes that share a stop with the corridor; when it is missing, the reason is returned
// so the screen says what was not searched. There is no walking or transfer data: a bus that stops near
// home is listed separately with the straight-line distance, which is never presented as a verified walk.
import { distanceM, twinOf } from './direction';
import { isNjtHoliday } from './holidays';
import { departuresOn, tripStopTimes } from './schedule';
import { addDays, localYmd, parseYmd, zonedWallTime } from './time';
import { withRescueSchedule, type RescueSchedule } from './rescueSchedule';
import type { Dataset, Departure } from './types';

export interface RescueOption {
  dep: Departure;
  /** Where to board: the rider's stop, or the stop across the street. */
  boardStopId: string;
  acrossFromBoard: boolean;
  /** Where it gets off: home, or the stop across from home. */
  alightStopId: string;
  acrossFromHome: boolean;
  arrives: number;
  arrivesEstimated: boolean;
  /** The same route as the rider's usual bus. */
  sameLine: boolean;
  /** The rider's line's last listed trip home before tonight's overnight break in service. */
  lastOnLine: boolean;
  /** Set with lastOnLine on a printed timetable's holiday, whose own schedule is not printed. */
  lastUnconfirmed?: boolean;
  /** A route from the wider official schedule: scheduled only, with no live tracking in Dale. */
  wider?: boolean;
}

/** A bus that stops near home but not at it. The distance is a straight line between stops, not a verified walk. */
export interface RescueNearHome extends RescueOption {
  straightLineM: number;
}

export type RescueLimitation = 'schedule_only' | 'routes_in_data_only' | 'no_walking_or_transfers' | 'printed_timepoints_only' | 'demo_schedule'
  | 'no_transfers' | 'walk_straight_line_only' | 'wider_routes_missing' | 'wider_routes_loading';

/** What the caller knows about the wider official schedule. Absent: not asked for (printed or demo data). */
export type RescueWider = { state: 'loading' } | { state: 'ready'; schedule: RescueSchedule } | { state: 'missing'; reason: string };

export interface RescueResult {
  options: RescueOption[];
  /** Buses that stop near home (never at it), soonest first; empty when stop locations are unknown. */
  nearHome: RescueNearHome[];
  /** Short names of the routes Dale's data has: the only ones searched. */
  routesSearched: string[];
  /** Short names of the searched routes that came from the wider official schedule. */
  widerRoutes: string[];
  /** Why the wider routes were not searched, when they were not. */
  widerMissing?: string;
  searchedUntil: number;
  limitations: RescueLimitation[];
}

/** Stops this close to home in a straight line are offered as "near home". Not a walking distance. */
export const NEAR_HOME_M = 800;
const NEAR_HOME_LIMIT = 4;
const byNumber = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

export const RESCUE_HORIZON_MS = 4 * 3600_000;
/** A gap this long with no bus on the line is the overnight break; the trip before it is the last tonight. */
export const OVERNIGHT_GAP_MS = 2 * 3600_000;
/** How far ahead to look for that break (it must start within this window, and be followed by a known trip). */
const LAST_SEARCH_MS = 20 * 3600_000;

/**
 * Scheduled options from `fromStopId` to `homeStopId` departing between `now` and the horizon, nearest
 * arrival first. `usualRouteId` marks same-line options, and the line's last listed trip home today is
 * kept even when later than the horizon or the limit, so a "last chance" is never hidden.
 */
export function rescueOptions(corridor: Dataset, fromStopId: string, homeStopId: string, now: number, usualRouteId?: string, limit = 6, horizonMs = RESCUE_HORIZON_MS, wider?: RescueWider): RescueResult {
  const { ds, widerRouteIds } = withRescueSchedule(corridor, wider?.state === 'ready' ? wider.schedule : undefined);
  const tz = ds.meta.timezone;
  const stop = (id: string) => ds.stops.find((s) => s.id === id);
  const from = stop(fromStopId);
  const home = stop(homeStopId);
  const located = (s: { lat?: number; lon?: number } | undefined): s is { lat: number; lon: number } => typeof s?.lat === 'number' && typeof s?.lon === 'number';
  const walkable = located(home);
  const limitations: RescueLimitation[] = ['schedule_only', 'routes_in_data_only'];
  limitations.push(...(walkable ? ['no_transfers', 'walk_straight_line_only'] as const : ['no_walking_or_transfers'] as const));
  if (ds.meta.transcribed) limitations.push('printed_timepoints_only');
  if (ds.meta.demo) limitations.push('demo_schedule');
  if (wider?.state === 'loading') limitations.push('wider_routes_loading');
  if (wider?.state === 'missing') limitations.push('wider_routes_missing');
  const routesSearched = [...new Set(ds.routes.map((r) => r.shortName))].sort(byNumber);
  const widerRoutes = [...new Set(ds.routes.filter((r) => widerRouteIds.has(r.id)).map((r) => r.shortName))].sort(byNumber);
  const until = now + horizonMs;
  const base = { routesSearched, widerRoutes, ...(wider?.state === 'missing' ? { widerMissing: wider.reason } : {}), searchedUntil: until, limitations };
  if (!from || !home) return { ...base, options: [], nearHome: [] };

  const boards = [from, twinOf(ds, from)].filter((s): s is NonNullable<typeof s> => !!s);
  const homes = [home, twinOf(ds, home)].filter((s): s is NonNullable<typeof s> => !!s);
  // Stops within a straight line of home. Distances are between stop coordinates only.
  const nearStops = new Map<string, number>();
  if (walkable) {
    for (const s of ds.stops) {
      if (homes.some((h) => h.id === s.id) || !located(s)) continue;
      const m = Math.round(distanceM(home, s));
      if (m <= NEAR_HOME_M) nearStops.set(s.id, m);
    }
  }
  const today = localYmd(now, tz);
  const found = new Map<string, RescueOption>();
  const near = new Map<string, RescueNearHome>();
  const line = new Map<string, RescueOption>();

  for (const board of boards) {
    for (const date of [today, addDays(today, 1), addDays(today, 2)]) {
      for (const dep of departuresOn(ds, { stopId: board.id, date })) {
        const ids = dep.pattern.stopIds;
        // A stop the pattern does not let riders off at (GTFS drop_off_type) is never a way home.
        const alightIndex = ids.findIndex((id, i) => i > dep.stopIndex && !dep.pattern.noDropOff?.includes(i) && homes.some((h) => h.id === id));
        if (alightIndex < 0) {
          if (!nearStops.size || dep.departs < now - 60_000 || dep.departs > until) continue;
          // No stop at home: the stop nearest home (straight line) that lets riders off, if any.
          let best = -1;
          ids.forEach((id, i) => {
            const m = nearStops.get(id);
            if (m !== undefined && i > dep.stopIndex && !dep.pattern.noDropOff?.includes(i) && (best < 0 || m < nearStops.get(ids[best]!)!)) best = i;
          });
          const at = best < 0 ? undefined : tripStopTimes(ds, dep)[best];
          if (!at) continue;
          const option: RescueNearHome = {
            dep, boardStopId: board.id, acrossFromBoard: board.id !== from.id, alightStopId: ids[best]!, acrossFromHome: false,
            arrives: at.at, arrivesEstimated: at.estimated, sameLine: dep.route.id === usualRouteId, lastOnLine: false,
            straightLineM: nearStops.get(ids[best]!)!, ...(widerRouteIds.has(dep.route.id) ? { wider: true } : {}),
          };
          const prev = near.get(dep.tripInstanceId);
          if (!prev || (prev.acrossFromBoard && !option.acrossFromBoard)) near.set(dep.tripInstanceId, option);
          continue;
        }
        const at = tripStopTimes(ds, dep)[alightIndex];
        if (!at) continue;
        const option: RescueOption = {
          dep, boardStopId: board.id, acrossFromBoard: board.id !== from.id,
          alightStopId: ids[alightIndex]!, acrossFromHome: ids[alightIndex] !== home.id,
          arrives: at.at, arrivesEstimated: at.estimated,
          sameLine: dep.route.id === usualRouteId, lastOnLine: false,
          ...(widerRouteIds.has(dep.route.id) ? { wider: true } : {}),
        };
        if (option.sameLine && dep.departs >= now - 60_000 && dep.departs <= now + LAST_SEARCH_MS + OVERNIGHT_GAP_MS) {
          const prevLine = line.get(dep.tripInstanceId);
          if (!prevLine || (prevLine.acrossFromBoard && !option.acrossFromBoard)) line.set(dep.tripInstanceId, option);
        }
        if (dep.departs < now - 60_000 || dep.departs > until) continue;
        // One entry per trip: prefer boarding at the rider's own stop over the one across the street.
        const prev = found.get(dep.tripInstanceId);
        if (!prev || (prev.acrossFromBoard && !option.acrossFromBoard)) found.set(dep.tripInstanceId, option);
      }
    }
  }

  // The last trip tonight is the one before the first overnight break: two hours or more with no
  // bus on the line, followed by a known trip. No break found (service continues, or the data ends):
  // nothing is called the last.
  const onLine = [...line.values()].sort((a, b) => a.dep.departs - b.dep.departs);
  // The break must span 3 AM local time: a sparse line's evening gap, or an early first trip followed by
  // a morning gap, is not the overnight break.
  const threeAmAfter = (at: number) => {
    const date = localYmd(at, tz);
    const [y, m, d] = parseYmd(date);
    const same = zonedWallTime(y, m, d, 3, 0, tz);
    if (at < same) return same;
    const [y2, m2, d2] = parseYmd(addDays(date, 1));
    return zonedWallTime(y2, m2, d2, 3, 0, tz);
  };
  const breakAt = onLine.findIndex((o, i) => {
    const next = onLine[i + 1];
    return !!next && o.dep.departs <= now + LAST_SEARCH_MS && next.dep.departs - o.dep.departs >= OVERNIGHT_GAP_MS
      && next.dep.departs > threeAmAfter(o.dep.departs);
  });
  const lastOnLine = breakAt >= 0 ? onLine[breakAt] : undefined;

  let options = [...found.values()].sort((a, b) => a.arrives - b.arrives || a.dep.departs - b.dep.departs).slice(0, limit);
  if (lastOnLine) {
    // A printed timetable has no holiday schedules: on a listed holiday the last trip is unconfirmed.
    const unconfirmed = !!ds.meta.transcribed && (isNjtHoliday(lastOnLine.dep.serviceDate) || isNjtHoliday(localYmd(lastOnLine.dep.departs, tz)));
    const last = { ...lastOnLine, lastOnLine: true, ...(unconfirmed ? { lastUnconfirmed: true } : {}) };
    options = options.some((o) => o.dep.tripInstanceId === last.dep.tripInstanceId)
      ? options.map((o) => (o.dep.tripInstanceId === last.dep.tripInstanceId ? { ...o, lastOnLine: true, ...(unconfirmed ? { lastUnconfirmed: true } : {}) } : o))
      : [...options, last];
  }
  const nearHome = [...near.values()].filter((o) => !found.has(o.dep.tripInstanceId))
    .sort((a, b) => a.arrives - b.arrives || a.straightLineM - b.straightLineM).slice(0, NEAR_HOME_LIMIT);
  return { ...base, options, nearHome };
}
