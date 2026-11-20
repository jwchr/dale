// "How sure are we?" (#91): measured arrival patterns for one scheduled trip at one stop.
// Pure and deterministic. An arrival is exactly the backtest's rule (`observedArrivals`): the first official
// sample whose explicit stop call says the bus is stopped at that stop. Nothing here keeps or returns vehicle
// IDs, coordinates, trip IDs or per-trip rows; a cell holds only counts, a service-date set and three records.
import { MIN_HISTORY, observedArrivals, type ObservedArrival } from './etaBacktest';
import { isNjtHoliday } from './holidays';
import type { VehicleObservation } from './lock';
import { validServiceDate } from './liveBus';
import { isServiceActive, tripTimeAt } from './schedule';
import { weekdayIndex } from './time';
import type { Dataset, ServiceCalendar } from './types';

export type ServiceDayType = 'weekday' | 'saturday' | 'sunday';
export const DAY_TYPES: readonly ServiceDayType[] = ['weekday', 'saturday', 'sunday'];
export const CONFIDENCE_ROUTES: readonly string[] = ['163', '164', '165', '165T'];
/** Same abstain rule as the backtest: fewer measured days than this and the answer is "insufficient". */
export const MIN_CONFIDENCE_SAMPLES = MIN_HISTORY;
/** One-minute buckets cover 10 minutes early through 19 minutes late; both ends have an overflow bucket. */
export const EARLY_LIMIT_MINUTES = -10, LATE_LIMIT_MINUTES = 20;
export const BUCKET_COUNT = LATE_LIMIT_MINUTES - EARLY_LIMIT_MINUTES + 2;
/** Farther from the schedule than this is far more likely a mismatched trip than a real arrival: excluded, counted. */
export const MAX_EARLY_SECONDS = 3600, MAX_LATE_SECONDS = 3 * 3600;
/** Service-date bit 0. Collection began November 8, 2026, so no real arrival is earlier. */
const DATE_EPOCH = Date.UTC(2026, 0, 1), DAY_MS = 86_400_000, MAX_DAY_INDEX = 40_000;

/** One aggregate: route, direction, stop, the scheduled minute of the service day (may pass 24:00) and day type. */
export interface ConfidenceKey { route: string; direction: 0 | 1; stopId: string; schedMinute: number; dayType: ServiceDayType }
/** One measured arrival, already matched to its scheduled time. Internal: never returned by the endpoint. */
export interface ArrivalEvent { key: ConfidenceKey; serviceDate: string; arrivedAt: number; delaySeconds: number; windowSeconds?: number }
/** [seconds vs schedule, YYYYMMDD service date, arrival epoch ms]. */
export type RecordTuple = [number, string, number];
export interface ConfidenceCell {
  /** BUCKET_COUNT counts: [0] earlier than 10 min early, [1..30] one minute each from -10 to 19, [31] 20+ late. */
  c: number[];
  /** Hex bitmap of service dates already counted (dedupe): bit i is DATE_EPOCH + i days. */
  d: string;
  f: string; l: string;
  /** Latest (worst), closest to schedule (best), earliest. Ties keep the earlier arrival, so order never matters. */
  w: RecordTuple; b: RecordTuple; e: RecordTuple;
  /** [arrivals with an earlier bounding sample, total seconds of those bounding windows]. */
  u: [number, number];
}
export interface ConfidenceRow { v: 1; cells: Record<string, ConfidenceCell> }
export const emptyRow = (): ConfidenceRow => ({ v: 1, cells: {} });
export const cellId = (key: ConfidenceKey) => `${key.schedMinute}|${key.stopId}`;
export const rowId = (key: ConfidenceKey) => ({ route: key.route, direction: key.direction, dayType: key.dayType, hour: Math.floor(key.schedMinute / 60) });

const dayIndex = (ymd: string) => (Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) - DATE_EPOCH) / DAY_MS;
function hasDay(bits: string, i: number) {
  const at = i >> 2;
  return at < bits.length && ((parseInt(bits[at]!, 16) >> (i & 3)) & 1) === 1;
}
function withDay(bits: string, i: number) {
  const at = i >> 2, padded = bits.padEnd(at + 1, '0');
  return padded.slice(0, at) + (parseInt(padded[at]!, 16) | (1 << (i & 3))).toString(16) + padded.slice(at + 1);
}
export const bucketIndex = (delaySeconds: number) =>
  Math.min(BUCKET_COUNT - 1, Math.max(0, Math.floor(delaySeconds / 60) - EARLY_LIMIT_MINUTES + 1));

const calendarTypes = new WeakMap<ServiceCalendar, ServiceDayType | null>();
const typeOfWeekday = (i: number): ServiceDayType => (i < 5 ? 'weekday' : i === 5 ? 'saturday' : 'sunday');
/**
 * The day type as the schedule defines it: the trip's own service calendar. Weekly flags that are all Monday-Friday,
 * only Saturday or only Sunday decide it. A dates-only calendar (NJ Transit's feed style) takes the type of a strict
 * majority of its dates; one made only of NJ Transit holidays is Sunday-holiday service. Otherwise the service
 * date's own weekday decides.
 */
export function dayTypeOf(calendar: ServiceCalendar, serviceDate: string): ServiceDayType {
  let type = calendarTypes.get(calendar);
  if (type === undefined) {
    type = null;
    const flagged = calendar.days.map((on, i) => (on ? typeOfWeekday(i) : null)).filter((t): t is ServiceDayType => t !== null);
    if (flagged.length) type = flagged.every((t) => t === flagged[0]) ? flagged[0]! : null;
    else if (calendar.added.length) {
      if (calendar.added.every(isNjtHoliday)) type = 'sunday';
      else {
        const tally = new Map<ServiceDayType, number>();
        for (const date of calendar.added) { const t = typeOfWeekday(weekdayIndex(date)); tally.set(t, (tally.get(t) ?? 0) + 1); }
        for (const [t, n] of tally) if (n * 2 > calendar.added.length) type = t;
      }
    }
    calendarTypes.set(calendar, type);
  }
  return type ?? typeOfWeekday(weekdayIndex(serviceDate));
}

export type SkipReason = 'unknown-trip' | 'outside-corridor' | 'stop-mismatch' | 'inactive-date' | 'estimated-time' | 'implausible-delay';
/** Match each observed arrival to its scheduled time. Only NJ Transit's own times count, never Dale's estimates. */
export function arrivalEvents(ds: Dataset, arrivals: readonly ObservedArrival[]): { events: ArrivalEvent[]; skipped: Partial<Record<SkipReason, number>> } {
  const trips = new Map(ds.trips.map((t) => [t.id, t])), patterns = new Map(ds.patterns.map((p) => [p.id, p]));
  const routes = new Map(ds.routes.map((r) => [r.id, r]));
  const events: ArrivalEvent[] = [], skipped: Partial<Record<SkipReason, number>> = {};
  const skip = (reason: SkipReason) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  for (const a of arrivals) {
    const split = a.tripInstanceId.lastIndexOf('@'), trip = trips.get(a.tripInstanceId.slice(0, split));
    const serviceDate = a.tripInstanceId.slice(split + 1), pattern = trip && patterns.get(trip.patternId);
    const route = pattern && routes.get(pattern.routeId);
    if (split < 1 || !trip || !pattern || !route) { skip('unknown-trip'); continue; }
    if (!CONFIDENCE_ROUTES.includes(route.shortName)) { skip('outside-corridor'); continue; }
    if (pattern.stopIds[a.stopIndex] !== a.stopId) { skip('stop-mismatch'); continue; }
    const calendar = ds.calendars[trip.serviceId];
    if (!validServiceDate(serviceDate) || !calendar || !isServiceActive(calendar, serviceDate)) { skip('inactive-date'); continue; }
    const seconds = trip.times[a.stopIndex];
    if (seconds === undefined || !Number.isSafeInteger(seconds) || seconds < 0 || seconds >= 48 * 3600 || trip.estimated?.includes(a.stopIndex)) { skip('estimated-time'); continue; }
    const day = dayIndex(serviceDate);
    const delaySeconds = Math.round((a.observedAt - tripTimeAt(ds, trip, serviceDate, a.stopIndex)) / 1000);
    if (!(day >= 0 && day < MAX_DAY_INDEX) || delaySeconds < -MAX_EARLY_SECONDS || delaySeconds > MAX_LATE_SECONDS) { skip('implausible-delay'); continue; }
    const window = a.notBefore !== undefined ? Math.round((a.observedAt - a.notBefore) / 1000) : undefined;
    events.push({ key: { route: route.shortName, direction: pattern.directionId, stopId: a.stopId, schedMinute: Math.floor(seconds / 60), dayType: dayTypeOf(calendar, serviceDate) },
      serviceDate, arrivedAt: a.observedAt, delaySeconds, ...(window !== undefined && window >= 0 ? { windowSeconds: window } : {}) });
  }
  return { events, skipped };
}

/** The last explicit stop call per trip carried between folds, so a bus still stopped at a stop is not a new arrival. */
export type Continuity = Record<string, [number, string, number]>;
const CONTINUITY_MS = 30 * 60_000, MAX_CONTINUITY = 2000;
/**
 * Derive new arrival events from samples in time order, with the previous fold's continuity. The backtest's rule
 * decides arrivals; an arrival whose first stopped sample is a carried-over one was already counted before.
 */
export function deriveArrivals(ds: Dataset, samples: readonly VehicleObservation[], continuity: Continuity = {}) {
  const carried: VehicleObservation[] = Object.entries(continuity).map(([tripInstanceId, [observedAt, stopId, stopIndex]]) =>
    ({ tripInstanceId, vehicleId: '', observedAt, lat: 0, lon: 0, stopCall: { status: 'stopped_at', stopId, stopIndex } }));
  const fresh = new Set(samples.filter((s) => s.stopCall).map((s) => `${s.tripInstanceId}\u0000${s.observedAt}\u0000${s.stopCall!.stopIndex}`));
  const arrivals = observedArrivals([...carried, ...samples]).filter((a) => fresh.has(`${a.tripInstanceId}\u0000${a.observedAt}\u0000${a.stopIndex}`));
  const next: Continuity = { ...continuity };
  let newest = 0;
  for (const s of samples) {
    newest = Math.max(newest, s.observedAt);
    if (s.stopCall && s.observedAt >= (next[s.tripInstanceId]?.[0] ?? -Infinity)) next[s.tripInstanceId] = [s.observedAt, s.stopCall.stopId, s.stopCall.stopIndex];
  }
  const kept = Object.entries(next).filter(([, [at]]) => newest - at <= CONTINUITY_MS).sort((a, b) => b[1][0] - a[1][0]).slice(0, MAX_CONTINUITY);
  return { ...arrivalEvents(ds, arrivals), continuity: Object.fromEntries(kept) as Continuity };
}

const better = (a: RecordTuple, b: RecordTuple, score: (t: RecordTuple) => number) =>
  score(a) < score(b) || (score(a) === score(b) && a[2] < b[2]);
/** Has this cell already counted this service date? The same arrival seen twice, or replayed, counts once. */
export function alreadyCounted(cell: ConfidenceCell | undefined, serviceDate: string) {
  return !!cell && hasDay(cell.d, dayIndex(serviceDate));
}
/** Add one event to a cell (undefined = new). Returns the same cell object when the service date was already counted. */
export function addToCell(cell: ConfidenceCell | undefined, e: ArrivalEvent): ConfidenceCell {
  if (cell && alreadyCounted(cell, e.serviceDate)) return cell;
  const record: RecordTuple = [e.delaySeconds, e.serviceDate, e.arrivedAt];
  const next: ConfidenceCell = cell ? { ...cell, c: [...cell.c], u: [...cell.u] }
    : { c: Array<number>(BUCKET_COUNT).fill(0), d: '', f: e.serviceDate, l: e.serviceDate, w: record, b: record, e: record, u: [0, 0] };
  next.c[bucketIndex(e.delaySeconds)]!++;
  next.d = withDay(next.d, dayIndex(e.serviceDate));
  if (e.serviceDate < next.f) next.f = e.serviceDate;
  if (e.serviceDate > next.l) next.l = e.serviceDate;
  if (better(record, next.w, (t) => -t[0])) next.w = record;
  if (better(record, next.b, (t) => Math.abs(t[0]))) next.b = record;
  if (better(record, next.e, (t) => t[0])) next.e = record;
  if (e.windowSeconds !== undefined) next.u = [next.u[0] + 1, next.u[1] + e.windowSeconds];
  return next;
}

export interface ConfidenceBucket { fromMinute: number | null; toMinute: number | null; count: number }
export interface ConfidenceRecord { minutes: number; delaySeconds: number; serviceDate: string; arrivedAt: number }
export interface ConfidenceQueryEcho { route: string; direction: 0 | 1; stopId: string; scheduled: string; dayType: ServiceDayType }
export type ConfidenceAnswer =
  | { v: 1; state: 'insufficient'; samples: number; minimumSamples: number; query: ConfidenceQueryEcho }
  | { v: 1; state: 'ready'; samples: number; minimumSamples: number; query: ConfidenceQueryEcho; measurement: 'first-official-stopped-at-sample';
    source: string; firstServiceDate: string; lastServiceDate: string; oneMinute: ConfidenceBucket[]; fiveMinute: ConfidenceBucket[];
    worst: ConfidenceRecord; best: ConfidenceRecord; earliest: ConfidenceRecord;
    uncertainty: { boundedSamples: number; meanWindowSeconds: number | null } };

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const isoDate = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
const record = ([delaySeconds, serviceDate, arrivedAt]: RecordTuple): ConfidenceRecord =>
  ({ minutes: Math.trunc(delaySeconds / 60), delaySeconds, serviceDate: isoDate(serviceDate), arrivedAt });

/** The public answer: aggregate counts only, or "insufficient" below the minimum evidence. */
export function summarize(cell: ConfidenceCell | undefined, key: ConfidenceKey, source: string): ConfidenceAnswer {
  const query: ConfidenceQueryEcho = { route: key.route, direction: key.direction, stopId: key.stopId, scheduled: hhmm(key.schedMinute), dayType: key.dayType };
  const samples = cell ? cell.c.reduce((a, b) => a + b, 0) : 0;
  if (!cell || samples < MIN_CONFIDENCE_SAMPLES) return { v: 1, state: 'insufficient', samples, minimumSamples: MIN_CONFIDENCE_SAMPLES, query };
  const oneMinute = cell.c.map((count, i): ConfidenceBucket => ({
    fromMinute: i === 0 ? null : EARLY_LIMIT_MINUTES + i - 1, toMinute: i === BUCKET_COUNT - 1 ? null : EARLY_LIMIT_MINUTES + i, count }));
  const fiveMinute: ConfidenceBucket[] = [oneMinute[0]!];
  for (let from = EARLY_LIMIT_MINUTES; from < LATE_LIMIT_MINUTES; from += 5)
    fiveMinute.push({ fromMinute: from, toMinute: from + 5, count: cell.c.slice(from - EARLY_LIMIT_MINUTES + 1, from - EARLY_LIMIT_MINUTES + 6).reduce((a, b) => a + b, 0) });
  fiveMinute.push(oneMinute[BUCKET_COUNT - 1]!);
  return { v: 1, state: 'ready', samples, minimumSamples: MIN_CONFIDENCE_SAMPLES, query, measurement: 'first-official-stopped-at-sample', source,
    firstServiceDate: isoDate(cell.f), lastServiceDate: isoDate(cell.l), oneMinute, fiveMinute,
    worst: record(cell.w), best: record(cell.b), earliest: record(cell.e),
    uncertainty: { boundedSamples: cell.u[0], meanWindowSeconds: cell.u[0] ? Math.round(cell.u[1] / cell.u[0]) : null } };
}

const QUERY_KEYS = ['route', 'stop', 'dir', 'sched', 'day'];
/** Strict endpoint input: exactly route, stop, dir, sched (HH:MM of the service day) and day, each once. */
export function parseConfidenceQuery(params: URLSearchParams, ds: Dataset): ConfidenceKey | undefined {
  const keys = [...params.keys()];
  if (keys.length !== QUERY_KEYS.length || !QUERY_KEYS.every((k) => params.getAll(k).length === 1)) return;
  const route = params.get('route')!, stopId = params.get('stop')!, dir = params.get('dir')!, sched = params.get('sched')!, day = params.get('day')!;
  const time = /^([0-4][0-9]):([0-5][0-9])$/.exec(sched);
  if (!CONFIDENCE_ROUTES.includes(route) || (dir !== '0' && dir !== '1') || !time || Number(time[1]) >= 48
    || !(DAY_TYPES as readonly string[]).includes(day) || !/^[A-Za-z0-9_.:-]{1,64}$/.test(stopId)) return;
  const direction = Number(dir) as 0 | 1, routeIds = new Set(ds.routes.filter((r) => r.shortName === route).map((r) => r.id));
  if (!ds.patterns.some((p) => routeIds.has(p.routeId) && p.directionId === direction && p.stopIds.includes(stopId))) return;
  return { route, direction, stopId, schedMinute: Number(time[1]) * 60 + Number(time[2]), dayType: day as ServiceDayType };
}
