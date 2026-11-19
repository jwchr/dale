/** Town entry detection for Tour guide Welcome cards (#99). Pure logic, no UI, no storage, no network.
 * Entry is decided only from verified municipal borders (public/data/towns.json, US Census TIGER/Line)
 * and fresh, accurate, opt-in phone GPS fixes. A nearby stop's city label never proves entry.
 *
 * Hysteresis rule: an accepted fix is "deep" in a town when it is inside the town AND at least
 * BORDER_MARGIN_M from every border of that town. Entry into town B is confirmed only after
 * CONFIRM_FIXES consecutive accepted deep fixes in B spanning at least CONFIRM_SPAN_MS. Any accepted
 * fix that is not deep in the same town restarts the count. So GPS jitter at a border, or a bus
 * stopped near one, never confirms anything; a town narrower than twice the margin along the road
 * is never announced (accepted trade-off).
 * Repeat suppression: each town is announced at most once per ride state. The starting town is not an
 * entry: on the first accepted fix, every town within BORDER_MARGIN_M of it is marked as already seen. */

/** Fixes older than this (relative to `now`) are ignored. */
export const MAX_FIX_AGE_MS = 30_000;
/** Fixes with a reported accuracy worse (larger) than this are ignored. */
export const MAX_FIX_ACCURACY_M = 50;
/** Fixes stamped further in the future than this are ignored (clock skew guard). */
export const MAX_FUTURE_SKEW_MS = 5_000;
/** A fix must be at least this far inside a town's border to count toward entry. */
export const BORDER_MARGIN_M = 75;
/** Consecutive deep fixes needed to confirm entry. */
export const CONFIRM_FIXES = 2;
/** Minimum time between the first and last confirming fix. */
export const CONFIRM_SPAN_MS = 10_000;

/** [longitude, latitude] */
export type LonLat = [number, number];
/** Closed ring: first point repeated at the end. */
export type Ring = LonLat[];
/** [outer ring, ...holes] */
export type TownPolygon = Ring[];
export interface Town { geoid: string; name: string; polygons: TownPolygon[] }
export interface LocationFix { lat: number; lon: number; accuracyM: number; at: number }
export interface TownState {
  started: boolean;
  /** Time of the last accepted fix; older or equal fixes are ignored. */
  lastAt?: number;
  /** Last confirmed town (geoid). */
  current?: string;
  /** Towns already announced, or treated as the starting town. */
  announced: string[];
  candidate?: { geoid: string; firstAt: number; count: number };
}
export interface TownEnteredEvent { type: 'entered'; geoid: string; name: string }

export const initialTownState: TownState = { started: false, announced: [] };

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when the point is inside any of the town's polygons and not in one of that polygon's holes. */
export function pointInTown(lat: number, lon: number, town: Town): boolean {
  return town.polygons.some(([outer, ...holes]) => !!outer && inRing(lon, lat, outer) && !holes.some(h => inRing(lon, lat, h)));
}

/** Meters from the point to the nearest edge of any ring (outer or hole) of the town. */
export function distanceToBorderM(lat: number, lon: number, town: Town): number {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180), ky = 110_540;
  let best = Infinity;
  for (const polygon of town.polygons) for (const ring of polygon) for (let i = 1; i < ring.length; i++) {
    const [px, py] = ring[i - 1]!, [qx, qy] = ring[i]!;
    const ax = (px - lon) * kx, ay = (py - lat) * ky, bx = (qx - lon) * kx, by = (qy - lat) * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

export function townAt(lat: number, lon: number, towns: readonly Town[]): Town | undefined {
  return towns.find(t => pointInTown(lat, lon, t));
}

function acceptable(fix: LocationFix, state: TownState, now: number): boolean {
  const { lat, lon, accuracyM, at } = fix;
  return [lat, lon, accuracyM, at, now].every(Number.isFinite) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    && accuracyM >= 0 && accuracyM <= MAX_FIX_ACCURACY_M
    && now - at <= MAX_FIX_AGE_MS && at - now <= MAX_FUTURE_SKEW_MS
    && (state.lastAt === undefined || at > state.lastAt);
}

/** Advance the ride's town state with one GPS fix. Returns an event only for a confirmed, first-time entry. */
export function nextTownState(state: TownState, fix: LocationFix, towns: readonly Town[], now: number): { state: TownState; event?: TownEnteredEvent } {
  if (!acceptable(fix, state, now)) return { state };
  const { lat, lon, at } = fix;
  if (!state.started) {
    const near = towns.filter(t => pointInTown(lat, lon, t) || distanceToBorderM(lat, lon, t) < BORDER_MARGIN_M).map(t => t.geoid);
    const deep = towns.find(t => pointInTown(lat, lon, t) && distanceToBorderM(lat, lon, t) >= BORDER_MARGIN_M);
    return { state: { started: true, lastAt: at, current: deep?.geoid, announced: [...new Set([...state.announced, ...near])] } };
  }
  const deep = towns.find(t => pointInTown(lat, lon, t) && distanceToBorderM(lat, lon, t) >= BORDER_MARGIN_M);
  const base: TownState = { ...state, lastAt: at, candidate: undefined };
  if (!deep || deep.geoid === state.current) return { state: base };
  const candidate = state.candidate?.geoid === deep.geoid
    ? { ...state.candidate, count: state.candidate.count + 1 }
    : { geoid: deep.geoid, firstAt: at, count: 1 };
  if (candidate.count < CONFIRM_FIXES || at - candidate.firstAt < CONFIRM_SPAN_MS) return { state: { ...base, candidate } };
  if (state.announced.includes(deep.geoid)) return { state: { ...base, current: deep.geoid } };
  return {
    state: { ...base, current: deep.geoid, announced: [...state.announced, deep.geoid] },
    event: { type: 'entered', geoid: deep.geoid, name: deep.name },
  };
}

const isLonLat = (p: unknown): p is LonLat => Array.isArray(p) && p.length === 2
  && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0] as number) <= 180 && Math.abs(p[1] as number) <= 90;
const isRing = (r: unknown): r is Ring => Array.isArray(r) && r.length >= 4 && r.every(isLonLat)
  && r[0]![0] === r[r.length - 1]![0] && r[0]![1] === r[r.length - 1]![1];

/** Validates the bundled towns file; throws on any malformed town so a bad file is never half-used. */
export function parseTowns(json: unknown): Town[] {
  const towns = (json as { towns?: unknown })?.towns;
  if (!Array.isArray(towns) || towns.length === 0) throw new Error('Invalid towns file');
  return towns.map(t => {
    const { geoid, name, polygons } = (t ?? {}) as Record<string, unknown>;
    if (typeof geoid !== 'string' || !/^\d{10}$/.test(geoid) || typeof name !== 'string' || !name.trim()
      || !Array.isArray(polygons) || polygons.length === 0
      || !polygons.every(p => Array.isArray(p) && p.length > 0 && p.every(isRing))) throw new Error('Invalid town');
    return { geoid, name, polygons: polygons as TownPolygon[] };
  });
}
