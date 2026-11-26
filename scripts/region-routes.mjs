import { parseCsv, filterCsvByColumn } from './gtfs-lib.mjs';

// Boundary points belong to the ring. A hole's boundary is excluded with its interior.
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
    if (Math.abs(cross) <= 1e-12 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx)
      && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return true;
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
function polygons(geojson) {
  const geometries = geojson.type === 'FeatureCollection' ? geojson.features.map(f => f.geometry)
    : geojson.type === 'Feature' ? [geojson.geometry] : [geojson];
  const result = geometries.flatMap(g => {
    if (g?.type === 'Polygon') return [g.coordinates];
    if (g?.type === 'MultiPolygon') return g.coordinates;
    throw new Error('region-geometry');
  });
  if (!result.length || result.some(p => !Array.isArray(p) || !p.length || p.some(r => !Array.isArray(r) || r.length < 4
    || r.some(c => !Array.isArray(c) || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1]))
    // GeoJSON rings repeat their first position last; an unclosed ring is malformed, not closed for it (CodeRabbit #294).
    || r[0][0] !== r.at(-1)[0] || r[0][1] !== r.at(-1)[1]))) throw new Error('region-geometry');
  return result;
}

/** Pure statewide GTFS join. Only aggregate counts leave the preparation log. */
export function regionRouteIds(files, geojson) {
  for (const name of ['routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt']) {
    if (typeof files[name] !== 'string' || !files[name].trim()) throw new Error('region-input');
  }
  const areas = polygons(geojson);
  const routes = new Set(parseCsv(files['routes.txt']).map(r => r.route_id).filter(Boolean));
  const stops = parseCsv(files['stops.txt']);
  const inside = new Set();
  for (const stop of stops) {
    if (!stop.stop_lat?.trim() || !stop.stop_lon?.trim()) continue;
    const y = Number(stop.stop_lat), x = Number(stop.stop_lon);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) continue;
    if (areas.some(([outer, ...holes]) => inRing(x, y, outer) && !holes.some(h => inRing(x, y, h)))) inside.add(stop.stop_id);
  }
  const trips = new Map(parseCsv(files['trips.txt']).map(t => [t.trip_id, t.route_id]));
  const kept = new Set();
  // Filter the large stop_times text before object parsing, as the rescue builder does.
  for (const st of parseCsv(filterCsvByColumn(files['stop_times.txt'], 'stop_id', inside))) {
    const route = trips.get(st.trip_id);
    if (routes.has(route)) kept.add(route);
  }
  const routeIds = [...kept].sort();
  return { routeIds, report: { routes: routes.size, kept: routeIds.length, stops: stops.length, stopsInside: inside.size } };
}
