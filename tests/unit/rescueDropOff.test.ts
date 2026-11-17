import { describe, expect, it } from 'vitest';
import { rescueOptions } from '../../src/domain/rescue';
import { zonedWallTime } from '../../src/domain/time';
import type { Dataset } from '../../src/domain/types';

// An express passes Home but does not let riders off there (GTFS drop_off_type=1); a local does.
const ds = {
  meta: { demo: false, source: 'test', feedVersion: 'v1', builtAt: '2026-11-01T00:00:00Z', timezone: 'America/New_York', realtime: { provider: 'njt-bus-g2' } },
  routes: [{ id: 'R1', shortName: '165', longName: 'x' }],
  stops: [
    { id: 'A', name: 'Work', lat: 40.76, lon: -73.99 }, { id: 'B', name: 'Mid', lat: 40.8, lon: -74.0 },
    { id: 'H', name: 'Home', lat: 40.99, lon: -74.03 }, { id: 'Z', name: 'End', lat: 41.0, lon: -74.04 },
  ],
  patterns: [
    { id: 'PX', routeId: 'R1', directionId: 1, headsign: 'End', stopIds: ['A', 'B', 'H', 'Z'], noDropOff: [2] },
    { id: 'PL', routeId: 'R1', directionId: 1, headsign: 'End', stopIds: ['A', 'B', 'H', 'Z'] },
  ],
  trips: [
    { id: 'X1', patternId: 'PX', serviceId: 'ALL', times: [64800, 65400, 66600, 67200] },
    { id: 'L1', patternId: 'PL', serviceId: 'ALL', times: [68400, 69000, 70200, 70800] },
  ],
  calendars: { ALL: { days: [true, true, true, true, true, true, true], start: '20260101', end: '20271231', added: [], removed: [] } },
} as unknown as Dataset;

describe('rescue respects no-drop-off stops', () => {
  it('never offers a bus that will not let the rider off at home', () => {
    const now = zonedWallTime(2026, 11, 18, 17, 30, 'America/New_York');
    expect(rescueOptions(ds, 'A', 'H', now, 'R1').options.map((o) => o.dep.tripId)).toEqual(['L1']);
  });
});
