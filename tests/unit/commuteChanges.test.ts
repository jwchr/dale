import { describe, expect, it } from 'vitest';
import { advanceCommuteChanges, compareCommute, favoriteKey } from '../../src/domain/commuteChanges';
import { createCommuteChangeStore, parseCommuteChangeState } from '../../src/data/commuteChangeStore';
import type { Favorite } from '../../src/domain/favorites';
import type { Dataset } from '../../src/domain/types';
import { liveDataset, NOW } from '../helpers/liveBus';
import { serviceTimeToInstant } from '../../src/domain/time';

const favorite: Favorite = { id: 'fictional-commute', label: 'Fictional commute', fromStopId: '1', toStopId: '3', routeIds: [] };
const old = () => structuredClone(liveDataset);
const newer = () => { const ds = old(); ds.meta.feedVersion = 'fixture-v2'; return ds; };
const retime = (ds: Dataset, tripId = 'T1', delta = 180) => {
  const trip = ds.trips.find(t => t.id === tripId)!;
  trip.times = trip.times.map(x => x + delta); trip.arrivals = trip.arrivals?.map(x => x === null ? null : x + delta);
};
const compare = (ds: Dataset, f = favorite) => compareCommute(old(), ds, f, '20261104');

describe('saved-commute schedule comparison', () => {
  it('finds retiming, explicit arrival changes, additions and removals on the first affected date', () => {
    const ds = newer(); retime(ds);
    const result = compare(ds)!;
    expect(result.kind).toBe('timetable'); expect(result.date).toBe('20261104');
    expect(result.before).toHaveLength(1); expect(result.after).toHaveLength(1);
    expect(result.after[0]!.departure - result.before[0]!.departure).toBe(180000);
    const arrivals = newer(); arrivals.trips.find(t => t.id === 'T1')!.arrivals![2]! -= 60;
    expect(compare(arrivals)?.before).toHaveLength(1);
    const removed = newer(); removed.trips = removed.trips.filter(t => t.id !== 'T1');
    expect(compare(removed)?.after).toEqual([]);
    const added = newer(); added.trips.push({ ...structuredClone(added.trips.find(t => t.id === 'T1')!), id: 'extra-bus' });
    expect(compare(added)?.after).toHaveLength(1);
  });
  it('ignores trip/pattern identifiers, build time and display-only spelling/city changes', () => {
    const ds = newer(); ds.meta.builtAt = '2026-11-05T00:00:00Z';
    ds.trips.forEach(t => { t.id += '-renumbered'; t.patternId += '-renumbered'; });
    ds.patterns.forEach(p => { p.id += '-renumbered'; });
    ds.stops.forEach(s => { s.sourceName = s.name; s.name = 'Display spelling'; s.city = 'Display town'; });
    expect(compare(ds)).toBeUndefined();
  });
  it('keeps route filters and counts duplicated same-minute buses independently', () => {
    const ds = newer(); retime(ds, 'T3');
    const route = ds.patterns.find(p => p.id === ds.trips.find(t => t.id === 'T1')!.patternId)!.routeId;
    expect(compare(ds, { ...favorite, routeIds: [route] })).toBeUndefined();
    const a = old(), b = newer();
    a.trips.push({ ...structuredClone(a.trips.find(t => t.id === 'T1')!), id: 'duplicate' });
    expect(compareCommute(a, b, favorite, '20261104')?.before).toHaveLength(1);
  });
  it('detects pickup/drop-off, intermediate stopping pattern and selected stop facts', () => {
    for (const restriction of ['noPickup', 'noDropOff'] as const) {
      const ds = newer(), p = ds.patterns.find(p => p.id === ds.trips.find(t => t.id === 'T1')!.patternId)!;
      p[restriction] = [restriction === 'noPickup' ? 0 : 2];
      expect(compare(ds)?.kind).toBe('timetable');
    }
    const ds = newer(), p = ds.patterns.find(p => p.id === ds.trips.find(t => t.id === 'T1')!.patternId)!;
    p.stopIds[1] = '4'; expect(compare(ds)?.kind).toBe('stops');
    const moved = newer(); moved.stops.find(s => s.id === '1')!.lat! += .001;
    expect(compare(moved)?.kind).toBe('stops');
    const missing = newer(); missing.stops = missing.stops.filter(s => s.id !== '1');
    expect(compare(missing)?.kind).toBe('selection');
  });
  it('detects calendar exceptions and only compares shared service dates at a weekly boundary', () => {
    const ds = newer(); ds.calendars.WK!.removed.push('20261105');
    expect(compare(ds)?.date).toBe('20261105');
    const shifted = newer(); shifted.calendars.WK!.start = '20261104';
    // T2 after midnight on Nov4 came from Nov3, which the new file never claimed to contain.
    expect(compare(shifted)).toBeUndefined();
  });
  it('uses actual after-midnight instants and the existing DST rule', () => {
    const ds = newer(); retime(ds, 'T2', 60);
    const result = compare(ds)!;
    expect(result.before[0]!.departure).toBe(serviceTimeToInstant('20261103', 87000, ds.meta.timezone));
    expect(result.after[0]!.departure - result.before[0]!.departure).toBe(60000);
    const a = old(), b = newer();
    for (const d of [a, b]) { d.calendars.WK!.days = [true,true,true,true,true,true,true]; d.calendars.WK!.start = '20261030'; }
    retime(b, 'T2', 60);
    const dst = compareCommute(a, b, favorite, '20261101')!;
    expect(dst.date).toBe('20261101');
    expect(dst.before[0]!.departure).toBe(serviceTimeToInstant('20261031', 87000, a.meta.timezone));
  });
  it('includes after-midnight buses on the final shared service day and spring-forward buses on the preceding local evening', () => {
    const a = old(), b = newer();
    for (const ds of [a,b]) {
      ds.trips = [ds.trips.find(t => t.id === 'T2')!];
      ds.calendars.WK = { start: '20261104', end: '20261104', days: [false,false,false,false,false,false,false], added: ['20261104'], removed: [] };
    }
    retime(b, 'T2', 60);
    expect(compareCommute(a,b,favorite,'20261104')?.date).toBe('20261105');
    expect(compareCommute(a,b,favorite,'20261105')?.date).toBe('20261105');
    for (const ds of [a,b]) {
      ds.calendars.WK = { start: '20270314', end: '20270314', days: [false,false,false,false,false,false,false], added: ['20270314'], removed: [] };
      ds.trips[0]!.times = [600,1200,2400]; ds.trips[0]!.arrivals = [600,1200,2400];
    }
    retime(b,'T2',60);
    expect(compareCommute(a,b,favorite,'20270313')?.date).toBe('20270313');
  });

  it('compares the saved trip’s actual paired return stops', () => {
    const a = old(), b = newer();
    for (const ds of [a, b]) {
      ds.stops.push({ id: 'home-back', name: 'Fictional return stop', twin: '1' });
      ds.patterns.push({ id: 'return', routeId: ds.routes[0]!.id, directionId: 1, headsign: 'Fictional home', stopIds: ['3','home-back'] });
      ds.trips.push({ id: 'return', patternId: 'return', serviceId: 'WK', times: [61200,63600], arrivals: [61200,63600] });
    }
    retime(b, 'return');
    expect(compareCommute(a, b, favorite, '20261104')?.after[0]!.direction).toBe('back');
  });
  it('does not invent changes when overlapping weekly files contain a thousand unchanged trips', () => {
    const a = old(), b = newer();
    for (const ds of [a,b]) {
      const trip = ds.trips.find(t => t.id === 'T1')!;
      ds.trips = Array.from({ length: 1000 }, (_, i) => ({ ...trip, id: `${ds.meta.feedVersion}-${i}` }));
      ds.calendars.WK!.start = ds === a ? '20261102' : '20261109';
      ds.calendars.WK!.end = ds === a ? '20261116' : '20261123';
    }
    expect(compareCommute(a,b,favorite,'20261109')).toBeUndefined();
  });
  it('never guesses a cancellation when copies have no future overlap; excludes printed/demo/different timezone', () => {
    const ds = newer(); ds.calendars.WK!.start = '20270501'; ds.calendars.WK!.end = '20270510'; ds.calendars.HOL!.added = [];
    expect(compare(ds)?.kind).toBe('uncomparable');
    expect(compareCommute(old(), newer(), favorite, '20270502')?.kind).toBe('uncomparable');
    const demo = newer(); demo.meta.demo = true; expect(compare(demo)).toBeUndefined();
    const printed = newer(); printed.meta.transcribed = { issued: '20261101', documentId: 'fictional' }; expect(compare(printed)).toBeUndefined();
    const other = newer(); other.meta.timezone = 'UTC'; expect(compare(other)).toBeUndefined();
    expect(compare(old())).toBeUndefined();
  });
});

describe('notice lifetime and atomic persistence', () => {
  it('establishes a baseline, preserves unread notices across updates, and respects new/edited/removed favorites', () => {
    const a = advanceCommuteChanges(undefined, old(), [favorite], NOW);
    expect(a.notices).toEqual([]);
    const ds = newer(); retime(ds);
    const b = advanceCommuteChanges(a, ds, [{ ...favorite, label: 'Renamed' }], NOW);
    expect(b.notices).toHaveLength(1);
    const third = structuredClone(ds); third.meta.feedVersion = 'fixture-v3'; retime(third);
    const c = advanceCommuteChanges(b, third, [favorite], NOW + 3600000);
    expect(c.notices).toHaveLength(2);
    expect(advanceCommuteChanges(c, third, [favorite], NOW + 1000000000).notices).toHaveLength(2);
    expect(advanceCommuteChanges(a, ds, [{ ...favorite, routeIds: ['changed'] }], NOW).notices).toEqual([]);
    expect(advanceCommuteChanges(a, ds, [{ ...favorite, id: 'new' }], NOW).notices).toEqual([]);
    expect(advanceCommuteChanges(c, third, [], NOW).notices).toEqual([]);
    expect(favoriteKey(favorite)).toBe(favoriteKey({ ...favorite, label: 'Different name' }));
    expect(favorite).toEqual({ id: 'fictional-commute', label: 'Fictional commute', fromStopId: '1', toStopId: '3', routeIds: [] });
  });
  it('saves notices and baseline together, survives reload, and never regenerates a dismissed same-version notice', async () => {
    let raw: unknown;
    const persistence = { read: async () => structuredClone(raw), write: async (state: unknown) => { raw = structuredClone(state); } };
    const store = createCommuteChangeStore(persistence);
    await store.advance(old(), [favorite], NOW);
    const ds = newer(); retime(ds);
    const b = (await store.advance(ds, [favorite], NOW))!;
    expect(b.durable).toBe(true); expect(parseCommuteChangeState(raw)?.baseline.meta.feedVersion).toBe('fixture-v2');
    const reload = createCommuteChangeStore(persistence);
    expect((await reload.advance(ds, [favorite], NOW))!.state.notices).toHaveLength(1);
    await reload.dismiss(b.state.notices[0]!.id);
    const again = createCommuteChangeStore(persistence);
    expect((await again.advance(ds, [favorite], NOW))!.state.notices).toEqual([]);
  });
  it('keeps a newer baseline when an offline or already-open older tab updates its favorites', async () => {
    let raw: unknown;
    const persistence = { read: async () => structuredClone(raw), write: async (state: unknown) => { raw = structuredClone(state); } };
    const tabA = createCommuteChangeStore(persistence), tabB = createCommuteChangeStore(persistence);
    await tabA.advance(old(), [favorite], NOW);
    const ds = newer(); ds.meta.builtAt = '2026-11-04T11:00:00Z'; retime(ds);
    const updated = (await tabB.advance(ds, [favorite], NOW))!;
    await tabB.dismiss(updated.state.notices[0]!.id);
    const stale = (await tabA.advance(old(), [favorite], NOW, false))!;
    expect(stale.state.baseline.meta.feedVersion).toBe('fixture-v2'); expect(stale.state.notices).toEqual([]);
    expect((await tabA.advance(old(), [favorite], NOW))!.state.baseline.meta.feedVersion).toBe('fixture-v2');
  });

  it('serializes updates and dismissal, rejects corrupt cached state, and degrades truthfully to session memory', async () => {
    const unavailable = createCommuteChangeStore({ read: async () => { throw Error('blocked'); }, write: async () => { throw Error('blocked'); } });
    await unavailable.advance(old(), [favorite], NOW);
    const ds = newer(); retime(ds);
    const b = await unavailable.advance(ds, [favorite], NOW);
    expect(b?.durable).toBe(false); expect(b?.state.notices).toHaveLength(1);
    await unavailable.dismiss(b!.state.notices[0]!.id);
    expect((await unavailable.advance(ds, [favorite], NOW))?.state.notices).toEqual([]);
    expect(parseCommuteChangeState({ version: 1, baseline: old(), favoriteKeys: [], notices: [{ kind: 'bad' }] })).toBeUndefined();
    expect(parseCommuteChangeState({ version: 1, baseline: {}, favoriteKeys: [], notices: [] })).toBeUndefined();
    const same = createCommuteChangeStore({ read: async () => undefined, write: async () => undefined });
    const calls = [same.advance(old(), [favorite], NOW), same.advance(ds, [favorite], NOW)];
    await Promise.all(calls); expect((await same.advance(ds, [favorite], NOW))?.state.notices).toHaveLength(1);
  });
});
