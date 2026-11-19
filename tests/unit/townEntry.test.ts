import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BORDER_MARGIN_M, CONFIRM_SPAN_MS, MAX_FIX_ACCURACY_M, MAX_FIX_AGE_MS, distanceToBorderM, initialTownState, nextTownState,
  parseTowns, pointInTown, townAt, type LocationFix, type Ring, type Town, type TownState,
} from '../../src/domain/townEntry';

const LAT = 40.81, KX = 111_320 * Math.cos((LAT * Math.PI) / 180);
/** Longitude `m` meters east of the A|B border at -74.00. */
const east = (m: number) => -74 + m / KX;
const rect = (w: number, s: number, e: number, n: number): Ring => [[w, s], [w, n], [e, n], [e, s], [w, s]];
const A: Town = { geoid: '3400300001', name: 'Alpha', polygons: [[rect(-74.03, 40.8, -74.0, 40.82)]] };
const B: Town = { geoid: '3400300002', name: 'Beta', polygons: [[rect(-74.0, 40.8, -73.97, 40.82)]] };
const C: Town = { geoid: '3400300003', name: 'Gamma', polygons: [[rect(-73.97, 40.8, -73.94, 40.82)]] };
const TOWNS = [A, B, C];
const T0 = Date.UTC(2026, 10, 19, 13);
const fix = (metersEast: number, sec: number, accuracyM = 10): LocationFix => ({ lat: LAT, lon: east(metersEast), accuracyM, at: T0 + sec * 1000 });

/** Feeds fixes received promptly (now = fix time + 1 s); returns all events and the final state. */
function ride(fixes: LocationFix[], towns: readonly Town[] = TOWNS, start: TownState = initialTownState) {
  let state = start; const events: string[] = [];
  for (const f of fixes) {
    const r = nextTownState(state, f, towns, f.at + 1000);
    state = r.state; if (r.event) events.push(r.event.name);
  }
  return { state, events };
}

describe('town entry', () => {
  it('stays silent on the first fix, even deep inside a town', () => {
    const r = nextTownState(initialTownState, fix(-1000, 0), TOWNS, T0);
    expect(r.event).toBeUndefined();
    expect(r.state).toMatchObject({ started: true, current: A.geoid, announced: [A.geoid] });
  });

  it('announces a real crossing exactly once', () => {
    const fixes = [-600, -400, -200, -50, 30, 120, 250, 400, 550, 700].map((m, i) => fix(m, i * 5));
    expect(ride(fixes).events).toEqual(['Beta']);
  });

  it('needs consecutive deep fixes spanning the confirmation time', () => {
    const first = ride([fix(-500, 0), fix(300, 10)]);
    expect(first.events).toEqual([]);
    expect(ride([fix(400, 10 + (CONFIRM_SPAN_MS / 1000) - 1)], TOWNS, first.state).events).toEqual([]);
    expect(ride([fix(400, 10 + CONFIRM_SPAN_MS / 1000)], TOWNS, first.state).events).toEqual(['Beta']);
  });

  it('yields at most one event while GPS jitters back and forth across a border', () => {
    const jitter = Array.from({ length: 120 }, (_, i) => fix(i % 2 ? 60 : -60, i * 3));
    expect(ride([fix(-800, -10), ...jitter]).events).toEqual([]);
    // jitter after the bus is really in Beta, then wandering back: still only one Beta event
    const settled = [fix(-800, 0), fix(300, 10), fix(320, 25), ...jitter.map(f => ({ ...f, at: f.at + 60_000 })), fix(300, 600), fix(320, 620)];
    expect(ride(settled).events).toEqual(['Beta']);
  });

  it('a non-deep fix restarts confirmation', () => {
    expect(ride([fix(-800, 0), fix(300, 10), fix(20, 15), fix(300, 22)]).events).toEqual([]);
  });

  it('never announces while stopped at a border', () => {
    const stopped = Array.from({ length: 200 }, (_, i) => fix(i % 3 === 0 ? -20 : 35, i * 2, 30));
    expect(ride(stopped).events).toEqual([]);
  });

  it('treats towns near the starting point as already seen', () => {
    const r = ride([fix(40, 0), fix(500, 10), fix(600, 30)]);
    expect(r.state.announced).toEqual(expect.arrayContaining([A.geoid, B.geoid]));
    expect(r.events).toEqual([]);
  });

  it('never re-announces a town in the same ride', () => {
    const out = [-800, 300, 320].map((m, i) => fix(m, i * 15));
    const back = [-300, -320, 300, 320, -300, -320, 300, 320].map((m, i) => fix(m, 100 + i * 15));
    expect(ride([...out, ...back]).events).toEqual(['Beta']);
    const onward = [2700, 2800, 2900].map((m, i) => fix(m, 300 + i * 15));
    expect(ride([...out, ...back, ...onward]).events).toEqual(['Beta', 'Gamma']);
  });

  it('ignores inaccurate, stale, future, out-of-order and malformed fixes', () => {
    const start = ride([fix(-800, 0)]).state;
    const bad = fix(400, 20, MAX_FIX_ACCURACY_M + 1);
    expect(nextTownState(start, bad, TOWNS, bad.at).state).toBe(start);
    const ok = fix(400, 20);
    expect(nextTownState(start, ok, TOWNS, ok.at + MAX_FIX_AGE_MS + 1).state).toBe(start);
    expect(nextTownState(start, ok, TOWNS, ok.at - 60_000).state).toBe(start);
    expect(nextTownState(start, fix(400, -5), TOWNS, T0).state).toBe(start);
    for (const f of [{ ...ok, lat: NaN }, { ...ok, accuracyM: -1 }, { ...ok, lon: 999 }]) expect(nextTownState(start, f, TOWNS, ok.at).state).toBe(start);
    // inaccurate fixes deep in Beta never confirm entry
    expect(ride([fix(-800, 0), ...[300, 350, 400, 450].map((m, i) => fix(m, 10 + i * 10, 80))]).events).toEqual([]);
    // the first accepted fix, not the first received, is the silent start
    expect(ride([fix(400, 0, 200), fix(-800, 5), fix(300, 20), fix(400, 35)]).events).toEqual(['Beta']);
  });

  it('announces the first town when the ride starts outside every known town', () => {
    expect(ride([fix(-5000, 0), fix(-4000, 30), fix(-1000, 60), fix(-900, 75)]).events).toEqual(['Alpha']);
  });

  it('uses the named thresholds', () => {
    expect(BORDER_MARGIN_M).toBeGreaterThanOrEqual(MAX_FIX_ACCURACY_M);
    expect(distanceToBorderM(LAT, east(BORDER_MARGIN_M + 1), B)).toBeGreaterThan(BORDER_MARGIN_M);
  });
});

describe('point in town', () => {
  // Delta: two separate squares (multipolygon). Donut: square with a hole that holds the island town.
  const delta: Town = { geoid: '3400300004', name: 'Delta', polygons: [[rect(-74.1, 40.7, -74.09, 40.71)], [rect(-74.05, 40.7, -74.04, 40.71)]] };
  const donut: Town = { geoid: '3400300005', name: 'Donut', polygons: [[rect(-74.2, 40.6, -74.1, 40.65), rect(-74.16, 40.61, -74.14, 40.63)]] };
  const island: Town = { geoid: '3400300006', name: 'Island', polygons: [[rect(-74.16, 40.61, -74.14, 40.63)]] };

  it('handles multipolygons', () => {
    expect(pointInTown(40.705, -74.095, delta)).toBe(true);
    expect(pointInTown(40.705, -74.045, delta)).toBe(true);
    expect(pointInTown(40.705, -74.07, delta)).toBe(false);
  });

  it('handles holes and towns inside holes', () => {
    expect(pointInTown(40.62, -74.15, donut)).toBe(false);
    expect(townAt(40.62, -74.15, [donut, island])?.name).toBe('Island');
    expect(townAt(40.64, -74.12, [donut, island])?.name).toBe('Donut');
    expect(distanceToBorderM(40.62, -74.15, island)).toBeGreaterThan(800);
  });

  it('announces entry into a town inside a hole, and back out without repeats', () => {
    const at = (lat: number, lon: number, sec: number): LocationFix => ({ lat, lon, accuracyM: 5, at: T0 + sec * 1000 });
    const towns = [donut, island];
    const path = [at(40.62, -74.18, 0), at(40.62, -74.15, 30), at(40.621, -74.15, 45), at(40.62, -74.18, 90), at(40.62, -74.181, 105), at(40.62, -74.15, 140), at(40.621, -74.15, 155)];
    expect(ride(path, towns).events).toEqual(['Island']);
  });
});

describe('bundled town borders', () => {
  const file = JSON.parse(readFileSync('public/data/towns.json', 'utf8'));
  const towns = parseTowns(file);

  it('records source, vintage and simplification, and stays small', () => {
    expect(file.meta.url).toMatch(/^https:\/\/www2\.census\.gov\/geo\/tiger\/TIGER\d{4}\/COUSUB\/tl_\d{4}_34_cousub\.zip$/);
    expect(file.meta.vintage).toMatch(/^\d{4}$/);
    expect(file.meta.simplification.toleranceM).toBeLessThanOrEqual(15);
    expect(readFileSync('public/data/towns.json').byteLength).toBeLessThan(200 * 1024);
    expect(new Set(towns.map(t => t.geoid)).size).toBe(towns.length);
  });

  it('places known corridor points in the right town', () => {
    expect(townAt(40.8846, -74.0435, towns)?.name).toBe('Hackensack'); // Main St at the Green
    expect(townAt(40.7685, -74.0198, towns)?.name).toBe('Weehawken');
    expect(townAt(40.7580, -73.9900, towns)).toBeUndefined(); // Manhattan is outside the file
  });

  it('rejects malformed files', () => {
    expect(() => parseTowns({})).toThrow();
    expect(() => parseTowns({ towns: [{ geoid: '1', name: 'X', polygons: [] }] })).toThrow();
    expect(() => parseTowns({ towns: [{ geoid: '3400300001', name: 'X', polygons: [[[[0, 0], [1, 0], [0, 1]]]] }] })).toThrow();
  });
});
