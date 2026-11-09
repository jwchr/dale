import { createRouter } from '../../worker/service';
import { loadRouteGeometry } from '../../src/domain/loadRouteGeometry';
import { describe, expect, it, vi } from 'vitest';
import { parseRouteGeometry, reportedRouteDistance, type RouteGeometry } from '../../src/domain/routeDistance';
import type { Dataset } from '../../src/domain/types';
import type { VehicleObservation } from '../../src/domain/lock';
import { distanceM } from '../../src/domain/direction';
import { historyContextKey } from '../../worker/history-journal';
// @ts-expect-error pure ESM build helper without declaration files
import { buildRouteGeometry } from '../../scripts/route-geometry.mjs';

const SHA = 'a'.repeat(64), VERSION = SHA.slice(0, 12), NOW = Date.UTC(2026, 10, 8, 12);
const A = { lat: 40, lon: -74 }, B = { lat: 40, lon: -73.99 }, C = { lat: 40.01, lon: -73.99 };
const AB = distanceM(A, B), BC = distanceM(B, C);
function fixture() {
  const ds: Dataset = {
    meta: { demo: false, source: 'Synthetic test only', timezone: 'America/New_York', feedVersion: VERSION, builtAt: '2026-11-08T00:00:00Z', realtime: { provider: 'njt-bus-g2' } },
    routes: [{ id: 'r', shortName: '165', longName: 'Synthetic test' }],
    stops: [{ id: 'A', name: 'A', ...A }, { id: 'B', name: 'B', ...B }, { id: 'C', name: 'C', ...C }],
    patterns: [{ id: 'p', routeId: 'r', directionId: 0, headsign: 'Synthetic', stopIds: ['A', 'B', 'C'] }],
    trips: [{ id: 'TripA', patternId: 'p', serviceId: 's', times: [0, 600, 1200] }, { id: 'TripB', patternId: 'p', serviceId: 's', times: [0, 600, 1400] }],
    calendars: { s: { days: [true, true, true, true, true, true, true], start: '20260101', end: '20261231', added: [], removed: [] } },
  };
  const geometry: RouteGeometry = { v: 1, feedVersion: VERSION, sourceSHA256: SHA,
    shapes: { ShapeA: { points: [[A.lat, A.lon, 0], [B.lat, B.lon, AB], [C.lat, C.lon, AB + BC]] },
      ShapeB: { points: [[A.lat, A.lon, 0], [B.lat, B.lon, AB], [40.02, C.lon, AB + 2 * BC], [C.lat, C.lon, AB + 3 * BC]] } },
    trips: { TripA: { shapeId: 'ShapeA', stopIds: ['A', 'B', 'C'], stopMeters: [0, AB, AB + BC] },
      TripB: { shapeId: 'ShapeB', stopIds: ['A', 'B', 'C'], stopMeters: [0, AB, AB + 3 * BC] } },
  };
  const fix: VehicleObservation = { tripInstanceId: 'TripA@20261108', vehicleId: 'synthetic-bus', observedAt: NOW - 10000, ...A };
  return { ds, geometry, fix };
}
function evaluate(f: ReturnType<typeof fixture>, now = NOW, receivedAt = NOW) {
  return reportedRouteDistance(f.ds, f.geometry, 'TripA', '20261108', 2, f.fix, now, receivedAt, 'synthetic-bus');
}

describe('reported route distance — locally drafted negative/edge contract cases', () => {
  it('uses road length, not the straight line, and never returns arrival/progress events', () => {
    const f = fixture(); parseRouteGeometry(f.geometry, f.ds); const result = evaluate(f)!;
    expect(result.meters).toBeCloseTo(AB + BC, 4); expect(result.meters).toBeGreaterThan(distanceM(A, C) * 1.3);
    expect(result).toEqual({ meters: result.meters, observedAt: f.fix.observedAt, stale: false });
  });
  it('rejects FeedB geometry despite identical trip/stop labels; Dataset and existing clocks remain untouched', () => {
    const f = fixture(), before = JSON.stringify(f.ds); f.geometry.feedVersion = 'b'.repeat(12);
    expect(() => parseRouteGeometry(f.geometry, f.ds)).toThrow(); expect(evaluate(f)).toBeUndefined(); expect(JSON.stringify(f.ds)).toBe(before);
  });
  it('uses the exact trip shape when two trips share the same stop pattern', () => {
    const f = fixture(); const first = evaluate(f)!;
    const second = reportedRouteDistance(f.ds, f.geometry, 'TripB', '20261108', 2, { ...f.fix, tripInstanceId: 'TripB@20261108' }, NOW, NOW)!;
    expect(second.meters - first.meters).toBeCloseTo(2 * BC, 4);
    delete f.geometry.trips.TripA; expect(evaluate(f)).toBeUndefined();
  });
  it('rejects a same-feed distant destination mapped to zero or to the wrong existing shape', () => {
    const f = fixture(); f.geometry.trips.TripA!.stopMeters = [0, 0, 0];
    expect(() => parseRouteGeometry(f.geometry, f.ds)).toThrow();
    expect(evaluate(f)).toBeUndefined();
    const other = fixture(); other.geometry.trips.TripA!.shapeId = 'ShapeB';
    other.geometry.trips.TripA!.stopMeters = [0, AB, AB + 2 * BC];
    expect(() => parseRouteGeometry(other.geometry, other.ds)).toThrow();
    expect(evaluate(other)).toBeUndefined();
  });
  it('freezes the observed numeric distance after120000ms despite newer receipt times', () => {
    const f = fixture(), first = evaluate(f)!; const boundary = f.fix.observedAt + 120000;
    expect(evaluate(f, boundary, boundary)?.stale).toBe(false);
    const stale = evaluate(f, boundary + 1, boundary + 1)!;
    expect(stale).toEqual({ meters: first.meters, observedAt: first.observedAt, stale: true });
    expect(evaluate(f, boundary + 60000, boundary + 60000)).toEqual(stale);
  });
  it('rejects ambiguous loops, and accepts only a qualified stopped-at anchor rather than arbitrary nearest progress', () => {
    const f = fixture(); f.ds.stops[2] = { id: 'C', name: 'C', ...A };
    f.geometry.shapes.ShapeA = { points: [[A.lat, A.lon, 0], [B.lat, B.lon, AB], [A.lat, A.lon, 2 * AB]] };
    f.geometry.trips.TripA!.stopMeters = [0, AB, 2 * AB]; expect(evaluate(f)).toBeUndefined();
    f.fix.stopCall = { status: 'stopped_at', stopId: 'A', stopIndex: 0 }; expect(evaluate(f)?.meters).toBeCloseTo(2 * AB);
    f.fix.stopCall = { status: 'stopped_at', stopId: 'B', stopIndex: 1 }; expect(evaluate(f)).toBeUndefined();
  });
  it('accepts valid repeated canonical stops on a loop, while requiring an explicit anchor to resolve the shared location', () => {
    const f = fixture(); f.ds.trips = [f.ds.trips[0]!]; f.ds.patterns[0]!.stopIds = ['A', 'B', 'A'];
    delete f.geometry.trips.TripB; delete f.geometry.shapes.ShapeB;
    f.geometry.shapes.ShapeA!.points = [[A.lat, A.lon, 0], [B.lat, B.lon, AB], [A.lat, A.lon, 2 * AB]];
    f.geometry.trips.TripA = { shapeId: 'ShapeA', stopIds: ['A', 'B', 'A'], stopMeters: [0, AB, 2 * AB] };
    expect(parseRouteGeometry(f.geometry, f.ds)).toBe(f.geometry);
    expect(evaluate(f)).toBeUndefined();
    f.fix.stopCall = { status: 'stopped_at', stopId: 'A', stopIndex: 0 }; expect(evaluate(f)?.meters).toBeCloseTo(2 * AB);
    f.fix.stopCall = { status: 'stopped_at', stopId: 'A', stopIndex: 2 }; expect(evaluate(f)?.meters).toBe(0);
  });
  it('rejects off-route, wrong-vehicle/date and future fixes without a new distance or bus replacement', () => {
    const f = fixture(), original = structuredClone(f.fix);
    f.fix = { ...original, lat: 40.3 }; expect(evaluate(f)).toBeUndefined();
    f.fix = { ...original, vehicleId: 'other-bus' }; expect(evaluate(f)).toBeUndefined();
    f.fix = { ...original, tripInstanceId: 'TripA@20261109' }; expect(evaluate(f)).toBeUndefined();
    f.fix = { ...original, observedAt: NOW + 1 }; expect(evaluate(f)).toBeUndefined();
    f.fix = { ...original, observedAt: NOW + 500 }; expect(evaluate(f, NOW, NOW + 500)?.stale).toBe(false);
    expect(evaluate(f, NOW, NOW + 30001)).toBeUndefined();
  });
  it.each(['identity', 'coordinates', 'meters', 'binding', 'stop-order', 'oversized'] as const)('rejects malformed or oversized geometry: %s', kind => {
    const f = fixture(); const raw: any = f.geometry;
    if (kind === 'identity') raw.sourceSHA256 = 'bad';
    if (kind === 'coordinates') raw.shapes.ShapeA.points[1][0] = 91;
    if (kind === 'meters') raw.shapes.ShapeA.points[1][2] = -1;
    if (kind === 'binding') raw.trips.TripA.shapeId = 'missing';
    if (kind === 'stop-order') raw.trips.TripA.stopIds.reverse();
    if (kind === 'oversized') raw.shapes.ShapeA.points = Array(50001).fill([40, -74, 0]);
    expect(() => parseRouteGeometry(raw, f.ds)).toThrow();
  });
});

function files() {
  return {
    'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\nr,s,TripA,Synthetic,0,ShapeA\nr,s,TripB,Synthetic,0,ShapeA\n',
    'shapes.txt': `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\nShapeA,${A.lat},${A.lon},1,0\nShapeA,${B.lat},${B.lon},2,17\nShapeA,${C.lat},${C.lon},3,35\n`,
    'stop_times.txt': 'trip_id,stop_id,stop_sequence,shape_dist_traveled\nTripA,A,1,0\nTripA,B,2,17\nTripA,C,3,35\nTripB,A,1,0\nTripB,B,2,17\nTripB,C,3,35\n',
  };
}
describe('same-fetch geometry preparation without recorder/context changes', () => {
  it('maps arbitrary provider units onto original metric road length and preserves canonical context bytes/hash', async () => {
    const f = fixture(), before = JSON.stringify(f.ds), hash = await historyContextKey(f.ds);
    const geometry = buildRouteGeometry(files(), f.ds, SHA); parseRouteGeometry(geometry, f.ds);
    expect(geometry.trips.TripA.stopMeters[1]).toBeCloseTo(AB, 0);
    expect(geometry.trips.TripA.stopMeters[2]).toBeCloseTo(AB + BC, 0);
    expect(JSON.stringify(f.ds)).toBe(before); expect(await historyContextKey(f.ds)).toBe(hash);
    expect(f.ds).not.toHaveProperty('shapes'); expect(f.ds).not.toHaveProperty('geometry');
  });
  it('does not relabel a different source ZIP or guess missing geometry', () => {
    const f = fixture(); expect(() => buildRouteGeometry(files(), f.ds, 'b'.repeat(64))).toThrow('source mismatch');
    expect(buildRouteGeometry({ ...files(), 'shapes.txt': undefined }, f.ds, SHA).trips).toEqual({});
  });
  it('omits a trip with out-of-range or nonmonotonic stop mapping, leaving all schedules intact', () => {
    const f = fixture(), input = files(); input['stop_times.txt'] = input['stop_times.txt'].replace('TripA,B,2,17', 'TripA,B,2,99');
    const result = buildRouteGeometry(input, f.ds, SHA); expect(result.trips.TripA).toBeUndefined(); expect(result.trips.TripB).toBeDefined();
    expect(f.ds.trips).toHaveLength(2);
  });
});

describe('separate static geometry delivery', () => {
  it('serves only exact-version geometry without touching the actor, schedule bytes or recorder context', async () => {
    const f = fixture(), original = JSON.stringify(f.ds), context = await historyContextKey(f.ds);
    const touch = vi.fn(() => { throw new Error('Actor must not be invoked'); });
    const env = { FEED: { idFromName: touch, get: touch }, NJT_API_USERNAME: 'unused', NJT_API_PASSWORD: 'unused' };
    const router = createRouter(f.ds, f.geometry), url = `https://dale-live.test.workers.dev/v1/geometry?feedVersion=${VERSION}`;
    const response = await router.fetch(new Request(url, { headers: { origin: 'https://jwchr.github.io' } }), env);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('max-age=300');
    expect(await response.json()).toEqual(f.geometry);
    expect((await router.fetch(new Request(url.replace(VERSION, 'other')), env)).status).toBe(409);
    expect((await router.fetch(new Request(url, { headers: { origin: 'https://evil.example' } }), env)).status).toBe(403);
    expect((await createRouter(f.ds).fetch(new Request(url), env)).status).toBe(404);
    const invalid = structuredClone(f.geometry); invalid.trips.TripA!.stopMeters = [0, 0, 0];
    const isolated = createRouter(f.ds, invalid);
    expect((await isolated.fetch(new Request(url), env)).status).toBe(404);
    expect(await (await isolated.fetch(new Request('https://dale-live.test.workers.dev/v1/schedule'), env)).text()).toBe(original);
    expect(await (await router.fetch(new Request('https://dale-live.test.workers.dev/v1/schedule'), env)).text()).toBe(original);
    expect(touch).not.toHaveBeenCalled(); expect(await historyContextKey(f.ds)).toBe(context);
  });
  it('bounds streamed delivery and rejects a different feed instead of adopting it', async () => {
    const f = fixture(), signal = new AbortController().signal;
    const net = vi.fn(async () => Response.json(f.geometry));
    expect(await loadRouteGeometry(f.ds, 'https://dale-live.test.workers.dev', signal, net)).toEqual(f.geometry);
    expect(net.mock.calls).toHaveLength(1);
    const mismatch = { ...f.geometry, feedVersion: 'wrong' };
    await expect(loadRouteGeometry(f.ds, 'https://dale-live.test.workers.dev', signal, async () => Response.json(mismatch))).rejects.toThrow();
    let cancelled = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4000001)); }, cancel() { cancelled = true; } });
    await expect(loadRouteGeometry(f.ds, 'https://dale-live.test.workers.dev', signal, async () => new Response(stream))).rejects.toThrow('oversized');
    expect(cancelled).toBe(true);
  });
});
