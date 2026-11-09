import type { Dataset } from './types';
import type { VehicleObservation } from './lock';
import { isServiceActive } from './schedule';
import { distanceM } from './direction';
import { LIVE_MAX_AGE_MS, validServiceDate, validVehicleId } from './liveBus';

/** Derived delivery data, deliberately separate from the canonical archived Dataset. */
export interface RouteGeometry {
  v: 1; feedVersion: string; sourceSHA256: string;
  shapes: Record<string, { points: [number, number, number][] }>;
  trips: Record<string, { shapeId: string; stopIds: string[]; stopMeters: number[] }>;
}
export const MAX_GEOMETRY_BYTES = 4_000_000;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const safeId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128
  && !/[\u0000-\u001f\u007f]/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const stamp = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v > 0;
const fail = (): never => { throw new Error('Invalid route geometry'); };

/** All identity and size checks precede rider use. Unknown/mismatched geometry never repairs itself. */
export function parseRouteGeometry(raw: unknown, ds: Dataset): RouteGeometry {
  if (!object(raw) || raw.v !== 1 || raw.feedVersion !== ds.meta.feedVersion
    || typeof raw.sourceSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sourceSHA256)
    || raw.sourceSHA256.slice(0, 12) !== raw.feedVersion || !object(raw.shapes) || !object(raw.trips)) return fail();
  const shapes = Object.entries(raw.shapes), trips = Object.entries(raw.trips);
  if (shapes.length > 256 || trips.length > 2000) return fail();
  let totalPoints = 0;
  for (const [key, shape] of shapes) {
    if (!safeId(key) || !object(shape) || !Array.isArray(shape.points) || shape.points.length < 2) return fail();
    totalPoints += shape.points.length; if (totalPoints > 50_000) return fail();
    let previous = -1;
    for (const p of shape.points) {
      if (!Array.isArray(p) || p.length !== 3 || !finite(p[0]) || Math.abs(p[0]) > 90
        || !finite(p[1]) || Math.abs(p[1]) > 180 || !finite(p[2]) || p[2] < 0 || p[2] < previous || p[2] > 250_000) return fail();
      previous = p[2];
    }
    if (shape.points[0][2] !== 0 || previous <= 0) return fail();
  }
  const sourceTrips = new Map(ds.trips.map(t => [t.id, t])), patterns = new Map(ds.patterns.map(p => [p.id, p]));
  for (const [key, entry] of trips) {
    if (!safeId(key) || !object(entry) || !safeId(entry.shapeId) || !Object.hasOwn(raw.shapes, entry.shapeId)) return fail();
    const pattern = patterns.get(sourceTrips.get(key)?.patternId ?? '');
    if (!pattern || !Array.isArray(entry.stopIds) || !Array.isArray(entry.stopMeters)
      || entry.stopIds.length !== pattern.stopIds.length || entry.stopIds.length > 250
      || entry.stopMeters.length !== entry.stopIds.length) return fail();
    const shape = raw.shapes[entry.shapeId] as { points: [number, number, number][] };
    const end = shape.points.at(-1)![2]; let previous = -1;
    for (let i = 0; i < entry.stopIds.length; i++) {
      const m = entry.stopMeters[i];
      if (entry.stopIds[i] !== pattern.stopIds[i] || !finite(m) || m < 0 || m < previous || m > end + .1) return fail();
      previous = m;
    }
  }
  return raw as unknown as RouteGeometry;
}

export interface ReportedRouteDistance { meters: number; observedAt: number; stale: boolean }
const OFF_ROUTE_M = 100, TIE_MARGIN_M = 20, SEPARATE_PROGRESS_M = 100;
/** Project onto actual source road segments. Returned progress is observed, never timetable motion. */
function roadProgress(points: [number, number, number][], fix: VehicleObservation, anchor?: number): number | undefined {
  const scaleY = 111_195, scaleX = scaleY * Math.cos(fix.lat * Math.PI / 180);
  const candidates: { off: number; at: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const ax = (a[1] - fix.lon) * scaleX, ay = (a[0] - fix.lat) * scaleY;
    const dx = (b[1] - a[1]) * scaleX, dy = (b[0] - a[0]) * scaleY, denominator = dx * dx + dy * dy;
    const t = denominator > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denominator)) : 0;
    const off = Math.hypot(ax + t * dx, ay + t * dy), at = a[2] + t * (b[2] - a[2]);
    if (off <= OFF_ROUTE_M && (anchor === undefined || Math.abs(at - anchor) <= SEPARATE_PROGRESS_M)) candidates.push({ off, at });
  }
  if (!candidates.length) return;
  candidates.sort((a, b) => a.off - b.off);
  const best = candidates[0]!;
  if (candidates.some(p => p.off <= best.off + TIE_MARGIN_M && Math.abs(p.at - best.at) > SEPARATE_PROGRESS_M)) return;
  return best.at;
}

/** Caller retains only previously qualified official observations; receipt never replaces observedAt. */
export function reportedRouteDistance(ds: Dataset, geometry: RouteGeometry | undefined,
  tripId: string, serviceDate: string, targetIndex: number, fix: VehicleObservation | undefined,
  now: number, receivedAt: number, expectedVehicleId?: string): ReportedRouteDistance | undefined {
  if (ds.meta.demo || ds.meta.transcribed || ds.meta.realtime?.provider !== 'njt-bus-g2' || !validServiceDate(serviceDate)
    || !geometry || geometry.feedVersion !== ds.meta.feedVersion || !fix || fix.tripInstanceId !== `${tripId}@${serviceDate}`
    || !validVehicleId(fix.vehicleId)
    || (expectedVehicleId !== undefined && fix.vehicleId !== expectedVehicleId)
    || !stamp(now) || !stamp(receivedAt) || receivedAt > now + 30_000
    || !stamp(fix.observedAt) || fix.observedAt > receivedAt
    || !finite(fix.lat) || !finite(fix.lon) || Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180) return;
  const canonical = ds.trips.find(t => t.id === tripId);
  if (!canonical || !isServiceActive(ds.calendars[canonical.serviceId], serviceDate)) return;
  const trip = Object.hasOwn(geometry.trips, tripId) ? geometry.trips[tripId] : undefined;
  if (!trip || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= trip.stopIds.length) return;
  const shape = geometry.shapes[trip.shapeId]; if (!shape) return;
  let anchor: number | undefined;
  if (fix.stopCall) {
    const i = fix.stopCall.stopIndex, stop = ds.stops.find(s => s.id === trip.stopIds[i]);
    if (fix.stopCall.status !== 'stopped_at' || !Number.isInteger(i) || trip.stopIds[i] !== fix.stopCall.stopId
      || stop?.lat === undefined || stop.lon === undefined || distanceM(fix, { lat: stop.lat, lon: stop.lon }) > OFF_ROUTE_M) return;
    anchor = trip.stopMeters[i];
  }
  const at = roadProgress(shape.points, fix, anchor), target = trip.stopMeters[targetIndex];
  if (at === undefined || target === undefined || at > target + 50) return;
  return { meters: Math.max(0, target - at), observedAt: fix.observedAt,
    stale: Math.max(now, receivedAt) - fix.observedAt > LIVE_MAX_AGE_MS };
}
