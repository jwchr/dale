import { describe, expect, it } from 'vitest';
import { demoDataset as ds, demoUsualGates } from '../../src/data/demo';
import type { Dataset } from '../../src/domain/types';
import { alightingStopFor, checkDirection, reaches, destinationsFrom, searchStops } from '../../src/domain/direction';
import { addFavorite, loadFavorites, moveFavorite, removeFavorite, renameFavorite, saveFavorites, type Favorite } from '../../src/domain/favorites';
import { gateChanged, gateFor, parseLaneGate } from '../../src/domain/gate';
import { createLock, reduceLock, type VehicleObservation } from '../../src/domain/lock';
import { departuresOn, isServiceActive, nextDepartures } from '../../src/domain/schedule';
import { clockChangeBetween, formatTime12, localYmd, parseGtfsTime, serviceTimeToInstant, tzOffsetMinutes, zonedWallTime } from '../../src/domain/time';

const TZ = 'America/New_York';
const fmt = (t: number) => formatTime12(t, TZ);

describe('time', () => {
  it('parses GTFS times past midnight', () => {
    expect(parseGtfsTime('25:10:00')).toBe(25 * 3600 + 600);
  });
  it('maps 24:15 on a service date to 12:15 AM the next calendar day', () => {
    const t = serviceTimeToInstant('20261104', 24 * 3600 + 15 * 60, TZ);
    expect(localYmd(t, TZ)).toBe('20261105');
    expect(fmt(t)).toBe('12:15 AM');
  });
  it('is correct across the fall-back DST day (Nov 1 2026)', () => {
    // On a 25-hour day, 08:00 service time is still 8:00 AM local (noon-minus-12h rule).
    expect(fmt(serviceTimeToInstant('20261101', 8 * 3600, TZ))).toBe('8:00 AM');
    expect(tzOffsetMinutes(zonedWallTime(2026, 11, 1, 12, 0, TZ), TZ)).toBe(-300);
  });
  it('reads wall-clock times on clock-change nights: a repeated hour is the first, a skipped one moves forward', () => {
    // Fall back 11/1/2026: 1:30 AM happens twice; the first (EDT, UTC-4) is used.
    expect(tzOffsetMinutes(zonedWallTime(2026, 11, 1, 1, 30, TZ), TZ)).toBe(-240);
    expect(zonedWallTime(2026, 11, 1, 2, 10, TZ) - zonedWallTime(2026, 11, 1, 1, 50, TZ)).toBe(80 * 60_000);
    // Spring forward 3/14/2027: 2:10 AM does not exist; it reads as 3:10 AM EDT, after 1:50 AM EST.
    expect(fmt(zonedWallTime(2027, 3, 14, 2, 10, TZ))).toBe('3:10 AM');
    expect(zonedWallTime(2027, 3, 14, 2, 10, TZ) - zonedWallTime(2027, 3, 14, 1, 50, TZ)).toBe(20 * 60_000);
    // Service-day 26:08 on Saturday 10/31/2026 is 2:08 AM Sunday as printed; the GTFS rule would say 1:08 AM.
    expect(fmt(serviceTimeToInstant('20261031', 26 * 3600 + 8 * 60, TZ, 'wall'))).toBe('2:08 AM');
    expect(fmt(serviceTimeToInstant('20261031', 26 * 3600 + 8 * 60, TZ))).toBe('1:08 AM');
    // Ordinary days read the same either way.
    expect(serviceTimeToInstant('20261104', 25 * 3600 + 10 * 60, TZ, 'wall')).toBe(serviceTimeToInstant('20261104', 25 * 3600 + 10 * 60, TZ));
  });
  it('says when the clocks change between two instants', () => {
    expect(clockChangeBetween(zonedWallTime(2026, 11, 1, 1, 10, TZ), zonedWallTime(2026, 11, 1, 2, 8, TZ), TZ)).toBe('back');
    expect(clockChangeBetween(zonedWallTime(2027, 3, 14, 1, 10, TZ), zonedWallTime(2027, 3, 14, 3, 8, TZ), TZ)).toBe('ahead');
    expect(clockChangeBetween(zonedWallTime(2026, 11, 7, 1, 10, TZ), zonedWallTime(2026, 11, 7, 2, 8, TZ), TZ)).toBeUndefined();
  });
  it('is correct across the spring-forward DST day (Mar 14 2027)', () => {
    expect(fmt(serviceTimeToInstant('20270314', 8 * 3600, TZ))).toBe('8:00 AM');
    expect(fmt(serviceTimeToInstant('20270314', 23 * 3600 + 30 * 60, TZ))).toBe('11:30 PM');
  });
  // The GTFS spec measures times from noon minus 12 h, which shifts 00:00-02:59 by an hour on DST days.
  // These tests pin that literal reading; M2 must check how NJ Transit actually encodes those trips.
  it('spring-forward: 00:30 on Mar 14 2027 is 11:30 PM on Mar 13 and is not lost', () => {
    const t = serviceTimeToInstant('20270314', 30 * 60, TZ);
    expect([localYmd(t, TZ), fmt(t)]).toEqual(['20270313', '11:30 PM']);
    const one: typeof ds = { ...ds, trips: [{ id: 'N', patternId: 'L0', serviceId: 'ALL', times: [1800, 2160, 2640, 3240, 5100] }],
      calendars: { ALL: { days: [true, true, true, true, true, true, true], start: '20270301', end: '20270331', added: [], removed: [] } } };
    const on = (d: string) => departuresOn(one, { stopId: 'D1', date: d }).map((x) => `${x.serviceDate} ${fmt(x.departs)}`);
    expect(on('20270313')).toEqual(['20270313 12:30 AM', '20270314 11:30 PM']);
    expect(on('20270314')).toEqual([]); // that day's 00:30 trip already ran the evening before
  });
  it('fall-back: 00:30 and 01:30 on Nov 1 2026 both read 1:30 AM (once EDT, once EST)', () => {
    const a = serviceTimeToInstant('20261101', 30 * 60, TZ);
    const b = serviceTimeToInstant('20261101', 90 * 60, TZ);
    expect([fmt(a), fmt(b), (b - a) / 60000]).toEqual(['1:30 AM', '1:30 AM', 60]);
  });
  it('formats Spanish with a 12-hour clock', () => {
    expect(formatTime12(serviceTimeToInstant('20261104', 7 * 3600 + 5 * 60, TZ), TZ, 'es')).toMatch(/^7:05 a\.? ?m\.?$/i);
  });
});

describe('calendar and departures', () => {
  it('applies holiday removals and additions', () => {
    expect(isServiceActive(ds.calendars.WKDY, '20261126')).toBe(false);
    expect(isServiceActive(ds.calendars.SUN, '20261126')).toBe(true);
    expect(isServiceActive(ds.calendars.WKDY, '20261125')).toBe(true);
  });
  it('lists the whole weekday at the boarding stop in time order, both routes', () => {
    const list = departuresOn(ds, { stopId: 'D1', date: '20261104', directionId: 0 });
    expect(list.length).toBe(38 + 1 + 10); // 38 locals + the 12:15 AM from the previous night + 10 expresses
    expect(list.map((d) => d.departs)).toEqual([...list.map((d) => d.departs)].sort((a, b) => a - b));
    expect(fmt(list[0]!.departs)).toBe('12:15 AM');
    expect(list[0]!.serviceDate).toBe('20261103');
    expect(new Set(list.map((d) => d.route.shortName))).toEqual(new Set(['165', '165T']));
  });
  it('never offers a departure from the last stop of a pattern', () => {
    expect(departuresOn(ds, { stopId: 'PABT', date: '20261104', directionId: 0 })).toHaveLength(0);
  });
  it('filters to trips that actually reach the destination', () => {
    const toD3 = departuresOn(ds, { stopId: 'D1', date: '20261104', toStopId: 'D3' });
    expect(toD3.every((d) => d.route.shortName === '165')).toBe(true);
  });
  it('runs the Sunday schedule on the holiday', () => {
    const list = departuresOn(ds, { stopId: 'D1', date: '20261126', directionId: 0 });
    expect(list.every((d) => d.route.shortName === '165')).toBe(true);
    // The Wednesday-night 12:15 AM trip belongs to the previous service day and still runs.
    expect(list.slice(0, 2).map((d) => [fmt(d.departs), d.serviceDate])).toEqual([
      ['12:15 AM', '20261125'],
      ['7:00 AM', '20261126'],
    ]);
  });
  it('rolls over to tomorrow for next departures late at night', () => {
    const now = serviceTimeToInstant('20261104', 23 * 3600 + 45 * 60, TZ);
    const next = nextDepartures(ds, { stopId: 'D1', directionId: 0 }, now, 3);
    expect(next.map((d) => fmt(d.departs))).toEqual(['12:15 AM', '5:00 AM', '5:30 AM']);
  });
});

describe('direction guard', () => {
  it('accepts the correct side', () => {
    expect(checkDirection(ds, 'D2', 'PABT')).toEqual({ ok: true });
  });
  it('sends a rider on the wrong side across the street', () => {
    const r = checkDirection(ds, 'D2B', 'PABT');
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'wrong-side') {
      expect(r.useStop.id).toBe('D2');
      expect(r.distanceM).toBeLessThan(50);
    } else throw new Error('expected wrong-side');
  });
  it('reverses a commute to the home stop\'s twin across the street', () => {
    expect(alightingStopFor(ds, 'PABT', 'D2')?.id).toBe('D2B');
    expect(alightingStopFor(ds, 'PABT', 'D1')?.id).toBe('D1');
    expect(alightingStopFor(ds, 'D1', 'D4B')?.id).toBe('D4');
    expect(alightingStopFor(ds, 'PABT', 'D3', ['R165T'])).toBeUndefined();
  });
  it('counts only the first listing of a stop on a loop pattern, like reaches does', () => {
    const loop = (stopIds: string[], extra: { noPickup?: number[]; noDropOff?: number[] }): Dataset => ({ ...ds, patterns: [{ ...ds.patterns[0]!, stopIds, ...extra }] });
    const noDrop = loop(['D1', 'D3', 'PABT', 'D3'], { noDropOff: [1] });
    expect(reaches(noDrop, 'D1', 'D3')).toBe(false);
    expect(alightingStopFor(noDrop, 'D1', 'D3', undefined, 0)?.id).toBe(reaches(noDrop, 'D1', 'D3') ? 'D3' : undefined);
    const noPick = loop(['D1', 'D3', 'D1', 'PABT'], { noPickup: [0] });
    expect(reaches(noPick, 'D1', 'PABT')).toBe(false);
    expect(alightingStopFor(noPick, 'D1', 'PABT', undefined, 0)).toBeUndefined();
  });
  it('offers every stop a bus reaches, terminal first, then the wrong side so the guard can send the rider across', () => {
    expect(destinationsFrom(ds, 'D2').map((s) => s.id)).toEqual(['PABT', 'D3', 'D4', 'D1']);
    expect(destinationsFrom(ds, 'D2B').map((s) => s.id)).toEqual(['D1', 'PABT', 'D3', 'D4']);
  });
  it('finds stops by name, accents ignored, and by exact code', () => {
    expect(searchStops(ds, 'maple main').map((s) => s.id).sort()).toEqual(['D2', 'D2B']);
    expect(searchStops(ds, '90003')[0]!.id).toBe('D3');
    expect(searchStops(ds, 'Port Authórity')[0]!.id).toBe('PABT');
  });
});

describe('favorites', () => {
  const f = (id: string): Favorite => ({ id, label: id, fromStopId: 'D1', toStopId: 'PABT', routeIds: [] });
  it('keeps the rider order and moves one step at a time', () => {
    let list = [f('a'), f('b'), f('c')];
    list = moveFavorite(list, 'c', -1);
    expect(list.map((x) => x.id)).toEqual(['a', 'c', 'b']);
    expect(moveFavorite(list, 'a', -1)).toBe(list);
    list = renameFavorite(removeFavorite(list, 'b'), 'c', '  Work  ');
    expect(list.map((x) => x.label)).toEqual(['a', 'Work']);
    expect(addFavorite(list, f('a'))).toBe(list);
  });
  it('re-saves a trip whose old id now belongs to a changed favorite', () => {
    // A saved trip D2>PABT had its stops changed to D1 but kept its id; saving D2>PABT again must work.
    const changed = { ...f('D2>PABT'), fromStopId: 'D1' };
    const fresh = { ...f('D2>PABT'), fromStopId: 'D2' };
    const list = addFavorite([changed], fresh);
    expect(list.map((x) => [x.id, x.fromStopId])).toEqual([['D2>PABT', 'D1'], ['D2>PABT~2', 'D2']]);
    // The same stops and routes are never saved twice, whatever the id.
    expect(addFavorite(list, { ...fresh, id: 'other' })).toBe(list);
    // Repeated route ids never make different route sets look the same.
    const repeated = [{ ...f('r'), routeIds: ['R1', 'R1'] }];
    expect(addFavorite(repeated, { ...f('s'), routeIds: ['R1', 'R2'] })).toHaveLength(2);
    expect(addFavorite(repeated, { ...f('t'), routeIds: ['R1'] })).toBe(repeated);
  });
  it('drops damaged entries individually, retaining valid commutes, order and leave plans', () => {
    const first = { ...f('a'), fromStopId: 'a-stop-not-in-this-schedule', leave: { out: { walkMin: 4, cushionMin: 2 }, back: { walkMin: 'bad' } } };
    const last = { ...f('c'), label: '', routeIds: ['a-route-not-in-this-schedule'], leave: 12 };
    const bad = [null, 'text', [], { id: 'x' }, { ...f('b'), label: {} }, { ...f('b'), fromStopId: 2 },
      { ...f('b'), toStopId: '' }, { ...f('b'), routeIds: '165' }, { ...f('b'), routeIds: [null] }, { ...f('b'), routeIds: [''] }];
    const raw = JSON.stringify([bad[0], first, ...bad.slice(1), { ...f('a'), label: 'duplicate' }, last]);
    expect(loadFavorites({ getItem: () => raw })).toEqual([
      { ...f('a'), fromStopId: first.fromStopId, leave: { out: { walkMin: 4, cushionMin: 2 } } },
      { ...f('c'), label: '', routeIds: last.routeIds },
    ]);
  });
  it('retains a good entry even when an earlier damaged record has the same id', () => {
    expect(loadFavorites({ getItem: () => JSON.stringify([{ ...f('a'), label: {} }, f('a')]) })).toEqual([f('a')]);
    expect(loadFavorites({ getItem: () => { throw new Error('unavailable'); } })).toEqual([]);
    expect(loadFavorites({ getItem: () => '{}' })).toEqual([]);
  });
  it('survives missing or broken storage', () => {
    expect(loadFavorites(undefined)).toEqual([]);
    expect(loadFavorites({ getItem: () => '{not json' })).toEqual([]);
    expect(() => saveFavorites({ setItem: () => { throw new Error('quota'); } }, [f('a')])).not.toThrow();
  });
});

describe('exact-bus lock', () => {
  const obs = (over: Partial<VehicleObservation>): VehicleObservation => ({
    tripInstanceId: 'T1@20261104', vehicleId: 'V1', observedAt: 1000, lat: 40.8, lon: -74, ...over,
  });
  it('starts scheduled-only and becomes tracked on the first matching vehicle', () => {
    let l = createLock('T1@20261104', 0);
    expect(l.status).toBe('scheduled_only');
    l = reduceLock(l, { type: 'observation', obs: obs({ tripInstanceId: 'T2@20261104', vehicleId: 'V9' }) });
    expect(l.status).toBe('scheduled_only');
    l = reduceLock(l, { type: 'observation', obs: obs({}) });
    expect(l).toMatchObject({ status: 'tracked', vehicleId: 'V1' });
  });
  it('goes stale, then vanished, and never calls a missing bus cancelled', () => {
    let l = reduceLock(createLock('T1@20261104', 0), { type: 'observation', obs: obs({ observedAt: 0 }) });
    l = reduceLock(l, { type: 'tick', now: 3 * 60_000 });
    expect(l.status).toBe('stale');
    l = reduceLock(l, { type: 'tick', now: 60 * 60_000 });
    expect(l.status).toBe('vanished');
    l = reduceLock(l, { type: 'observation', obs: obs({ observedAt: 61 * 60_000 }) });
    expect(l.status).toBe('tracked');
    l = reduceLock(l, { type: 'official_cancellation', tripInstanceId: 'T1@20261104' });
    expect(l.status).toBe('cancelled');
  });
  it('holds a vehicle swap for confirmation instead of switching silently', () => {
    let l = reduceLock(createLock('T1@20261104', 0), { type: 'observation', obs: obs({}) });
    l = reduceLock(l, { type: 'observation', obs: obs({ vehicleId: 'V2', observedAt: 2000 }) });
    expect(l).toMatchObject({ status: 'needs_confirmation', vehicleId: 'V1' });
    // Further reports of the old bus do not clear the question.
    l = reduceLock(l, { type: 'observation', obs: obs({ observedAt: 3000 }) });
    expect(l.status).toBe('needs_confirmation');
    expect(reduceLock(l, { type: 'confirm_pending' })).toMatchObject({ status: 'tracked', vehicleId: 'V2' });
    expect(reduceLock(l, { type: 'reject_pending' })).toMatchObject({ status: 'stale', vehicleId: 'V1' });
  });
  it('holds when our bus reappears on a different trip', () => {
    let l = reduceLock(createLock('T1@20261104', 0), { type: 'observation', obs: obs({}) });
    l = reduceLock(l, { type: 'observation', obs: obs({ tripInstanceId: 'T7@20261104', observedAt: 5000 }) });
    expect(l).toMatchObject({ status: 'needs_confirmation', tripInstanceId: 'T1@20261104' });
  });
  it('ignores out-of-order reports', () => {
    let l = reduceLock(createLock('T1@20261104', 0), { type: 'observation', obs: obs({ observedAt: 5000, lat: 1 }) });
    l = reduceLock(l, { type: 'observation', obs: obs({ observedAt: 4000, lat: 2 }) });
    expect(l.last?.lat).toBe(1);
  });
});

describe('gates', () => {
  it('parses lane/gate strings and treats ".." as no gate', () => {
    expect(parseLaneGate('214-3')).toEqual({ gate: '214', door: '3' });
    expect(parseLaneGate('312')).toEqual({ gate: '312' });
    expect(parseLaneGate('..')).toBeNull();
    expect(parseLaneGate('')).toBeNull();
  });
  it('prefers the newest posting for the exact trip, then a well-supported usual gate, else unknown', () => {
    const postings = [
      { tripInstanceId: 'A@1', boardingIndex: 0, ageMs: 0, gate: '212', observedAt: 1, source: 'demo' as const },
      { tripInstanceId: 'A@1', boardingIndex: 0, ageMs: 0, gate: '215', door: '1', observedAt: 2, source: 'demo' as const },
      { tripInstanceId: 'B@1', boardingIndex: 0, ageMs: 0, gate: '999', observedAt: 3, source: 'demo' as const },
    ];
    expect(gateFor('A@1', 'L1', 600, 'weekday', postings, demoUsualGates)).toMatchObject({ status: 'posted', gate: '215', door: '1' });
    expect(gateFor('C@1', 'L1', 600, 'weekday', postings, demoUsualGates)).toMatchObject({ status: 'usual', gate: '212' });
    expect(gateFor('C@1', 'L1', 23 * 60, 'weekday', [], demoUsualGates)).toMatchObject({ status: 'usual', gate: '312' });
    expect(gateFor('C@1', 'L1', 600, 'sunday', [], demoUsualGates)).toEqual({ status: 'unknown' }); // only 3 samples
    expect(gateFor('C@1', 'L0', 600, 'weekday', [], demoUsualGates)).toEqual({ status: 'unknown' });
  });
  it('flags a change only for a new posting that differs', () => {
    expect(gateChanged({ status: 'usual', gate: '212', samples: 9 }, { status: 'posted', gate: '214', observedAt: 1, source: 'demo' })).toBe(true);
    expect(gateChanged({ status: 'usual', gate: '212', samples: 9 }, { status: 'posted', gate: '212', observedAt: 1, source: 'demo' })).toBe(false);
    expect(gateChanged({ status: 'posted', gate: '212', door: '1', observedAt: 1, source: 'demo' }, { status: 'posted', gate: '212', door: '2', observedAt: 2, source: 'demo' })).toBe(true);
    expect(gateChanged({ status: 'unknown' }, { status: 'posted', gate: '212', observedAt: 1, source: 'demo' })).toBe(false);
  });
});

describe('stops near me (issue #31)', () => {
  it('lists served stops within the radius, nearest first, with straight-line metres', async () => {
    const { nearbyStops, hasStopLocations } = await import('../../src/domain/direction');
    const nearMaple = { lat: 40.8701, lon: -74.0400 };
    const near = nearbyStops(ds, nearMaple, 500);
    expect(near.map((x) => x.stop.id)).toEqual(['D2', 'D2B']);
    expect(near[0]!.distanceM).toBeLessThan(20);
    expect(nearbyStops(ds, { lat: 41.5, lon: -74.5 }, 500)).toEqual([]);
    expect(hasStopLocations(ds)).toBe(true);
  });
});
