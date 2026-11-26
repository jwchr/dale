import { readFileSync } from 'node:fs';
import bindings from 'gtfs-realtime-bindings';
import { describe, expect, it } from 'vitest';
// @ts-expect-error pure ESM preparation helper
import { regionRouteIds } from '../../scripts/region-routes.mjs';
import { filterRegionRaw, readRegionRoutes, REGION_COUNTIES } from '../../worker/region-raw';
import { binaryFeed, vehicle, NOW } from '../helpers/liveBus';

const region = JSON.parse(readFileSync(new URL('../../data/regions/nj-four-counties.geojson', import.meta.url), 'utf8'));
function files(points: [string | number, string | number][]) {
  return {
    'routes.txt': 'route_id\n' + points.map((_, i) => `R${i}`).join('\n'),
    'trips.txt': 'route_id,trip_id\n' + points.map((_, i) => `R${i},T${i}`).join('\n'),
    'stops.txt': 'stop_id,stop_lat,stop_lon\n' + points.map(([lat, lon], i) => `S${i},${lat},${lon}`).join('\n'),
    'stop_times.txt': 'trip_id,stop_id\n' + points.map((_, i) => `T${i},S${i}`).join('\n'),
  };
}
const ring = (x: number, y: number, size: number) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];

describe('region GTFS route selection', () => {
  it.each([
    ['Union City', 40.766, -74.030, true], ['Newark Penn', 40.734, -74.164, true],
    ['Paterson', 40.917, -74.172, true], ['Hackensack', 40.886, -74.043, true],
    ['Morristown', 40.797, -74.481, false], ['Trenton', 40.22, -74.76, false],
    ['Manhattan', 40.757, -73.990, false],
  ])('checks the supplied Census boundary at %s', (_label, lat, lon, inside) => {
    expect(regionRouteIds(files([[lat, lon]]), region).routeIds).toEqual(inside ? ['R0'] : []);
  });
  it('keeps any trip serving one inside stop, joins exact IDs, sorts and deduplicates routes', () => {
    const f = files([[40.22, -74.76], [40.766, -74.030], [40.734, -74.164]]);
    f['routes.txt'] += '\nR1\nR10';
    f['trips.txt'] += '\nR10,extra';
    f['stop_times.txt'] += '\nT0,S1\nT0,S1\nextra,S2\nunknown,S1';
    expect(regionRouteIds(f, region)).toEqual({ routeIds: ['R0', 'R1', 'R10', 'R2'], report: { routes: 4, kept: 4, stops: 3, stopsInside: 2 } });
  });
  it('drops stops inside a hole, on its edge, or with missing/invalid coordinates', () => {
    const polygon = { type: 'Polygon', coordinates: [ring(0, 0, 10), ring(2, 2, 3)] };
    const f = files([[1, 1], [3, 3], [2, 3], ['', 1], ['bad', 1], ['Infinity', 1], [91, 1], [1, 181]]);
    expect(regionRouteIds(f, polygon)).toEqual({ routeIds: ['R0'], report: { routes: 8, kept: 1, stops: 8, stopsInside: 1 } });
  });
  it('supports separate MultiPolygon parts and their holes', () => {
    const multi = { type: 'MultiPolygon', coordinates: [[ring(0, 0, 10), ring(2, 2, 3)], [ring(20, 20, 5)]] };
    expect(regionRouteIds(files([[1, 1], [21, 21], [3, 3], [15, 15]]), multi).routeIds).toEqual(['R0', 'R1']);
  });
  it('returns zero for outside-only routes and rejects missing source files or malformed geometry', () => {
    expect(regionRouteIds(files([[40.22, -74.76]]), region).report.kept).toBe(0);
    expect(() => regionRouteIds({}, region)).toThrow();
    expect(() => regionRouteIds(files([[1, 1]]), { type: 'Point', coordinates: [1, 1] })).toThrow();
    // An unclosed ring (first position not repeated last) is malformed (CodeRabbit #294).
    expect(() => regionRouteIds(files([[40.22, -74.76]]), { type: 'Polygon', coordinates: [[[-75, 40], [-73, 40], [-73, 42], [-75, 42]]] })).toThrow('region-geometry');
  });
});

describe('region delivery and raw filtering', () => {
  const asset = { v: 1, feedVersion: 'fixture-live', counties: REGION_COUNTIES, routeIds: ['10'] };
  it.each([null, undefined, {}, { ...asset, v: 2 }, { ...asset, feedVersion: 'stale' },
    { ...asset, counties: ['Hudson'] }, { ...asset, routeIds: [] }, { ...asset, routeIds: [null] }])('rejects unavailable or mismatched assets (%j)', value => {
    expect(readRegionRoutes(value, 'fixture-live')).toBeNull();
  });
  it('reads exact route IDs from the matching static feed', () => {
    expect([...readRegionRoutes(asset, 'fixture-live')!]).toEqual(['10']);
  });
  it('drops alerts even when another field carries a kept route, and handles an empty result', async () => {
    const source = new Uint8Array(binaryFeed([{ id: 'alert', alert: {}, vehicle: vehicle() }, { id: 'unknown' }]));
    const result = await filterRegionRaw({ feed: 'getVehiclePositions', bytes: source, receivedAt: NOW }, new Set(['10']));
    expect(bindings.transit_realtime.FeedMessage.decode(result.bytes).entity).toHaveLength(0);
    expect(result.filtered).toMatchObject({ entities: 2, kept: 0, noRoute: 1 });
  });
  it('rejects malformed protobuf without returning raw bytes', async () => {
    await expect(filterRegionRaw({ feed: 'getVehiclePositions', bytes: new Uint8Array([0]), receivedAt: NOW }, new Set(['10']))).rejects.toThrow();
  });
});
