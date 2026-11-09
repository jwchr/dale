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
function mappedPoint(points, d) {
  if (d === undefined || d < points[0].measure || d > points.at(-1).measure) return;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].measure <= d) lo = mid; else hi = mid; }
  const a = points[lo], b = points[hi], span = b.measure - a.measure;
  if (span <= 0) return;
  const f = (d - a.measure) / span;
  return { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), m: a.m + f * (b.m - a.m) };
}
export function buildRouteGeometry(files, ds, sourceSHA256) {
  if (!/^[a-f0-9]{64}$/.test(sourceSHA256) || sourceSHA256.slice(0, 12) !== ds.meta.feedVersion) throw new Error('Geometry source mismatch');
  const output = { v: 1, feedVersion: ds.meta.feedVersion, sourceSHA256, shapes: Object.create(null), trips: Object.create(null) };
  if (!files['shapes.txt']) return output;
  const wantedTrips = new Map(ds.trips.map(t => [t.id, t])), patterns = new Map(ds.patterns.map(p => [p.id, p]));
  const trips = parseCsv(filterCsvByColumn(files['trips.txt'], 'trip_id', new Set(wantedTrips.keys())));
  const shapeIds = new Set(trips.map(t => t.shape_id).filter(safeId)), byShape = new Map();
  for (const row of parseCsv(filterCsvByColumn(files['shapes.txt'], 'shape_id', shapeIds))) {
    const list = byShape.get(row.shape_id) ?? []; list.push(row); byShape.set(row.shape_id, list);
  }
  if (byShape.size > 256 || trips.length > 2000) throw new Error('Geometry size limit');
  const normalized = new Map(); let totalPoints = 0;
  for (const [id, rows] of byShape) {
    rows.sort((a, b) => Number(a.shape_pt_sequence) - Number(b.shape_pt_sequence));
    const points = []; let valid = rows.length >= 2, previous = -1;
    for (const row of rows) {
      const lat = number(row.shape_pt_lat), lon = number(row.shape_pt_lon), measure = number(row.shape_dist_traveled), seq = number(row.shape_pt_sequence);
      if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180 || measure === undefined || measure < 0
        || seq === undefined || !Number.isInteger(seq) || seq <= previous) { valid = false; break; }
      const last = points.at(-1);
      if (last && measure <= last.measure) { valid = false; break; }
      points.push({ lat, lon, measure, m: last ? last.m + meters([last.lat, last.lon], [lat, lon]) : 0 }); previous = seq;
    }
    if (!valid || points.at(-1)?.m <= 0 || points.at(-1)?.m > 250000) continue;
    const compact = simplify(points.map(p => [p.lat, p.lon, p.m]));
    totalPoints += compact.length; if (totalPoints > 50000) throw new Error('Geometry size limit');
    normalized.set(id, { points, compact });
  }
  const stops = new Map(ds.stops.map(s => [s.id, s])), times = new Map();
  for (const row of parseCsv(filterCsvByColumn(files['stop_times.txt'], 'trip_id', new Set(wantedTrips.keys())))) {
    const list = times.get(row.trip_id) ?? []; list.push(row); times.set(row.trip_id, list);
  }
  const tripCounts = new Map();
  for (const t of trips) tripCounts.set(t.trip_id, (tripCounts.get(t.trip_id) ?? 0) + 1);
  for (const source of trips) {
    if (tripCounts.get(source.trip_id) !== 1) continue;
    if (!safeId(source.trip_id) || !safeId(source.shape_id)) continue;
    const shape = normalized.get(source.shape_id), trip = wantedTrips.get(source.trip_id), pattern = patterns.get(trip?.patternId);
    const calls = (times.get(source.trip_id) ?? []).sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    if (!shape || !pattern || calls.length !== pattern.stopIds.length || calls.length > 250) continue;
    const stopMeters = []; let previous = -1, previousSequence = -1, valid = true;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i], stop = stops.get(call.stop_id), point = mappedPoint(shape.points, number(call.shape_dist_traveled));
      const sequence = number(call.stop_sequence);
      if (sequence === undefined || !Number.isInteger(sequence) || sequence <= previousSequence || call.stop_id !== pattern.stopIds[i] || !point || stop?.lat === undefined || stop.lon === undefined
        || point.m < previous || meters([stop.lat, stop.lon], [point.lat, point.lon]) > 100) { valid = false; break; }
      stopMeters.push(round(point.m, 10)); previous = point.m; previousSequence = sequence;
    }
    if (!valid) continue;
    output.shapes[source.shape_id] = { points: shape.compact };
    output.trips[source.trip_id] = { shapeId: source.shape_id, stopIds: [...pattern.stopIds], stopMeters };
  }
  if (Buffer.byteLength(JSON.stringify(output)) > 4000000) throw new Error('Geometry size limit');
  return output;
}
