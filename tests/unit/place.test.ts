import { describe, expect, it } from 'vitest';
import { createBusSession } from '../../src/domain/busLock';
import { destinationsFrom, reaches } from '../../src/domain/direction';
import { loadLock, saveLock } from '../../src/domain/lockStore';
import { requestFor } from '../../src/domain/liveDepartures';
import { boardIndex, dropIndex, placeIndex, samePlace } from '../../src/domain/place';
import { departuresOn } from '../../src/domain/schedule';
import type { Dataset } from '../../src/domain/types';

// Synthetic: Port Authority has a daytime stop (P-DAY) and a late-night stop (P-NIGHT), as in NJ Transit's
// schedule, where the late 163s leave from another Port Authority stop ID (Diego, Nov 20, 2026).
const all = [true, true, true, true, true, true, true];
const ds: Dataset = {
  meta: { demo: false, source: 'synthetic', feedVersion: 'x', builtAt: '2026-11-20T00:00:00Z', timezone: 'America/New_York' },
  routes: [{ id: 'R', shortName: '163', longName: 'test' }],
  stops: [
    { id: 'P-DAY', name: 'PORT AUTHORITY BUS TERMINAL', terminal: 'PABT' },
    { id: 'P-NIGHT', name: 'PORT AUTHORITY BUS TERMINAL', terminal: 'PABT' },
    { id: 'H', name: 'HACKENSACK' },
    { id: 'X', name: 'ELSEWHERE' },
    { id: 'P-DROP', name: 'PORT AUTHORITY DROP OFF', terminal: 'PABT' },
    { id: 'W', name: 'RIDGEWOOD' },
  ],
  patterns: [
    { id: 'out-day', routeId: 'R', directionId: 0, headsign: 'OUT', stopIds: ['P-DAY', 'H'] },
    { id: 'out-night', routeId: 'R', directionId: 0, headsign: 'OUT', stopIds: ['P-NIGHT', 'H'] },
    { id: 'in-night', routeId: 'R', directionId: 1, headsign: 'IN', stopIds: ['H', 'P-NIGHT'] },
    { id: 'in-drop', routeId: 'R', directionId: 1, headsign: 'IN', stopIds: ['H', 'P-DROP', 'P-DAY'] },
    // No trips: only shows which destinations each Port Authority stop reaches.
    { id: 'night-only', routeId: 'R', directionId: 0, headsign: 'OUT', stopIds: ['P-NIGHT', 'W'] },
  ],
  trips: [
    { id: 'day', patternId: 'out-day', serviceId: 'S', times: [18 * 3600, 18 * 3600 + 1800] },
    { id: 'night', patternId: 'out-night', serviceId: 'S', times: [23 * 3600 + 20 * 60, 23 * 3600 + 50 * 60] },
    { id: 'late', patternId: 'out-night', serviceId: 'S', times: [24 * 3600 + 20 * 60, 24 * 3600 + 50 * 60] },
    { id: 'home', patternId: 'in-night', serviceId: 'S', times: [23 * 3600, 23 * 3600 + 1800] },
    { id: 'arriving', patternId: 'in-drop', serviceId: 'S', times: [22 * 3600, 22 * 3600 + 1700, 22 * 3600 + 1800] },
  ],
  calendars: { S: { days: all, start: '20261101', end: '20261130', added: [], removed: [] } },
} as unknown as Dataset;

describe('Port Authority is one place', () => {
  it('matches any two Port Authority stops, and nothing else', () => {
    expect(samePlace(ds, 'P-DAY', 'P-NIGHT')).toBe(true);
    expect(samePlace(ds, 'P-DAY', 'H')).toBe(false);
    expect(samePlace(ds, 'H', 'X')).toBe(false);
    expect(samePlace(ds, 'H', 'H')).toBe(true);
  });
  it('a rider leaving from the daytime stop still sees the late-night buses, each with its own stop', () => {
    const deps = departuresOn(ds, { stopId: 'P-DAY', toStopId: 'H', date: '20261120' });
    // 'late' here is the previous service day's 12:20 AM trip.
    expect(deps.map((d) => d.tripId)).toEqual(['late', 'day', 'night']);
    expect(deps[2]!.pattern.stopIds[deps[2]!.stopIndex]).toBe('P-NIGHT');
    expect(departuresOn(ds, { stopId: 'P-DAY', toStopId: 'H', date: '20261121' }).map((d) => d.tripId)).toContain('late');
  });
  it('a trip home to a different Port Authority stop counts, and the live request names its real position', () => {
    const home = departuresOn(ds, { stopId: 'H', toStopId: 'P-DAY', date: '20261120' }).find((d) => d.tripId === 'home');
    expect(home?.tripId).toBe('home');
    expect(requestFor(ds, home!, 'P-DAY').toStopIndex).toBe(1);
    expect(reaches(ds, 'H', 'P-DAY')).toBe(true);
  });
  it('searches only after the given index', () => {
    expect(placeIndex(ds, ds.patterns[2]!, 'P-DAY', 0)).toBe(1);
    expect(placeIndex(ds, ds.patterns[1]!, 'P-DAY', 1)).toBe(-1);
  });
  it('a New York-bound bus passing the drop off is an arrival, never a departure to New Jersey', () => {
    expect(boardIndex(ds, ds.patterns[3]!, 'P-DAY')).toBe(-1);
    expect(departuresOn(ds, { stopId: 'P-DAY', date: '20261120' }).map((d) => d.tripId)).not.toContain('arriving');
    expect(departuresOn(ds, { stopId: 'H', toStopId: 'P-DAY', date: '20261120' }).map((d) => d.tripId)).toContain('arriving');
  });
  it('a rider bound for Port Authority gets off at the final call, not the drop-off staging call before it (CodeRabbit, #241)', () => {
    const drop = ds.patterns[3]!;
    expect(dropIndex(ds, drop, 'P-DAY', 1)).toBe(2);
    expect(dropIndex(ds, drop, 'P-NIGHT', 1)).toBe(2);
    expect(dropIndex(ds, drop, 'P-DROP', 1)).toBe(1);
    expect(dropIndex(ds, { ...drop, noDropOff: [2] }, 'P-NIGHT', 1)).toBe(1);
    expect(dropIndex(ds, { ...drop, noDropOff: [1, 2] }, 'P-NIGHT', 1)).toBe(-1);
  });
  it('a locked late bus from another Port Authority stop ID survives a reload (Codex, #241)', () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    const dep = departuresOn(ds, { stopId: 'P-DAY', toStopId: 'H', date: '20261120' }).find((d) => d.tripId === 'night')!;
    const leg = { fromStopId: 'P-DAY', toStopId: 'H', routeIds: ['R'] };
    const now = dep.departs - 10 * 60_000;
    saveLock(store, ds, { dep, leg, session: createBusSession(dep, now) }, now);
    expect(loadLock<typeof leg>(store, ds, now + 60_000)?.dep.tripInstanceId).toBe(dep.tripInstanceId);
    saveLock(store, ds, { dep, leg: { ...leg, fromStopId: 'H' }, session: createBusSession(dep, now) }, now);
    expect(loadLock(store, ds, now + 60_000)).toBeUndefined();
  });
});

describe('destinations from Port Authority', () => {
  it('lists a place only the late-night Port Authority stop serves (CodeRabbit, #241)', () => {
    const ids = destinationsFrom(ds, 'P-DAY').map(s => s.id);
    expect(ids).toContain('W');
    expect(ids).toContain('H');
    // The drop-off call before the final stop is not a departure.
    expect(ids).not.toContain('P-DAY');
  });
});
