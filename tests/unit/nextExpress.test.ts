import { describe, expect, it } from 'vitest';
import { nextExpress } from '../../src/domain/nextExpress';
import { nextDepartures } from '../../src/domain/schedule';
import { localYmd, zonedWallTime } from '../../src/domain/time';
import { expressDataset } from '../helpers/express';
const now = zonedWallTime(2026, 11, 4, 7, 0, 'America/New_York');
const query = { stopId: 'D1', toStopId: 'PABT', routeIds: [] as string[] };
const rows = (ds = expressDataset()) => nextDepartures(ds, query, now, 3);
describe('compact next express', () => {
  it('finds the next scheduled 165T beyond the displayed locals without changing them', () => {
    const ds = expressDataset(), shown = rows(ds);
    expect(nextExpress(ds, query, shown, now)?.tripId).toBe('express');
    expect(shown.map((d) => d.tripId)).toEqual(['local-0', 'local-1', 'local-2']);
    // The search must not be limited to the main card\'s 40 local options.
    ds.trips.push(...Array.from({ length: 45 }, (_, i) => ({ ...ds.trips[0]!, id: 'extra-' + i, times: ds.trips[0]!.times.map((t) => t + i) })));
    expect(nextExpress(ds, query, rows(ds), now)?.tripId).toBe('express');
  });
  it('stays secondary: absent if an express is already visible, fewer than three locals or another line', () => {
    const ds = expressDataset(), shown = rows(ds), express = nextExpress(ds, query, shown, now)!;
    expect(nextExpress(ds, query, [shown[0]!, shown[1]!, express], now)).toBeUndefined();
    expect(nextExpress(ds, query, shown.slice(0, 2), now)).toBeUndefined();
    expect(nextExpress(ds, query, [shown[0]!, shown[1]!, { ...shown[2]!, route: { ...shown[2]!.route, shortName: '164' } }], now)).toBeUndefined();
  });
  it('requires the express to serve the actual selected boarding and destination stops', () => {
    const ds = expressDataset();
    expect(nextExpress(ds, { ...query, stopId: 'D3' }, rows(ds), now)).toBeUndefined();
    expect(nextExpress(ds, { ...query, toStopId: 'D4' }, rows(ds), now)).toBeUndefined();
    expect(nextExpress(ds, { ...query, routeIds: ['R165'] }, rows(ds), now)).toBeUndefined();
  });
  it.each(['noPickup', 'noDropOff'] as const)('respects %s restrictions', (key) => {
    const ds = expressDataset(); ds.patterns.find((p) => p.id === 'X0')![key] = [key === 'noPickup' ? 0 : 2];
    expect(nextExpress(ds, query, rows(ds), now)).toBeUndefined();
  });
  it('skips departed and unreachable expresses using the rider\'s existing walking time', () => {
    const ds = expressDataset();
    ds.trips.push({ ...ds.trips[3]!, id: 'later-express', times: ds.trips[3]!.times.map((t) => t + 1800) });
    const later = nextExpress(ds, query, rows(ds), now + 40 * 60_000 + 1);
    expect(later?.tripId).toBe('later-express');
    expect(nextExpress(ds, query, rows(ds), now, 41)?.tripId).toBe('later-express');
  });
  it('keeps the previous service date on after-midnight trips', () => {
    const ds = expressDataset(); ds.trips.forEach((t) => { t.times = t.times.map((s) => s + 17 * 3600); });
    const midnight = zonedWallTime(2026, 11, 5, 0, 0, ds.meta.timezone);
    const shown = nextDepartures(ds, query, midnight, 3), dep = nextExpress(ds, query, shown, midnight)!;
    expect(dep.serviceDate).toBe('20261104'); expect(localYmd(dep.departs, ds.meta.timezone)).toBe('20261105');
  });
  it('honors express calendar exceptions and reports no result when its calendar has expired', () => {
    const ds = expressDataset(); ds.calendars.EXP = { ...structuredClone(ds.calendars.WKDY!), removed: ['20261104'] }; ds.trips[3]!.serviceId = 'EXP';
    expect(nextExpress(ds, query, rows(ds), now)?.serviceDate).toBe('20261105');
    ds.calendars.EXP.end = '20261103';
    expect(nextExpress(ds, query, rows(ds), now)).toBeUndefined();
  });
});
