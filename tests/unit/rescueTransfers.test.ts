import { describe, expect, it } from 'vitest';
import { rescueOptions } from '../../src/domain/rescue';
import { zonedWallTime } from '../../src/domain/time';
import type { Dataset } from '../../src/domain/types';

// Work (A) to Home (H): a late direct 165, or route 99 to Change (C) and route 77 from there.
const build = (opts: { early?: boolean; located?: boolean; noPickupAtChange?: boolean } = {}) => ({
  meta: { demo: false, source: 'test', feedVersion: 'v1', builtAt: '2026-11-01T00:00:00Z', timezone: 'America/New_York', realtime: { provider: 'njt-bus-g2' } },
  routes: [{ id: 'R1', shortName: '165', longName: 'x' }, { id: 'R2', shortName: '99', longName: 'x' }, { id: 'R3', shortName: '77', longName: 'x' }],
  stops: [
    { id: 'A', name: 'Work' }, { id: 'C', name: 'Change' }, { id: 'H', name: 'Home' }, { id: 'Y', name: 'Elsewhere' },
  ].map((s, i) => opts.located === false ? s : { ...s, lat: 40.7 + i * 0.1, lon: -74 }),
  patterns: [
    { id: 'P1', routeId: 'R1', directionId: 1, headsign: 'Home', stopIds: ['A', 'H'] },
    { id: 'P2', routeId: 'R2', directionId: 1, headsign: 'Elsewhere', stopIds: ['A', 'C', 'Y'] },
    { id: 'P3', routeId: 'R3', directionId: 1, headsign: 'Home', stopIds: ['C', 'H'], ...(opts.noPickupAtChange ? { noPickup: [0] } : {}) },
  ],
  trips: [
    { id: 'D1', patternId: 'P1', serviceId: 'ALL', times: opts.early ? [64800, 66000] : [68400, 70800] },
    { id: 'T1', patternId: 'P2', serviceId: 'ALL', times: [64800, 66000, 67000] },
    { id: 'U0', patternId: 'P3', serviceId: 'ALL', times: [66060, 67000] },
    { id: 'U1', patternId: 'P3', serviceId: 'ALL', times: [66600, 67800] },
  ],
  calendars: { ALL: { days: [true, true, true, true, true, true, true], start: '20260101', end: '20271231', added: [], removed: [] } },
}) as unknown as Dataset;
const now = zonedWallTime(2026, 11, 18, 17, 30, 'America/New_York');

describe('rescue with one change of bus', () => {
  it('offers a change at the same stop that gets home before the direct bus, with time to make it', () => {
    const r = rescueOptions(build(), 'A', 'H', now, 'R1');
    expect(r.transfers).toHaveLength(1);
    const x = r.transfers[0]!;
    expect([x.first.dep.tripId, x.changeStopId, x.second.dep.tripId]).toEqual(['T1', 'C', 'U1']);
    expect(x.waitMs).toBe(10 * 60_000); // U0 leaves 1 minute after arrival: too tight to offer
    expect(x.arrives).toBeLessThan(r.options[0]!.arrives);
    expect(r.limitations).toContain('transfers_same_stop_only');
  });
  it('offers no change when a direct bus gets home first', () => {
    expect(rescueOptions(build({ early: true }), 'A', 'H', now, 'R1').transfers).toEqual([]);
  });
  it('offers no change where the second bus does not pick up at the change stop', () => {
    expect(rescueOptions(build({ noPickupAtChange: true }), 'A', 'H', now, 'R1').transfers).toEqual([]);
  });
  it('offers no change without stop locations (printed timetables)', () => {
    const r = rescueOptions(build({ located: false }), 'A', 'H', now, 'R1');
    expect(r.transfers).toEqual([]);
    expect(r.limitations).toContain('no_walking_or_transfers');
  });
  it('offers a change from a slow bus that also reaches home, when the change gets home first', () => {
    const ds = build();
    ds.patterns[1] = { ...ds.patterns[1]!, stopIds: ['A', 'C', 'H'] };
    ds.trips[1] = { ...ds.trips[1]!, times: [64800, 66000, 72000] };
    const x = rescueOptions(ds, 'A', 'H', now, 'R1').transfers;
    expect(x.map((t) => [t.first.dep.tripId, t.second.dep.tripId])).toEqual([['T1', 'U1']]);
  });
  it('finds the second bus on a pattern that passes both twin home stops', () => {
    const ds = build();
    ds.stops = [...ds.stops.map((s) => s.id === 'H' ? { ...s, twin: 'H2' } : s), { id: 'H2', name: 'Home across', lat: 40.95, lon: -74 }];
    ds.patterns[2] = { ...ds.patterns[2]!, stopIds: ['H', 'C', 'H2'] };
    ds.trips[2] = { ...ds.trips[2]!, times: [65000, 66060, 67000] };
    ds.trips[3] = { ...ds.trips[3]!, times: [65500, 66600, 67800] };
    const x = rescueOptions(ds, 'A', 'H', now, 'R1').transfers;
    expect(x.map((t) => [t.second.dep.tripId, t.second.alightStopId])).toEqual([['U1', 'H2']]);
  });
  it('offers no change at a stop with no known location', () => {
    const ds = build();
    ds.stops = ds.stops.map((s) => s.id === 'C' ? { id: 'C', name: 'Change' } : s);
    expect(rescueOptions(ds, 'A', 'H', now, 'R1').transfers).toEqual([]);
  });
});
