// Pure same-input derivation. No authentication, network, files, recorder state or Dataset mutation.
import { parseCsv, filterCsvByColumn } from './gtfs-lib.mjs';
const meters = (a, b) => {
  const rad = Math.PI / 180, p = (b[0] - a[0]) * rad, q = (b[1] - a[1]) * rad;
  const x = Math.sin(p / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(q / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
};
const number = value => typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined;
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const round = (n, scale) => Math.round(n * scale) / scale;
function simplify(points) {
  const keep = new Set([0, points.length - 1]), stack = [[0, points.length - 1]];
  // Conservative local approximation: 4m threshold leaves rounding/projection margin below5m.
  const scaleY = 111195, scaleX = scaleY * Math.cos(points[0][0] * Math.PI / 180);
  while (stack.length) {
    const [lo, hi] = stack.pop(), a = points[lo], b = points[hi];
    const dx = (b[1] - a[1]) * scaleX, dy = (b[0] - a[0]) * scaleY, den = dx * dx + dy * dy;
    let maximum = 16, selected;
    for (let i = lo + 1; i < hi; i++) {
      const px = (points[i][1] - a[1]) * scaleX, py = (points[i][0] - a[0]) * scaleY;
      const t = den ? Math.max(0, Math.min(1, (px * dx + py * dy) / den)) : 0;
      const squared = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (squared > maximum) { maximum = squared; selected = i; }
    }
    if (selected !== undefined) { keep.add(selected); stack.push([lo, selected], [selected, hi]); }
  }
  // Retain original cumulative path length, not simplified chord lengths.
  return [...keep].sort((a, b) => a - b).map(i => [round(points[i][0], 1e6), round(points[i][1], 1e6), round(points[i][2], 10)]);
}
const near = (value, target, tolerance) => value >= target * (1 - tolerance) && value <= target * (1 + tolerance);
function shapeUnitEvidence(points, bump) {
  if (points[0].measure > 0) bump('shapeMeasureStartNonzero');
  const ratio = (points.at(-1).measure - points[0].measure) / points.at(-1).m;
  const unit = [['shapeUnitMeters', 1], ['shapeUnitFeet', 3.28084], ['shapeUnitKilometers', 0.001], ['shapeUnitMiles', 1 / 1609.344]]
    .find(([, target]) => near(ratio, target, 0.05));
  bump(unit ? unit[0] : 'shapeUnitOther');
}
// Nearest point on the whole shape line (local flat projection) and the shape measure there.
function nearestOnShape(points, stop) {
  const scaleY = 111195, scaleX = scaleY * Math.cos(stop.lat * Math.PI / 180);
  let best = Infinity, measure;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const ax = (a.lon - stop.lon) * scaleX, ay = (a.lat - stop.lat) * scaleY, dx = (b.lon - a.lon) * scaleX, dy = (b.lat - a.lat) * scaleY;
    const den = dx * dx + dy * dy, t = den ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / den)) : 0;
    const distance = Math.hypot(ax + t * dx, ay + t * dy);
    if (distance < best) { best = distance; measure = a.measure + t * (b.measure - a.measure); }
  }
  return { distance: best, measure };
}
const RATIOS = [['farRatioX1', 1], ['farRatioX3_281', 3.28084], ['farRatioX0_3048', 0.3048], ['farRatioX1000', 1000], ['farRatioX0_001', 0.001],
  ['farRatioX1609', 1609.344], ['farRatioX0_000621', 1 / 1609.344], ['farRatioX5280', 5280], ['farRatioX0_000189', 1 / 5280]];
// Aggregate evidence for a trip already rejected for tripStopDistance at call `failed`. Counts only; never changes output.
function stopDistanceEvidence(points, calls, stops, failed, bump) {
  bump(failed === 0 ? 'farFirstAtFirstStop' : failed === calls.length - 1 ? 'farFirstAtLastStop' : 'farFirstAtMiddleStop');
  const far = [], checked = [];
  for (let i = 0; i < calls.length; i++) {
    const stop = stops.get(calls[i].stop_id), measure = number(calls[i].shape_dist_traveled), point = mappedPoint(points, measure);
    if (!point || stop?.lat === undefined || stop.lon === undefined) continue;
    const distance = meters([stop.lat, stop.lon], [point.lat, point.lon]);
    checked.push(i);
    if (distance > 100) far.push(i);
    if (i === failed) bump(distance <= 250 ? 'farFirst100To250m' : distance <= 1000 ? 'farFirst250mTo1km' : distance <= 5000 ? 'farFirst1To5km' : 'farFirstOver5km');
  }
  const last = calls.length - 1, only = list => far.length === list.length && list.every(i => far.includes(i));
  bump(only([0]) ? 'farTripOnlyFirstStop' : only([last]) ? 'farTripOnlyLastStop' : only([0, last]) ? 'farTripOnlyFirstAndLastStops'
    : far.length * 2 > checked.length ? 'farTripMostStops' : 'farTripSomeStops');
  const stop = stops.get(calls[failed].stop_id), nearest = nearestOnShape(points, stop);
  if (nearest.distance > 100) { bump(nearest.distance <= 250 ? 'farFirstOffShapeLine100To250m' : 'farFirstOffShapeLineOver250m'); return; }
  bump('farFirstNearShapeLine');
  const measure = number(calls[failed].shape_dist_traveled), ratio = measure / nearest.measure;
  if (!(measure > 0) || !(nearest.measure > 0) || !Number.isFinite(ratio)) { bump('farRatioUnknown'); return; }
  const match = RATIOS.find(([, target]) => near(ratio, target, 0.1));
  bump(match ? match[0] : 'farRatioOther');
}
function mappedPoint(points, d) {
  if (d === undefined || d < points[0].measure || d > points.at(-1).measure) return;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].measure <= d) lo = mid; else hi = mid; }
  const a = points[lo], b = points[hi], span = b.measure - a.measure;
  if (span <= 0) return;
  const f = (d - a.measure) / span;
  return { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), m: a.m + f * (b.m - a.m) };
}
// Failure diagnostics for a public Actions log: one allowlisted reason plus fixed-key aggregate
// integers. Never IDs, coordinates, feed rows, error messages or ZIP bytes.
export const GEOMETRY_FAILURE_REASONS = Object.freeze(['source-mismatch', 'shape-limit', 'trip-limit', 'point-limit', 'byte-limit',
  'no-matched-trips', 'unexpected-exception']);
export const GEOMETRY_COUNT_KEYS = Object.freeze([
  'shapesFile', 'shapeMeasureColumn', 'tripShapeColumn', 'stopTimeMeasureColumn',
  'datasetTrips', 'sourceTripRows', 'requestedShapes', 'foundShapes', 'validShapes',
  'shapeTooFewPoints', 'shapeInvalidCoordinate', 'shapeInvalidMeasure', 'shapeInvalidSequence', 'shapeNonIncreasingMeasure', 'shapeLength',
  'tripDuplicate', 'tripUnsafeId', 'tripNoShape', 'tripNoPattern', 'tripCallCount',
  'tripInvalidSequence', 'tripStopMismatch', 'tripMissingMeasure', 'tripMeasureOutOfRange', 'tripStopCoordinates', 'tripBackward', 'tripStopDistance',
  'matchedTrips', 'outputShapes',
  // Unit evidence for each valid shape: its measure span divided by its own road length in meters, within 5%.
  'shapeUnitMeters', 'shapeUnitFeet', 'shapeUnitKilometers', 'shapeUnitMiles', 'shapeUnitOther', 'shapeMeasureStartNonzero',
  // Trips rejected for tripStopDistance only: where the first far stop is and how far it is from its mapped point.
  'farFirstAtFirstStop', 'farFirstAtLastStop', 'farFirstAtMiddleStop',
  'farFirst100To250m', 'farFirst250mTo1km', 'farFirst1To5km', 'farFirstOver5km',
  // Same trips: which of their stops are far from their mapped points (every call checked, output unaffected).
  'farTripOnlyFirstStop', 'farTripOnlyLastStop', 'farTripOnlyFirstAndLastStops', 'farTripMostStops', 'farTripSomeStops',
  // Same trips: the first far stop's distance to the nearest point anywhere on the shape line.
  'farFirstNearShapeLine', 'farFirstOffShapeLine100To250m', 'farFirstOffShapeLineOver250m',
  // Near the line only: its stop_times measure divided by the shape measure at that nearest point, within 10%.
  'farRatioX1', 'farRatioX3_281', 'farRatioX0_3048', 'farRatioX1000', 'farRatioX0_001',
  'farRatioX1609', 'farRatioX0_000621', 'farRatioX5280', 'farRatioX0_000189', 'farRatioOther', 'farRatioUnknown']);
const MAX_COUNT = 1_000_000;
export class GeometryError extends Error {
  constructor(reason, message, counts) {
    super(message);
    this.reason = GEOMETRY_FAILURE_REASONS.includes(reason) ? reason : 'unexpected-exception';
    this.counts = counts;
  }
}
// Header-only presence check; never throws and never reads beyond the first line.
function hasColumn(text, column) {
  if (typeof text !== 'string' || !text) return 0;
  const nl = text.indexOf('\n'), header = (nl < 0 ? text : text.slice(0, nl)).replace(/^﻿/, '').replace(/\r$/, '');
  return header.split(',').map(h => h.trim().replace(/^"|"$/g, '')).includes(column) ? 1 : 0;
}
// Fresh whitelist-only copy. Anything unexpected becomes the fixed unexpected reason with no counts.
export function geometryFailureDiagnostic(error) {
  const reason = error instanceof GeometryError ? error.reason : 'unexpected-exception';
  const source = error instanceof GeometryError ? error.counts : undefined, counts = {};
  for (const key of GEOMETRY_COUNT_KEYS) {
    const value = source?.[key];
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) return { v: 2, reason, counts: null };
    counts[key] = value;
  }
  return { v: 2, reason, counts };
}
export function buildRouteGeometry(files, ds, sourceSHA256) {
  return buildRouteGeometryWithReport(files, ds, sourceSHA256).geometry;
}
// Same derivation as before; `counts` only records why each shape/trip was or was not included.
export function buildRouteGeometryWithReport(files, ds, sourceSHA256) {
  const counts = Object.fromEntries(GEOMETRY_COUNT_KEYS.map(key => [key, 0]));
  const bump = key => { counts[key]++; };
  try {
    return { geometry: derive(files, ds, sourceSHA256, counts, bump), counts };
  } catch (error) {
    if (error instanceof GeometryError) throw error;
    throw new GeometryError('unexpected-exception', 'Geometry unexpected exception', counts);
  }
}
function derive(files, ds, sourceSHA256, counts, bump) {
  if (!/^[a-f0-9]{64}$/.test(sourceSHA256) || sourceSHA256.slice(0, 12) !== ds.meta.feedVersion) throw new GeometryError('source-mismatch', 'Geometry source mismatch', counts);
  const output = { v: 1, feedVersion: ds.meta.feedVersion, sourceSHA256, shapes: Object.create(null), trips: Object.create(null) };
  counts.shapesFile = files['shapes.txt'] ? 1 : 0;
  counts.shapeMeasureColumn = hasColumn(files['shapes.txt'], 'shape_dist_traveled');
  counts.tripShapeColumn = hasColumn(files['trips.txt'], 'shape_id');
  counts.stopTimeMeasureColumn = hasColumn(files['stop_times.txt'], 'shape_dist_traveled');
  counts.datasetTrips = ds.trips.length;
  if (!files['shapes.txt']) return output;
  const wantedTrips = new Map(ds.trips.map(t => [t.id, t])), patterns = new Map(ds.patterns.map(p => [p.id, p]));
  const trips = parseCsv(filterCsvByColumn(files['trips.txt'], 'trip_id', new Set(wantedTrips.keys())));
  const shapeIds = new Set(trips.map(t => t.shape_id).filter(safeId)), byShape = new Map();
  counts.sourceTripRows = trips.length; counts.requestedShapes = shapeIds.size;
  for (const row of parseCsv(filterCsvByColumn(files['shapes.txt'], 'shape_id', shapeIds))) {
    const list = byShape.get(row.shape_id) ?? []; list.push(row); byShape.set(row.shape_id, list);
  }
  counts.foundShapes = byShape.size;
  if (byShape.size > 256) throw new GeometryError('shape-limit', 'Geometry size limit', counts);
  if (trips.length > 2000) throw new GeometryError('trip-limit', 'Geometry size limit', counts);
  const normalized = new Map(); let totalPoints = 0;
  for (const [id, rows] of byShape) {
    rows.sort((a, b) => Number(a.shape_pt_sequence) - Number(b.shape_pt_sequence));
    const points = []; let rejected = rows.length >= 2 ? undefined : 'shapeTooFewPoints', previous = -1;
    for (const row of rejected ? [] : rows) {
      const lat = number(row.shape_pt_lat), lon = number(row.shape_pt_lon), measure = number(row.shape_dist_traveled), seq = number(row.shape_pt_sequence);
      if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) { rejected = 'shapeInvalidCoordinate'; break; }
      if (measure === undefined || measure < 0) { rejected = 'shapeInvalidMeasure'; break; }
      if (seq === undefined || !Number.isInteger(seq) || seq <= previous) { rejected = 'shapeInvalidSequence'; break; }
      const last = points.at(-1);
      if (last && measure <= last.measure) { rejected = 'shapeNonIncreasingMeasure'; break; }
      points.push({ lat, lon, measure, m: last ? last.m + meters([last.lat, last.lon], [lat, lon]) : 0 }); previous = seq;
    }
    if (rejected) { bump(rejected); continue; }
    if (points.at(-1)?.m <= 0 || points.at(-1)?.m > 250000) { bump('shapeLength'); continue; }
    shapeUnitEvidence(points, bump);
    const compact = simplify(points.map(p => [p.lat, p.lon, p.m]));
    totalPoints += compact.length; if (totalPoints > 50000) throw new GeometryError('point-limit', 'Geometry size limit', counts);
    normalized.set(id, { points, compact }); counts.validShapes = normalized.size;
  }
  const stops = new Map(ds.stops.map(s => [s.id, s])), times = new Map();
  for (const row of parseCsv(filterCsvByColumn(files['stop_times.txt'], 'trip_id', new Set(wantedTrips.keys())))) {
    const list = times.get(row.trip_id) ?? []; list.push(row); times.set(row.trip_id, list);
  }
  const tripCounts = new Map();
  for (const t of trips) tripCounts.set(t.trip_id, (tripCounts.get(t.trip_id) ?? 0) + 1);
  for (const source of trips) {
    if (tripCounts.get(source.trip_id) !== 1) { bump('tripDuplicate'); continue; }
    if (!safeId(source.trip_id) || !safeId(source.shape_id)) { bump('tripUnsafeId'); continue; }
    const shape = normalized.get(source.shape_id), trip = wantedTrips.get(source.trip_id), pattern = patterns.get(trip?.patternId);
    const calls = (times.get(source.trip_id) ?? []).sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    if (!shape) { bump('tripNoShape'); continue; }
    if (!pattern) { bump('tripNoPattern'); continue; }
    if (calls.length !== pattern.stopIds.length || calls.length > 250) { bump('tripCallCount'); continue; }
    const stopMeters = []; let previous = -1, previousSequence = -1, rejected, failed;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i], stop = stops.get(call.stop_id), measure = number(call.shape_dist_traveled), point = mappedPoint(shape.points, measure);
      const sequence = number(call.stop_sequence);
      if (sequence === undefined || !Number.isInteger(sequence) || sequence <= previousSequence) { rejected = 'tripInvalidSequence'; break; }
      if (call.stop_id !== pattern.stopIds[i]) { rejected = 'tripStopMismatch'; break; }
      if (measure === undefined) { rejected = 'tripMissingMeasure'; break; }
      if (!point) { rejected = 'tripMeasureOutOfRange'; break; }
      if (stop?.lat === undefined || stop.lon === undefined) { rejected = 'tripStopCoordinates'; break; }
      if (point.m < previous) { rejected = 'tripBackward'; break; }
      if (meters([stop.lat, stop.lon], [point.lat, point.lon]) > 100) { rejected = 'tripStopDistance'; failed = i; break; }
      stopMeters.push(round(point.m, 10)); previous = point.m; previousSequence = sequence;
    }
    if (rejected) { bump(rejected); if (rejected === 'tripStopDistance') stopDistanceEvidence(shape.points, calls, stops, failed, bump); continue; }
    output.shapes[source.shape_id] = { points: shape.compact };
    output.trips[source.trip_id] = { shapeId: source.shape_id, stopIds: [...pattern.stopIds], stopMeters };
    bump('matchedTrips');
  }
  counts.outputShapes = Object.keys(output.shapes).length;
  if (Buffer.byteLength(JSON.stringify(output)) > 4000000) throw new GeometryError('byte-limit', 'Geometry size limit', counts);
  return output;
}
