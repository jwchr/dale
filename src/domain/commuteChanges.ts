import { returnLeg } from './direction';
import { boardIndex, dropIndex } from './place';
import type { Favorite } from './favorites';
import { departuresOn, tripArrivalAt } from './schedule';
import { addDays, localYmd } from './time';
import type { Dataset } from './types';

export interface ChangedDeparture {
  direction: 'out' | 'back';
  route: string;
  departure: number;
  arrival?: number;
  estimated: boolean;
  stops: string[];
}
export interface CommuteChange {
  id: string;
  favoriteId: string;
  favoriteKey: string;
  fromVersion: string;
  toVersion: string;
  kind: 'timetable' | 'stops' | 'selection' | 'uncomparable';
  date?: string;
  before: ChangedDeparture[];
  after: ChangedDeparture[];
}
export interface CommuteChangeState {
  version: 1;
  baseline: Dataset;
  favoriteKeys: string[];
  notices: CommuteChange[];
}

export const officialSchedule = (ds: Dataset) => !ds.meta.demo && !ds.meta.transcribed && ds.meta.realtime?.provider === 'njt-bus-g2';
export const favoriteKey = (f: Favorite) => JSON.stringify([f.id, f.fromStopId, f.toStopId, [...f.routeIds].sort()]);

function coverage(ds: Dataset) {
  const used = new Set(ds.trips.map(t => t.serviceId));
  const dates = Object.entries(ds.calendars).filter(([id]) => used.has(id)).flatMap(([, cal]) =>
    [...(cal.days.some(Boolean) ? [cal.start, cal.end] : []), ...cal.added]).sort();
  return { start: dates[0], end: dates.at(-1) };
}

/** Reuse the app's exact pickup/drop-off, return-side, after-midnight and DST rules. */
function commuteDataset(ds: Dataset, f: Favorite) {
  const back = returnLeg(ds, f.fromStopId, f.toStopId, f.routeIds);
  const legs = [{ direction: 'out' as const, fromStopId: f.fromStopId, toStopId: f.toStopId },
    ...(back ? [{ direction: 'back' as const, ...back }] : [])];
  const patterns = ds.patterns.filter(p => (!f.routeIds.length || f.routeIds.includes(p.routeId)) && legs.some(leg => {
    const from = boardIndex(ds, p, leg.fromStopId), to = from < 0 ? -1 : dropIndex(ds, p, leg.toStopId, from + 1);
    return from >= 0 && to > from;
  }));
  const ids = new Set(patterns.map(p => p.id));
  return { ds: { ...ds, patterns, trips: ds.trips.filter(t => ids.has(t.patternId)) }, legs };
}
function dayRows(view: ReturnType<typeof commuteDataset>, f: Favorite, date: string, sharedStart: string, sharedEnd: string): ChangedDeparture[] {
  const trips = new Map(view.ds.trips.map(t => [t.id, t]));
  return view.legs.flatMap(leg => departuresOn(view.ds, { stopId: leg.fromStopId, toStopId: leg.toStopId, routeIds: f.routeIds, date })
    // On a weekly boundary, one file may not contain the preceding day's after-midnight trip.
    // Compare only service dates covered by both copies, rather than calling that a removed bus.
    .filter(d => d.serviceDate >= sharedStart && d.serviceDate <= sharedEnd)
    .map(d => {
      const to = dropIndex(view.ds, d.pattern, leg.toStopId, d.stopIndex + 1);
      const trip = trips.get(d.tripId)!;
      const arrival = tripArrivalAt(view.ds, trip, d.serviceDate, to);
      return { direction: leg.direction, route: d.route.shortName, departure: d.departs,
        ...(arrival === undefined ? {} : { arrival }), estimated: d.estimated,
        stops: d.pattern.stopIds.slice(d.stopIndex, to + 1) };
    })).sort((a, b) => a.departure - b.departure || a.direction.localeCompare(b.direction) || a.route.localeCompare(b.route));
}
const signature = (row: ChangedDeparture) => JSON.stringify(row);
function difference(a: ChangedDeparture[], b: ChangedDeparture[]) {
  const counts = new Map<string, number>();
  b.forEach(row => counts.set(signature(row), (counts.get(signature(row)) ?? 0) + 1));
  return a.filter(row => {
    const key = signature(row), n = counts.get(key) ?? 0;
    if (!n) return true;
    counts.set(key, n - 1); return false;
  });
}
const stopFacts = (ds: Dataset, id: string) => {
  const stop = ds.stops.find(s => s.id === id);
  return stop && JSON.stringify([stop.sourceName ?? stop.name, stop.code ?? null, stop.lat ?? null, stop.lon ?? null]);
};

/** Cancel provably identical trips before expanding calendar days. Weekly feeds mostly repeat the same buses. */
function removeUnchanged(a: ReturnType<typeof commuteDataset>, b: ReturnType<typeof commuteDataset>, start: string, end: string) {
  const keys = (view: typeof a) => {
    const patterns = new Map(view.ds.patterns.map(p => [p.id, p]));
    const routes = new Map(view.ds.routes.map(r => [r.id, r.shortName]));
    const calendars = new Map(Object.entries(view.ds.calendars).map(([id, cal]) => {
      const from = cal.start > start ? cal.start : start, through = cal.end < end ? cal.end : end;
      return [id, [cal.days.some(Boolean) && from <= through ? [from, through, cal.days] : null,
        cal.added.filter(d => d >= start && d <= end).sort(), cal.removed.filter(d => d >= start && d <= end).sort()]];
    }));
    return view.ds.trips.map(trip => {
      const p = patterns.get(trip.patternId)!;
      return JSON.stringify([view.legs, routes.get(p.routeId), p.stopIds, [...(p.noPickup ?? [])].sort(), [...(p.noDropOff ?? [])].sort(),
        trip.times, trip.arrivals ?? trip.times.map(() => null), [...(trip.estimated ?? [])].sort(), calendars.get(trip.serviceId)]);
    });
  };
  const oldKeys = keys(a), newKeys = keys(b);
  const unmatched = (view: typeof a, own: string[], other: string[]) => {
    const counts = new Map<string, number>();
    other.forEach(key => counts.set(key, (counts.get(key) ?? 0) + 1));
    const trips = view.ds.trips.filter((_, i) => {
      const key = own[i]!, count = counts.get(key) ?? 0;
      if (!count) return true;
      counts.set(key, count - 1); return false;
    });
    return { ...view, ds: { ...view.ds, trips } };
  };
  return [unmatched(a, oldKeys, newKeys), unmatched(b, newKeys, oldKeys)] as const;
}

/** First provable changed day within both loaded schedules, not an extrapolation beyond their calendars. */
export function compareCommute(old: Dataset, next: Dataset, favorite: Favorite, today: string): Omit<CommuteChange, 'id' | 'favoriteId' | 'favoriteKey' | 'fromVersion' | 'toVersion'> | undefined {
  if (!officialSchedule(old) || !officialSchedule(next) || old.meta.timezone !== next.meta.timezone || old.meta.feedVersion === next.meta.feedVersion) return undefined;
  const stops = [favorite.fromStopId, favorite.toStopId];
  if (stops.some(id => !old.stops.some(s => s.id === id))) return undefined; // No known old selection to compare.
  if (stops.some(id => !next.stops.some(s => s.id === id)) || favorite.routeIds.some(id => old.routes.some(r => r.id === id) && !next.routes.some(r => r.id === id))) {
    return { kind: 'selection', before: [], after: [] };
  }
  const a = coverage(old), b = coverage(next);
  const sharedStart = [a.start, b.start].filter((x): x is string => !!x).sort().at(-1)!;
  const from = [today, sharedStart ? addDays(sharedStart, -1) : today].sort().at(-1)!;
  const through = [a.end, b.end].filter((x): x is string => !!x).sort()[0];
  if (!a.start || !b.start || !a.end || !b.end || !through || through < sharedStart || addDays(through, 1) < from) return { kind: 'uncomparable', before: [], after: [] };
  // GTFS service can depart on the preceding local evening at spring-forward, or after midnight on the last day.
  const lastDepartureDay = addDays(through, 1);
  const [before, after] = removeUnchanged(commuteDataset(old, favorite), commuteDataset(next, favorite), sharedStart, through);
  // Same bounded year as the existing read-only schedule checker; weekly files normally cover much less.
  for (let date = from, days = 0; (before.ds.trips.length || after.ds.trips.length) && date <= lastDepartureDay && days <= 366; date = addDays(date, 1), days++) {
    const oldRows = dayRows(before, favorite, date, sharedStart, through), newRows = dayRows(after, favorite, date, sharedStart, through);
    const removed = difference(oldRows, newRows), added = difference(newRows, oldRows);
    if (removed.length || added.length) {
      const timesOnly = (rows: ChangedDeparture[]) => rows.map(row => ({ ...row, stops: [] }));
      if (!difference(timesOnly(oldRows), timesOnly(newRows)).length && !difference(timesOnly(newRows), timesOnly(oldRows)).length) {
        return { kind: 'stops', date, before: [], after: [] };
      }
      return { kind: 'timetable', date, before: removed, after: added };
    }
  }
  const endpoints = new Set([...before.legs, ...after.legs].flatMap(leg => [leg.fromStopId, leg.toStopId]));
  if ([...endpoints].some(id => stopFacts(old, id) !== stopFacts(next, id))) return { kind: 'stops', before: [], after: [] };
  if ((before.ds.trips.length || after.ds.trips.length) && lastDepartureDay > addDays(from, 366)) return { kind: 'uncomparable', before: [], after: [] };
  return undefined;
}

/** A single atomic state keeps baseline advancement and unread notices together. No timers dismiss notices. */
export function advanceCommuteChanges(previous: CommuteChangeState | undefined, ds: Dataset, favorites: Favorite[], now: number, observeSchedule = true): CommuteChangeState {
  const keys = favorites.map(favoriteKey).sort();
  const eligible = new Set(keys), seen = new Set(previous?.favoriteKeys);
  const notices = previous?.notices.filter(n => eligible.has(n.favoriteKey)) ?? [];
  // An offline copy or an already-open older tab must not roll the comparison baseline backward.
  if (previous && (!observeSchedule || Date.parse(ds.meta.builtAt) < Date.parse(previous.baseline.meta.builtAt))) {
    return { ...previous, favoriteKeys: keys, notices };
  }
  if (previous && officialSchedule(previous.baseline) && officialSchedule(ds) && previous.baseline.meta.timezone === ds.meta.timezone && previous.baseline.meta.feedVersion !== ds.meta.feedVersion) {
    for (const f of favorites) {
      const key = favoriteKey(f);
      if (!seen.has(key)) continue; // A new or edited saved trip has no rider-confirmed old baseline.
      const change = compareCommute(previous.baseline, ds, f, localYmd(now, ds.meta.timezone));
      if (!change) continue;
      const id = JSON.stringify([previous.baseline.meta.feedVersion, ds.meta.feedVersion, key]);
      if (!notices.some(n => n.id === id)) notices.push({ ...change, id, favoriteId: f.id, favoriteKey: key,
        fromVersion: previous.baseline.meta.feedVersion, toVersion: ds.meta.feedVersion });
    }
  }
  return { version: 1, baseline: ds, favoriteKeys: keys, notices };
}
