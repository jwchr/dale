// Validate JSON once at the loading boundary, before any screen trusts it as transit data.
// Invalid schedules go to the existing Retry flow; never repair times or substitute demo trips.
import { STOP_CITY_SOURCE } from './stopInfo.ts';
import type { Dataset } from './types';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const id = (v: unknown): v is string => text(v) && v.trim().length > 0;
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(id);
const optionalText = (v: unknown) => v === undefined || text(v);
function requireValid(ok: unknown): asserts ok {
  if (!ok) throw new Error('Invalid schedule dataset');
}
function rows(v: unknown): Record<string, unknown>[] {
  requireValid(Array.isArray(v) && v.length > 0 && v.every(record));
  return v;
}
function ids(items: Record<string, unknown>[]): Set<string> {
  const found = new Set<string>();
  for (const item of items) {
    requireValid(id(item.id) && !found.has(item.id));
    found.add(item.id);
  }
  return found;
}
function date(v: unknown): v is string {
  if (!text(v) || !/^\d{8}$/.test(v)) return false;
  const y = Number(v.slice(0, 4)), m = Number(v.slice(4, 6)), d = Number(v.slice(6, 8));
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}
const dates = (v: unknown) => Array.isArray(v) && v.every(date);

/** Throws on malformed data; preserves valid values, provenance and unknown extra fields unchanged. */
export function parseDataset(value: unknown): Dataset {
  requireValid(record(value) && record(value.meta));
  const meta = value.meta;
  requireValid(typeof meta.demo === 'boolean' && id(meta.source) && id(meta.feedVersion)
    && text(meta.builtAt) && Number.isFinite(Date.parse(meta.builtAt)) && id(meta.timezone));
  // Let the same browser Intl implementation used by the timetable check timezone support.
  new Intl.DateTimeFormat('en-US', { timeZone: meta.timezone }).format(0);
  if (meta.realtime !== undefined) requireValid(record(meta.realtime) && meta.realtime.provider === 'njt-bus-g2' && !meta.demo && meta.transcribed === undefined);
  if (meta.stopCities !== undefined) requireValid(record(meta.stopCities) && meta.stopCities.source === 'NJ Transit GIS Department' && meta.stopCities.url === STOP_CITY_SOURCE && text(meta.stopCities.retrievedAt) && Number.isFinite(Date.parse(meta.stopCities.retrievedAt)) && ['verified', 'unavailable'].includes(String(meta.stopCities.state)));
  if (meta.transcribed !== undefined) {
    requireValid(record(meta.transcribed) && date(meta.transcribed.issued) && id(meta.transcribed.documentId));
  }
  const routes = rows(value.routes), stops = rows(value.stops), patterns = rows(value.patterns), trips = rows(value.trips);
  const routeIds = ids(routes), stopIds = ids(stops);
  ids(patterns); ids(trips);
  for (const route of routes) {
    requireValid(id(route.shortName) && text(route.longName) && optionalText(route.color) && optionalText(route.feedRouteId));
  }
  for (const stop of stops) {
    requireValid(id(stop.name) && optionalText(stop.code) && optionalText(stop.noteId) && optionalText(stop.terminal) && optionalText(stop.city) && optionalText(stop.sourceName));
    requireValid(stop.twin === undefined || (id(stop.twin) && stopIds.has(stop.twin)));
    requireValid((stop.lat === undefined && stop.lon === undefined)
      || (typeof stop.lat === 'number' && Number.isFinite(stop.lat) && Math.abs(stop.lat) <= 90
        && typeof stop.lon === 'number' && Number.isFinite(stop.lon) && Math.abs(stop.lon) <= 180));
  }
  const patternLengths = new Map<string, number>();
  for (const pattern of patterns) {
    requireValid(id(pattern.routeId) && routeIds.has(pattern.routeId) && (pattern.directionId === 0 || pattern.directionId === 1)
      && text(pattern.headsign) && optionalText(pattern.variant) && strings(pattern.stopIds) && pattern.stopIds.length >= 2
      && pattern.stopIds.every((stopId) => stopIds.has(stopId)));
    for (const field of ['noPickup', 'noDropOff']) {
      requireValid(pattern[field] === undefined || (Array.isArray(pattern[field]) && pattern[field].every((i) => whole(i) && i < (pattern.stopIds as string[]).length)));
    }
    requireValid(pattern.stopSequences === undefined || (Array.isArray(pattern.stopSequences) && pattern.stopSequences.length === pattern.stopIds.length
      && pattern.stopSequences.every((n, i, a) => whole(n) && (i === 0 || n > a[i - 1]))));
    patternLengths.set(pattern.id as string, pattern.stopIds.length);
  }
  requireValid(record(value.calendars));
  const calendars = value.calendars;
  for (const [serviceId, calendar] of Object.entries(calendars)) {
    requireValid(id(serviceId) && record(calendar) && Array.isArray(calendar.days) && calendar.days.length === 7
      && calendar.days.every((day) => typeof day === 'boolean') && dates(calendar.added) && dates(calendar.removed));
    // The GTFS builder uses these sentinels for service defined solely by calendar_dates.txt.
    const exceptionsOnly = calendar.start === '99999999' && calendar.end === '00000000' && calendar.days.every((day) => !day);
    requireValid(exceptionsOnly || (date(calendar.start) && date(calendar.end) && calendar.start <= calendar.end));
  }
  for (const trip of trips) {
    requireValid(id(trip.patternId) && patternLengths.has(trip.patternId) && id(trip.serviceId) && Object.hasOwn(calendars, trip.serviceId));
    const times = trip.times;
    requireValid(Array.isArray(times) && times.length === patternLengths.get(trip.patternId)
      && times.every((at, i) => whole(at) && (i === 0 || at >= times[i - 1])
        && Number.isFinite(new Date(Date.UTC(9999, 11, 31) + at * 1000).getTime())));
    requireValid(trip.arrivals === undefined || (Array.isArray(trip.arrivals) && trip.arrivals.length === times.length
      && trip.arrivals.every((at, i) => at === null || (whole(at) && at <= times[i] && (i === 0 || at >= times[i - 1])
        && Number.isFinite(new Date(Date.UTC(9999, 11, 31) + at * 1000).getTime())))));
    requireValid(trip.estimated === undefined || (Array.isArray(trip.estimated)
      && trip.estimated.every((index) => whole(index) && index < times.length)));
  }
  if (value.publishedGates !== undefined) validateGates(value.publishedGates);
  if (value.publishedFares !== undefined) validateFares(value.publishedFares, stopIds);
  return value as unknown as Dataset;
}

function validateGates(v: unknown): void {
  requireValid(record(v) && id(v.source) && date(v.effective) && Array.isArray(v.rules));
  for (const rule of v.rules) {
    requireValid(record(rule) && id(rule.service) && id(rule.gate) && optionalText(rule.door)
      && Array.isArray(rule.dayTypes) && rule.dayTypes.length > 0
      && rule.dayTypes.every((day) => day === 'weekday' || day === 'saturday' || day === 'sunday'));
    requireValid((rule.fromMin === undefined && rule.toMin === undefined)
      || (whole(rule.fromMin) && rule.fromMin <= 1440 && whole(rule.toMin) && rule.toMin <= 1440));
  }
}

function validateFares(v: unknown, stopIds: Set<string>): void {
  requireValid(record(v) && id(v.source) && date(v.effective) && record(v.stopZones)
    && strings(v.newYorkStopIds) && v.newYorkStopIds.every((stopId) => stopIds.has(stopId)));
  for (const [stopId, zones] of Object.entries(v.stopZones)) {
    requireValid(stopIds.has(stopId) && Array.isArray(zones) && zones.length === 2
      && whole(zones[0]) && zones[0] > 0 && whole(zones[1]) && zones[1] >= zones[0]);
  }
  for (const table of [v.withinNewJersey, v.toFromNewYork]) {
    requireValid(record(table));
    for (const prices of [table.adult, table.reduced]) {
      requireValid(record(prices) && Object.entries(prices).every(([zone, cents]) => /^[1-9]\d*$/.test(zone) && whole(cents)));
    }
  }
}
