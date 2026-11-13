import { describe, expect, it } from 'vitest';
import type { Dataset } from '../../src/domain/types';
import baseline from '../fixtures/route-geometry-baseline.json';
import { distanceM } from '../../src/domain/direction';
import {
  buildRouteGeometry, buildRouteGeometryWithReport, GeometryError, geometryFailureDiagnostic,
  GEOMETRY_COUNT_KEYS, GEOMETRY_FAILURE_REASONS,
// @ts-expect-error pure ESM build helper without declaration files
} from '../../scripts/route-geometry.mjs';

// Synthetic only. Sentinel IDs and distinctive coordinates prove nothing identifying reaches the diagnostic.
const SHA = 'c'.repeat(64), VERSION = SHA.slice(0, 12);
const A = { lat: 40.123457, lon: -74.234567 }, B = { lat: 40.123457, lon: -74.224567 }, C = { lat: 40.133457, lon: -74.224567 };
const AB = distanceM(A, B), BC = distanceM(B, C);
const SECRETS = /PRIVTRIP|PRIVSHAPE|PRIVSTOP|PRIVPAT|40\.1|74\.2/;

function dataset(tripIds = ['PRIVTRIP_A', 'PRIVTRIP_B']): Dataset {
  return {
    meta: { demo: false, source: 'Synthetic test only', timezone: 'America/New_York', feedVersion: VERSION, builtAt: '2026-11-11T00:00:00Z', realtime: { provider: 'njt-bus-g2' } },
    routes: [{ id: 'r', shortName: '165', longName: 'Synthetic test' }],
    stops: [{ id: 'PRIVSTOP_A', name: 'A', ...A }, { id: 'PRIVSTOP_B', name: 'B', ...B }, { id: 'PRIVSTOP_C', name: 'C', ...C }],
    patterns: [{ id: 'PRIVPAT', routeId: 'r', directionId: 0, headsign: 'Synthetic', stopIds: ['PRIVSTOP_A', 'PRIVSTOP_B', 'PRIVSTOP_C'] }],
    trips: tripIds.map(id => ({ id, patternId: 'PRIVPAT', serviceId: 's', times: [0, 600, 1200] })),
    calendars: { s: { days: [true, true, true, true, true, true, true], start: '20260101', end: '20261231', added: [], removed: [] } },
  };
}
function files(): Record<string, string | undefined> {
  return {
    'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\nr,s,PRIVTRIP_A,Synthetic,0,PRIVSHAPE\nr,s,PRIVTRIP_B,Synthetic,0,PRIVSHAPE\n',
    'shapes.txt': `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\nPRIVSHAPE,${A.lat},${A.lon},1,0\nPRIVSHAPE,${B.lat},${B.lon},2,17\nPRIVSHAPE,${C.lat},${C.lon},3,35\n`,
    'stop_times.txt': 'trip_id,stop_id,stop_sequence,shape_dist_traveled\nPRIVTRIP_A,PRIVSTOP_A,1,0\nPRIVTRIP_A,PRIVSTOP_B,2,17\nPRIVTRIP_A,PRIVSTOP_C,3,35\nPRIVTRIP_B,PRIVSTOP_A,1,0\nPRIVTRIP_B,PRIVSTOP_B,2,17\nPRIVTRIP_B,PRIVSTOP_C,3,35\n',
  };
}
function failure(run: () => unknown) {
  try { run(); } catch (error) { return error as GeometryError; }
  throw new Error('expected a geometry failure');
}
function expectPrivate(diagnostic: unknown) {
  const text = JSON.stringify(diagnostic);
  expect(text).not.toMatch(SECRETS);
  expect(Object.keys(diagnostic as object)).toEqual(['v', 'reason', 'counts']);
}

type Case = [string, (f: Record<string, string | undefined>, ds: Dataset) => void, Record<string, number>];
const cases: Case[] = [
  ['stop times without a measure column', f => { f['stop_times.txt'] = f['stop_times.txt']!.replace(/,shape_dist_traveled|,(0|17|35)(?=\n)/g, ''); },
    { stopTimeMeasureColumn: 0, tripMissingMeasure: 2 }],
  ['shapes without a measure column', f => { f['shapes.txt'] = f['shapes.txt']!.replace(/,shape_dist_traveled|,(0|17|35)(?=\n)/g, ''); },
    { shapeMeasureColumn: 0, shapeInvalidMeasure: 1, validShapes: 0, tripNoShape: 2 }],
  ['no shapes file', f => { f['shapes.txt'] = undefined; }, { shapesFile: 0, sourceTripRows: 0 }],
  ['stop measure beyond the shape', f => { f['stop_times.txt'] = f['stop_times.txt']!.replace('PRIVTRIP_A,PRIVSTOP_B,2,17', 'PRIVTRIP_A,PRIVSTOP_B,2,99'); },
    { tripMeasureOutOfRange: 1, matchedTrips: 1 }],
  ['stop measure moving backward', f => { f['stop_times.txt'] = f['stop_times.txt']!.replace('PRIVTRIP_A,PRIVSTOP_C,3,35', 'PRIVTRIP_A,PRIVSTOP_C,3,5'); },
    { tripBackward: 1, matchedTrips: 1 }],
  // B moved onto C: on the shape line, but its measure (17) is about half the shape measure there (35).
  ['stop far from its mapped point', (_, ds) => { ds.stops[1]!.lat = B.lat + 0.01; }, { tripStopDistance: 2, matchedTrips: 0,
    farFirstAtMiddleStop: 2, farFirst1To5km: 2, farTripSomeStops: 2, farFirstNearShapeLine: 2, farRatioOther: 2 }],
  ['stop without coordinates', (_, ds) => { delete (ds.stops[1] as { lat?: number }).lat; }, { tripStopCoordinates: 2 }],
  ['stop order differing from the pattern', f => { f['stop_times.txt'] = f['stop_times.txt']!.replace('PRIVTRIP_B,PRIVSTOP_B,2,17', 'PRIVTRIP_B,PRIVSTOP_C,2,17'); },
    { tripStopMismatch: 1, matchedTrips: 1 }],
  ['missing stop call', f => { f['stop_times.txt'] = f['stop_times.txt']!.replace('PRIVTRIP_B,PRIVSTOP_C,3,35\n', ''); }, { tripCallCount: 1, matchedTrips: 1 }],
  ['duplicate trip row', f => { f['trips.txt'] += 'r,s,PRIVTRIP_B,Synthetic,0,PRIVSHAPE\n'; }, { sourceTripRows: 3, tripDuplicate: 2, matchedTrips: 1 }],
  ['unknown pattern', (_, ds) => { ds.trips[0]!.patternId = 'missing'; }, { tripNoPattern: 1, matchedTrips: 1 }],
  ['single-point shape', f => { f['shapes.txt'] = f['shapes.txt']!.split('\n').slice(0, 2).join('\n') + '\n'; }, { shapeTooFewPoints: 1, tripNoShape: 2 }],
  ['nonincreasing shape measure', f => { f['shapes.txt'] = f['shapes.txt']!.replace(',2,17', ',2,0'); }, { shapeNonIncreasingMeasure: 1, tripNoShape: 2 }],
  ['invalid shape coordinate', f => { f['shapes.txt'] = f['shapes.txt']!.replace(`${B.lat},`, '91,'); }, { shapeInvalidCoordinate: 1, tripNoShape: 2 }],
];

// Serialized output of the PREVIOUS builder (main bba7c06) for these exact inputs, generated once and checked in,
// so the unchanged-output contract is tested against an independent baseline, not this implementation.
const BASELINE = baseline as Record<string, string>;

describe('geometry builder report', () => {
  it('returns the same geometry as before plus fixed-key aggregate counts', () => {
    const { geometry, counts } = buildRouteGeometryWithReport(files(), dataset(), SHA);
    expect(geometry).toEqual(buildRouteGeometry(files(), dataset(), SHA));
    expect(JSON.stringify(geometry)).toBe(BASELINE.accepted);
    expect(Object.keys(geometry.trips)).toEqual(['PRIVTRIP_A', 'PRIVTRIP_B']);
    expect(geometry.trips.PRIVTRIP_A.stopMeters[2]).toBeCloseTo(AB + BC, 0);
    expect(Object.keys(counts)).toEqual([...GEOMETRY_COUNT_KEYS]);
    expect(counts).toMatchObject({ shapesFile: 1, shapeMeasureColumn: 1, tripShapeColumn: 1, stopTimeMeasureColumn: 1,
      datasetTrips: 2, sourceTripRows: 2, requestedShapes: 1, foundShapes: 1, validShapes: 1, matchedTrips: 2, outputShapes: 1,
      shapeUnitOther: 1, shapeUnitMeters: 0, shapeMeasureStartNonzero: 0, farFirstAtFirstStop: 0, farFirstNearShapeLine: 0 });
    expect(JSON.stringify(geometry)).not.toContain('matchedTrips');
  });

  it.each(cases)('counts %s without changing what is included', (name, mutate, expected) => {
    const f = files(), ds = dataset(); mutate(f, ds);
    const before = JSON.stringify(ds), { geometry, counts } = buildRouteGeometryWithReport(f, ds, SHA);
    expect(geometry).toEqual(buildRouteGeometry(f, ds, SHA));
    expect(JSON.stringify(geometry)).toBe(BASELINE[name]);
    expect(counts).toMatchObject(expected);
    expect(Object.keys(geometry.trips)).toHaveLength(counts.matchedTrips);
    expect(JSON.stringify(ds)).toBe(before);
    expectPrivate(geometryFailureDiagnostic(new GeometryError('no-matched-trips', 'x', counts)));
  });
});

// Shape and stop_times measures rewritten together; stop coordinates and road lengths stay the same.
function measures(f: Record<string, string | undefined>, shape: number[], stop: number[]) {
  const [s0, s1, s2] = shape.map(String), [t0, t1, t2] = stop.map(String);
  f['shapes.txt'] = `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\nPRIVSHAPE,${A.lat},${A.lon},1,${s0}\nPRIVSHAPE,${B.lat},${B.lon},2,${s1}\nPRIVSHAPE,${C.lat},${C.lon},3,${s2}\n`;
  f['stop_times.txt'] = 'trip_id,stop_id,stop_sequence,shape_dist_traveled\n' + ['PRIVTRIP_A', 'PRIVTRIP_B']
    .map(t => `${t},PRIVSTOP_A,1,${t0}\n${t},PRIVSTOP_B,2,${t1}\n${t},PRIVSTOP_C,3,${t2}\n`).join('');
}
const MILE = 1609.344;
const far: [string, (f: Record<string, string | undefined>, ds: Dataset) => void, Record<string, number>][] = [
  ['a Port Authority-style first stop beside the start of the shape', (_, ds) => { ds.stops[0]!.lat = A.lat + 0.00135; },
    { tripStopDistance: 2, farFirstAtFirstStop: 2, farFirst100To250m: 2, farTripOnlyFirstStop: 2, farFirstOffShapeLine100To250m: 2, farFirstNearShapeLine: 0 }],
  ['first and last stops beside the shape ends', (_, ds) => { ds.stops[0]!.lat = A.lat + 0.00135; ds.stops[2]!.lon = C.lon + 0.0018; },
    { tripStopDistance: 2, farFirstAtFirstStop: 2, farTripOnlyFirstAndLastStops: 2, farFirstOffShapeLine100To250m: 2 }],
  ['a last stop beyond the end of the shape', (_, ds) => { ds.stops[2]!.lat = C.lat + 0.01; },
    { tripStopDistance: 2, farFirstAtLastStop: 2, farFirst1To5km: 2, farTripOnlyLastStop: 2, farFirstOffShapeLineOver250m: 2 }],
  ['shape measures in meters and stop measures in miles', f => measures(f, [0, AB, AB + BC], [0, AB / MILE, (AB + BC) / MILE]),
    { shapeUnitMeters: 1, tripStopDistance: 2, farFirstAtMiddleStop: 2, farFirst250mTo1km: 2, farTripMostStops: 2, farFirstNearShapeLine: 2, farRatioX0_000621: 2 }],
  ['shape measures in miles and stop measures in feet', f => measures(f, [0, AB / MILE, (AB + BC) / MILE], [0, AB / MILE * 5280, (AB + BC) / MILE * 5280]),
    { shapeUnitMiles: 1, tripMeasureOutOfRange: 2, tripStopDistance: 0, farFirstNearShapeLine: 0 }],
  ['a shape whose measure starts above zero', f => measures(f, [5, 22, 40], [5, 22, 40]), { shapeMeasureStartNonzero: 1, matchedTrips: 2 }],
];

describe('stop distance evidence', () => {
  it.each(far)('counts %s without changing what is included', (_, mutate, expected) => {
    const f = files(), ds = dataset(); mutate(f, ds);
    const { geometry, counts } = buildRouteGeometryWithReport(f, ds, SHA);
    expect(geometry).toEqual(buildRouteGeometry(f, ds, SHA));
    expect(counts).toMatchObject(expected);
    expect(Object.keys(geometry.trips)).toHaveLength(counts.matchedTrips);
    expectPrivate(geometryFailureDiagnostic(new GeometryError('no-matched-trips', 'x', counts)));
  });
  it('reads each unit from the shape itself and keeps the same accepted output', () => {
    for (const [scale, key] of [[1, 'shapeUnitMeters'], [3.28084, 'shapeUnitFeet'], [0.001, 'shapeUnitKilometers'], [1 / MILE, 'shapeUnitMiles']] as const) {
      const f = files(), values = [0, AB * scale, (AB + BC) * scale]; measures(f, values, values);
      const { geometry, counts } = buildRouteGeometryWithReport(f, dataset(), SHA);
      expect(counts[key]).toBe(1); expect(counts.shapeUnitOther).toBe(0); expect(counts.matchedTrips).toBe(2);
      expect(JSON.stringify(geometry)).toBe(BASELINE.accepted);
    }
  });
  it('splits every rejected trip into exactly one bucket of each kind', () => {
    for (const [, mutate] of far) {
      const f = files(), ds = dataset(); mutate(f, ds);
      const { counts } = buildRouteGeometryWithReport(f, ds, SHA), sum = (prefix: string) =>
        GEOMETRY_COUNT_KEYS.filter((k: string) => k.startsWith(prefix)).reduce((n: number, k: string) => n + counts[k], 0);
      expect(sum('farFirstAt')).toBe(counts.tripStopDistance);
      expect(sum('farFirst') - sum('farFirstAt') - sum('farFirstNear') - sum('farFirstOff')).toBe(counts.tripStopDistance);
      expect(sum('farTrip')).toBe(counts.tripStopDistance);
      expect(sum('farFirstNear') + sum('farFirstOff')).toBe(counts.tripStopDistance);
      expect(sum('farRatio')).toBe(counts.farFirstNearShapeLine);
      expect(sum('shapeUnit')).toBe(counts.validShapes);
    }
  });
});

describe('geometry failure reasons', () => {
  it('types a source mismatch and keeps its original message', () => {
    const error = failure(() => buildRouteGeometryWithReport(files(), dataset(), 'd'.repeat(64)));
    expect(error).toBeInstanceOf(GeometryError); expect(error.message).toContain('source mismatch');
    expect(geometryFailureDiagnostic(error).reason).toBe('source-mismatch');
  });
  it('types the trip and shape size limits with counts gathered so far', () => {
    const ids = Array.from({ length: 2001 }, (_, i) => `PRIVTRIP_${i}`), f = files();
    f['trips.txt'] = 'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n' + ids.map(id => `r,s,${id},Synthetic,0,PRIVSHAPE\n`).join('');
    const trip = geometryFailureDiagnostic(failure(() => buildRouteGeometryWithReport(f, dataset(ids), SHA)));
    expect(trip).toMatchObject({ reason: 'trip-limit', counts: { datasetTrips: 2001, sourceTripRows: 2001, foundShapes: 1 } }); expectPrivate(trip);

    const many = Array.from({ length: 257 }, (_, i) => `PRIVTRIP_${i}`), g = files();
    g['trips.txt'] = 'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n' + many.map((id, i) => `r,s,${id},Synthetic,0,PRIVSHAPE${i}\n`).join('');
    g['shapes.txt'] = 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\n' + many.map((_, i) => `PRIVSHAPE${i},${A.lat},${A.lon},1,0\nPRIVSHAPE${i},${B.lat},${B.lon},2,1\n`).join('');
    const shape = geometryFailureDiagnostic(failure(() => buildRouteGeometryWithReport(g, dataset(many), SHA)));
    expect(shape).toMatchObject({ reason: 'shape-limit', counts: { requestedShapes: 257, foundShapes: 257 } }); expectPrivate(shape);
  });
  it('keeps the count of shapes completed before the point limit stops the build', () => {
    // 251 zigzag shapes of 202 points, 200 retained after simplification: 250 fit exactly within 50,000 points, the 251st exceeds it.
    const ids = Array.from({ length: 251 }, (_, i) => `PRIVTRIP_${i}`), f = files();
    f['trips.txt'] = 'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n' + ids.map((id, i) => `r,s,${id},Synthetic,0,PRIVSHAPE${i}\n`).join('');
    f['shapes.txt'] = 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\n' + ids.map((_, i) => Array.from({ length: 202 }, (_, k) =>
      `PRIVSHAPE${i},${(A.lat + k * 0.00001).toFixed(6)},${(A.lon + (k % 2) * 0.0002).toFixed(6)},${k + 1},${k}\n`).join('')).join('');
    const diagnostic = geometryFailureDiagnostic(failure(() => buildRouteGeometryWithReport(f, dataset(ids), SHA)));
    expect(diagnostic).toMatchObject({ reason: 'point-limit', counts: { requestedShapes: 251, foundShapes: 251, validShapes: 250 } }); expectPrivate(diagnostic);
  });
  it('wraps an internal exception without its message (which can name columns)', () => {
    const f = files(); f['trips.txt'] = 'route_id,service_id,PRIVTRIP_COLUMN,shape_id\n';
    const error = failure(() => buildRouteGeometryWithReport(f, dataset(), SHA));
    expect(error).toBeInstanceOf(GeometryError); expect(error.message).not.toMatch(/column|PRIV/);
    const diagnostic = geometryFailureDiagnostic(error);
    expect(diagnostic).toMatchObject({ reason: 'unexpected-exception', counts: { shapesFile: 1, tripShapeColumn: 1, datasetTrips: 2 } }); expectPrivate(diagnostic);
  });
});

describe('diagnostic allowlist', () => {
  const valid = () => Object.fromEntries(GEOMETRY_COUNT_KEYS.map((k: string) => [k, 0]));
  it('emits only the fixed reason list and fixed integer keys', () => {
    const counts = { ...valid(), matchedTrips: 3, PRIVTRIP_EXTRA: 7, coordinates: '40.123457,-74.234567' };
    const diagnostic = geometryFailureDiagnostic(new GeometryError('no-matched-trips', 'PRIVTRIP_A', counts));
    expect(Object.keys(diagnostic.counts)).toEqual([...GEOMETRY_COUNT_KEYS]); expect(diagnostic.counts.matchedTrips).toBe(3); expectPrivate(diagnostic);
    expect(GEOMETRY_FAILURE_REASONS).toContain(diagnostic.reason);
    expect(geometryFailureDiagnostic(new GeometryError('PRIVTRIP_REASON', 'x', valid())).reason).toBe('unexpected-exception');
  });
  it.each([
    ['a non-geometry error', new Error('PRIVTRIP_A at 40.123457')],
    ['a string count', new GeometryError('no-matched-trips', 'x', { ...valid(), matchedTrips: 'PRIVTRIP_A' })],
    ['a negative count', new GeometryError('no-matched-trips', 'x', { ...valid(), tripBackward: -1 })],
    ['an oversized count', new GeometryError('no-matched-trips', 'x', { ...valid(), tripBackward: 1_000_001 })],
    ['a fractional count', new GeometryError('no-matched-trips', 'x', { ...valid(), tripBackward: 40.123457 })],
    ['a missing count', new GeometryError('no-matched-trips', 'x', { matchedTrips: 1 })],
    ['no counts', new GeometryError('no-matched-trips', 'x', undefined)],
  ])('drops every count for %s', (_, error) => {
    const diagnostic = geometryFailureDiagnostic(error);
    expect(diagnostic.counts).toBeNull(); expectPrivate(diagnostic);
    expect(diagnostic.reason).toBe(error instanceof GeometryError ? 'no-matched-trips' : 'unexpected-exception');
  });
});
