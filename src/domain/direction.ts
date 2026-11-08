import type { Dataset, Stop } from './types';

/** Great-circle distance in meters. */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

type Located = Stop & { lat: number; lon: number };
const located = (s: Stop): s is Located => typeof s.lat === 'number' && typeof s.lon === 'number';
/** Meters between two stops, or undefined when either has no coordinates (datasets from printed timetables). */
function metersBetween(a: Stop, b: Stop): number | undefined {
  return located(a) && located(b) ? Math.round(distanceM(a, b)) : undefined;
}
/** The opposite-direction stop at the same place, when the dataset says which it is (either stop may carry the link). */
export function twinOf(ds: Dataset, stop: Stop): Stop | undefined {
  return ds.stops.find((s) => s.id === stop.twin || (s.twin !== undefined && s.twin === stop.id));
}

/** Does any pattern serve `from` and later `to`? */
export function reaches(ds: Dataset, fromStopId: string, toStopId: string, routeIds?: string[]): boolean {
  return ds.patterns.some((p) => {
    if (routeIds && routeIds.length && !routeIds.includes(p.routeId)) return false;
    const i = p.stopIds.indexOf(fromStopId);
    const j = p.stopIds.indexOf(toStopId);
    return i >= 0 && j > i && !p.noPickup?.includes(i) && !p.noDropOff?.includes(j);
  });
}

export type DirectionCheck =
  | { ok: true }
  | { ok: false; reason: 'wrong-side'; useStop: Stop; /** Absent when the stops have no coordinates. */ distanceM?: number }
  | { ok: false; reason: 'not-served' };

/**
 * Wrong-direction guard. If buses at `stopId` never reach `toStopId`, look for a nearby stop
 * (normally across the street) whose buses do, so the rider is sent to the right side.
 */
export function checkDirection(
  ds: Dataset,
  stopId: string,
  toStopId: string,
  routeIds?: string[],
  radiusM = 250,
): DirectionCheck {
  if (reaches(ds, stopId, toStopId, routeIds)) return { ok: true };
  const here = ds.stops.find((s) => s.id === stopId);
  if (!here) return { ok: false, reason: 'not-served' };
  // A twin the dataset names is the stop across the street; trust it before guessing from distance.
  const twin = twinOf(ds, here);
  if (twin && reaches(ds, twin.id, toStopId, routeIds)) return { ok: false, reason: 'wrong-side', useStop: twin, distanceM: metersBetween(here, twin) };
  if (!located(here)) return { ok: false, reason: 'not-served' };
  const candidates = ds.stops
    .filter((s) => s.id !== stopId && located(s))
    .map((s) => ({ s, d: distanceM(here, s as Located) }))
    .filter(({ s, d }) => d <= radiusM && reaches(ds, s.id, toStopId, routeIds))
    .sort((a, b) => a.d - b.d);
  const best = candidates[0];
  return best ? { ok: false, reason: 'wrong-side', useStop: best.s, distanceM: Math.round(best.d) } : { ok: false, reason: 'not-served' };
}

/**
 * For a trip from `fromStopId` toward `toStopId`, the stop to get off at: `toStopId` itself if buses
 * reach it, else the nearest stop within `radiusM` of it that they do reach (the return-side twin of a
 * home stop across the street). Undefined if neither.
 */
export function alightingStopFor(ds: Dataset, fromStopId: string, toStopId: string, routeIds?: string[], radiusM = 250): Stop | undefined {
  const target = ds.stops.find((s) => s.id === toStopId);
  if (!target) return undefined;
  if (reaches(ds, fromStopId, toStopId, routeIds)) return target;
  const twin = twinOf(ds, target);
  if (twin && reaches(ds, fromStopId, twin.id, routeIds)) return twin;
  if (!located(target)) return undefined;
  return ds.stops
    .filter((s) => s.id !== toStopId && located(s) && reaches(ds, fromStopId, s.id, routeIds))
    .map((s) => ({ s, d: distanceM(target, s as Located) }))
    .filter(({ d }) => d <= radiusM)
    .sort((a, b) => a.d - b.d)[0]?.s;
}

/**
 * The return trip of a saved commute from `fromStopId` (home) to `toStopId` (work): board at the work
 * stop, or when no bus from there goes home, at the stop across the street (the named twin, or the nearest
 * one within `radiusM` when stops have coordinates); get off at home or its twin. Undefined if none works.
 */
export function returnLeg(ds: Dataset, fromStopId: string, toStopId: string, routeIds?: string[], radiusM = 250): { fromStopId: string; toStopId: string } | undefined {
  const work = ds.stops.find((s) => s.id === toStopId);
  if (!work) return undefined;
  const near = located(work)
    ? ds.stops
        .filter((s) => s.id !== work.id && located(s))
        .map((s) => ({ s, d: distanceM(work, s as Located) }))
        .filter(({ d }) => d <= radiusM)
        .sort((a, b) => a.d - b.d)
        .map(({ s }) => s)
    : [];
  for (const board of [work, twinOf(ds, work), ...near]) {
    if (!board) continue;
    const back = alightingStopFor(ds, board.id, fromStopId, routeIds, radiusM);
    if (back) return { fromStopId: board.id, toStopId: back.id };
  }
  return undefined;
}

/**
 * Case- and accent-insensitive stop search by name or exact stop code. An exact code ranks first, then
 * names that match without their direction label ("Westwood - ..." before "... (to Westwood)").
 */
export function searchStops(ds: Dataset, query: string, limit = 20): Stop[] {
  const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const q = norm(query.trim());
  if (!q) return [];
  const words = q.split(/\s+/);
  const rank = (s: Stop) => {
    if (s.code === query.trim()) return 0;
    const place = norm(s.name.replace(/\s*\(to [^)]*\)$/i, ''));
    if (words.every((w) => place.includes(w))) return 1;
    return words.every((w) => norm(s.name).includes(w)) ? 2 : 3;
  };
  return ds.stops
    .map((s) => ({ s, r: rank(s) }))
    .filter(({ r }) => r < 3)
    .sort((a, b) => a.r - b.r || a.s.name.localeCompare(b.s.name))
    .slice(0, limit)
    .map(({ s }) => s);
}

/**
 * Destinations to offer a rider at `stopId`: every stop a bus from here reaches, then those only reached
 * from the stop across the street, so the wrong-side guard can still point the rider over. Within each
 * group terminals come first, then the dataset's stop order (route order for a printed timetable).
 * Stops no bus from here or across the street reaches (a short trip the other way) are left out.
 */
export function destinationsFrom(ds: Dataset, stopId: string): Stop[] {
  const here = ds.stops.find(s => s.id === stopId);
  const nearby = new Set<string>();
  if (here) {
    const twin = twinOf(ds, here); if (twin) nearby.add(twin.id);
    if (located(here)) for (const s of ds.stops) if (s.id !== stopId && located(s) && distanceM(here, s) <= 250) nearby.add(s.id);
  }
  const direct = new Set<string>(), across = new Set<string>();
  // Compute downstream reachability once per boarding stop, instead of rescanning every pattern
  // and measuring every nearby stop again for every possible destination.
  for (const p of ds.patterns) for (const board of [stopId, ...nearby]) {
    const i = p.stopIds.indexOf(board);
    if (i < 0 || p.noPickup?.includes(i)) continue;
    const target = board === stopId ? direct : across;
    for (let j = i + 1; j < p.stopIds.length; j++) {
      const id = p.stopIds[j]!;
      if (p.stopIds.indexOf(id) === j && !p.noDropOff?.includes(j)) target.add(id);
    }
  }
  const group = (s: Stop) => s.id === stopId ? 2 : direct.has(s.id) ? 0 : across.has(s.id) ? 1 : 2;
  return ds.stops
    .map((s, i) => ({ s, i, g: group(s) }))
    .filter(({ g }) => g < 2)
    .sort((a, b) => a.g - b.g || Number(!!b.s.terminal) - Number(!!a.s.terminal) || a.i - b.i)
    .map(({ s }) => s);
}

/**
 * Stops a bus serves within `radiusM` (straight line) of a position, nearest first (issue #31).
 * A suggestion only: the rider confirms the stop, and the direction guard still applies. Stops without
 * coordinates (a printed timetable) never appear. The position is not kept by this function.
 */
export function nearbyStops(ds: Dataset, pos: { lat: number; lon: number }, radiusM = 500, limit = 6): { stop: Stop; distanceM: number }[] {
  const served = new Set(ds.patterns.flatMap((p) => p.stopIds.slice(0, -1).filter((_, i) => !p.noPickup?.includes(i))));
  return ds.stops
    .filter((s): s is Located => served.has(s.id) && located(s))
    .map((s) => ({ stop: s as Stop, distanceM: Math.round(distanceM(pos, s)) }))
    .filter((x) => x.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM || a.stop.name.localeCompare(b.stop.name))
    .slice(0, limit);
}

/** True when the dataset has stop coordinates, so a location-based suggestion can work at all. */
export const hasStopLocations = (ds: Dataset): boolean => ds.stops.some(located);

