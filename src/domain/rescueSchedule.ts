// The wider official schedule for "Get me home" (#32, built by scripts/rescue-schedule.mjs): routes
// that share a stop with the corridor, served by the Worker separately from the corridor schedule and
// loaded only when Rescue opens. It is validated here against the corridor schedule the app already has,
// and merged only for the rescue search. It never feeds the live poller, ride lock or history collector.
// Plain Node imports this file during deployment preparation, so its own runtime imports carry extensions.
import { parseDataset } from './dataset.ts';
import type { Dataset, DatasetMeta } from './types';

export const RESCUE_SCHEDULE_KIND = 'rescue-routes';
/** Uncompressed bytes. Larger files are not served (the Worker bundle and the phone download stay small). */
export const RESCUE_SCHEDULE_MAX_BYTES = 6_000_000;

export type OfficialFares =
  | { state: 'absent'; missing: string[]; unreadFareFiles?: string[] }
  | {
    state: 'present';
    source: string;
    /** GTFS zone_id per stop id, exactly as published. */
    stopZones: Record<string, string>;
    attributes: { fareId: string; price: string; currency: string; paymentMethod: number; transfers: number | null; transferDuration?: number }[];
    rules: { fareId: string; routeId?: string; originZone?: string; destinationZone?: string; containsZone?: string }[];
    stopsWithoutZone: number;
    unreadFareFiles?: string[];
  };

export interface RescueScheduleMeta extends DatasetMeta {
  rescue: { kind: typeof RESCUE_SCHEDULE_KIND; chosenBy: string; routes: { shortName: string; sharedStops: number }[]; skipped: { shortName: string; sharedStops: number; reason: string }[] };
}

export interface RescueSchedule extends Dataset {
  meta: RescueScheduleMeta;
  officialFares: OfficialFares;
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
function check(ok: unknown): asserts ok {
  if (!ok) throw new Error('Invalid rescue schedule');
}

function checkFares(v: unknown): void {
  check(record(v));
  if (v.state === 'absent') {
    check(texts(v.missing) && v.missing.length > 0 && (v.unreadFareFiles === undefined || texts(v.unreadFareFiles)));
    return;
  }
  check(v.state === 'present' && text(v.source) && record(v.stopZones) && Object.values(v.stopZones).every(text)
    && Array.isArray(v.attributes) && Array.isArray(v.rules) && Number.isSafeInteger(v.stopsWithoutZone));
  const fareIds = new Set<string>();
  for (const a of v.attributes) {
    check(record(a) && text(a.fareId) && typeof a.price === 'string' && /^\d+(\.\d+)?$/.test(a.price) && typeof a.currency === 'string' && /^[A-Z]{3}$/.test(a.currency)
      && (a.paymentMethod === 0 || a.paymentMethod === 1) && (a.transfers === null || [0, 1, 2].includes(a.transfers as number))
      && (a.transferDuration === undefined || Number.isSafeInteger(a.transferDuration)));
    fareIds.add(a.fareId);
  }
  check(v.rules.length > 0);
  for (const r of v.rules) {
    check(record(r) && text(r.fareId) && fareIds.has(r.fareId)
      && ['routeId', 'originZone', 'destinationZone', 'containsZone'].every((k) => r[k] === undefined || text(r[k])));
  }
}

/**
 * Throws unless `raw` is a wider schedule for exactly the corridor schedule's feed version, with no
 * route, pattern or trip that collides with the corridor's. A mismatch is never patched or merged.
 */
export function parseRescueSchedule(raw: unknown, corridor: Dataset): RescueSchedule {
  const ds = parseDataset(raw);
  const meta = ds.meta as Partial<RescueScheduleMeta>;
  check(record(meta.rescue) && meta.rescue.kind === RESCUE_SCHEDULE_KIND && !ds.meta.demo && ds.meta.transcribed === undefined && ds.meta.realtime === undefined);
  check(ds.meta.feedVersion === corridor.meta.feedVersion && ds.meta.timezone === corridor.meta.timezone);
  const taken = (ids: string[]) => new Set(ids);
  const routes = taken(corridor.routes.map((r) => r.id)), patterns = taken(corridor.patterns.map((p) => p.id)), trips = taken(corridor.trips.map((t) => t.id));
  check(ds.routes.every((r) => !routes.has(r.id)) && ds.patterns.every((p) => !patterns.has(p.id)) && ds.trips.every((t) => !trips.has(t.id)));
  // A shared stop must be the same place in both files.
  const corridorStops = new Map(corridor.stops.map((s) => [s.id, s]));
  check(ds.stops.every((s) => { const c = corridorStops.get(s.id); return !c || (c.lat === undefined || (c.lat === s.lat && c.lon === s.lon)); }));
  checkFares((raw as Record<string, unknown>).officialFares);
  return ds as RescueSchedule;
}

/**
 * The corridor schedule plus the wider routes, for the rescue search only. Corridor objects are kept
 * as they are (so a corridor departure is the same one the rest of the app uses); wider routes, stops,
 * patterns, trips and calendars are added. `widerRouteIds` says which routes came from the wider file.
 */
export function withRescueSchedule(ds: Dataset, extra: RescueSchedule | undefined): { ds: Dataset; widerRouteIds: Set<string> } {
  if (!extra) return { ds, widerRouteIds: new Set() };
  const stopIds = new Set(ds.stops.map((s) => s.id));
  const calendars = { ...extra.calendars, ...ds.calendars };
  return {
    ds: {
      ...ds,
      routes: [...ds.routes, ...extra.routes],
      stops: [...ds.stops, ...extra.stops.filter((s) => !stopIds.has(s.id))],
      patterns: [...ds.patterns, ...extra.patterns],
      trips: [...ds.trips, ...extra.trips],
      calendars,
    },
    widerRouteIds: new Set(extra.routes.map((r) => r.id)),
  };
}
