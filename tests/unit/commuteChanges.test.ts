import { describe, expect, it, vi } from 'vitest';
import { advanceCommuteChanges, compareCommute, favoriteKey } from '../../src/domain/commuteChanges';
import { commuteChangeStore, createCommuteChangeStore, parseCommuteChangeState } from '../../src/data/commuteChangeStore';
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
      ds.stops.push({ id: 'home-back', name: 'Fictional return stop', twin: '1', lat: 40.8, lon: -74 });
      ds.patterns.push({ id: 'return', routeId: ds.routes[0]!.id, directionId: 1, headsign: 'Fictional home', stopIds: ['3','home-back'] });
      ds.trips.push({ id: 'return', patternId: 'return', serviceId: 'WK', times: [61200,63600], arrivals: [61200,63600] });
    }
    retime(b, 'return');
    expect(compareCommute(a, b, favorite, '20261104')?.after[0]!.direction).toBe('back');
    const moved = structuredClone(a); moved.meta.feedVersion = 'moved-return';
    moved.stops.find(s => s.id === 'home-back')!.lat! += .001;
    expect(compareCommute(a, moved, favorite, '20261104')?.kind).toBe('stops');
  });
  it('keeps checking the forward leg when a saved return stop was already missing from the old feed', () => {
    const f: Favorite = { ...favorite, returnStops: { fromStopId: '3', toStopId: 'gone-before' } };
    const b = newer(); retime(b);
    expect(compare(b, f)?.kind).toBe('timetable');
    const gone = newer(); gone.stops = gone.stops.filter(s => s.id !== '3');
    expect(compare(gone, f)?.kind).toBe('selection');
    const known = old(); known.stops.push({ id: 'gone-before', name: 'Fictional return stop', lat: 40.8, lon: -74 });
    expect(compareCommute(known, newer(), f, '20261104')?.kind).toBe('selection');
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

  it('uses the saved favorites under the lock rather than pruning another tab from a stale snapshot', async () => {
    let raw: unknown;
    let current = [favorite];
    const persistence = { read: async () => structuredClone(raw), write: async (state: unknown) => { raw = structuredClone(state); } };
    const make = () => createCommuteChangeStore(persistence, job => job(), () => current);
    const tabA = make(), tabB = make();
    await tabA.advance(old(), [favorite], NOW);
    const added = { ...favorite, id: 'added-in-other-tab' };
    current = [favorite, added];
    await tabB.advance(old(), current, NOW);
    const ds = newer(); ds.meta.builtAt = '2026-11-04T11:00:00Z'; retime(ds);
    expect((await tabB.advance(ds, current, NOW))!.state.notices).toHaveLength(2);
    expect((await tabA.advance(old(), [favorite], NOW, false))!.state.notices).toHaveLength(2);
    expect((await tabA.advance(ds, [favorite], NOW))!.state.notices).toHaveLength(2);
    expect(parseCommuteChangeState(raw)?.favoriteKeys).toContain(favoriteKey(added));
    current = [favorite];
    expect((await tabA.advance(ds, [favorite, added], NOW, false))!.state.notices).toHaveLength(1);
  });

  for (const failure of ['read', 'write'] as const) it(`stays session-only after a ${failure} failure instead of overwriting another tab on recovery`, async () => {
    let raw: unknown, blocked = false, writes = 0;
    const persistence = { read: async () => structuredClone(raw), write: async (state: unknown) => { raw = structuredClone(state); } };
    const tabA = createCommuteChangeStore({
      read: async () => { if (blocked && failure === 'read') throw Error('temporary read failure'); return persistence.read(); },
      write: async state => { writes++; if (blocked && failure === 'write') throw Error('temporary write failure'); await persistence.write(state); },
    });
    const tabB = createCommuteChangeStore(persistence);
    await tabA.advance(old(), [favorite], NOW);
    blocked = true;
    expect((await tabA.advance(old(), [favorite], NOW))?.durable).toBe(false);
    const ds = newer(); ds.meta.builtAt = '2026-11-04T11:00:00Z'; retime(ds);
    const updated = (await tabB.advance(ds, [favorite], NOW))!;
    await tabB.dismiss(updated.state.notices[0]!.id);
    const before = structuredClone(raw), attempts = writes;
    blocked = false;
    expect((await tabA.advance(old(), [favorite], NOW))?.durable).toBe(false);
    expect(writes).toBe(attempts);
    expect(raw).toEqual(before);
    expect(parseCommuteChangeState(raw)?.baseline.meta.feedVersion).toBe('fixture-v2');
    expect(parseCommuteChangeState(raw)?.notices).toEqual([]);
    expect((await createCommuteChangeStore(persistence).advance(ds, [favorite], NOW))?.durable).toBe(true);
  });

  it('never prunes durable notices if the saved favorites cannot be read', async () => {
    const ds = newer(); retime(ds);
    let raw: unknown = advanceCommuteChanges(advanceCommuteChanges(undefined, old(), [favorite], NOW), ds, [favorite], NOW);
    const before = structuredClone(raw);
    const store = createCommuteChangeStore({ read: async () => structuredClone(raw), write: async state => { raw = structuredClone(state); } }, job => job(), () => undefined);
    expect((await store.advance(ds, [], NOW))?.durable).toBe(false);
    expect(raw).toEqual(before);
  });

  for (const payload of ['{broken', '{}', '[{}]', '[null]', '']) it(`preserves notice history when the favorites payload is damaged: ${JSON.stringify(payload)}`, async () => {
    const ds = newer(); retime(ds);
    let raw = advanceCommuteChanges(advanceCommuteChanges(undefined, old(), [favorite], NOW), ds, [favorite], NOW);
    const before = structuredClone(raw);
    vi.stubGlobal('caches', { open: async () => ({ match: async () => new Response(JSON.stringify(raw)), put: async (_key: string, response: Response) => { raw = await response.json(); } }) });
    vi.stubGlobal('navigator', { locks: { request: (_key: string, job: () => Promise<unknown>) => job() } });
    try {
      const store = commuteChangeStore('https://fixture.test/corrupt/' + encodeURIComponent(payload), { getItem: () => payload });
      const result = await store.advance(ds, [], NOW);
      expect(raw).toEqual(before);
      expect(result?.durable).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  for (const mode of ['missing', 'rejected'] as const) it(`never durably replaces notice history when cross-tab locking is ${mode}`, async () => {
    const ds = newer(); retime(ds);
    let raw = advanceCommuteChanges(advanceCommuteChanges(undefined, old(), [favorite], NOW), ds, [favorite], NOW);
    const before = structuredClone(raw);
    let writes = 0;
    vi.stubGlobal('caches', { open: async () => ({ match: async () => new Response(JSON.stringify(raw)), put: async (_key: string, response: Response) => { writes++; raw = await response.json(); } }) });
    vi.stubGlobal('navigator', { locks: mode === 'missing' ? undefined : { request: async () => { throw Error('lock refused'); } } });
    try {
      const store = commuteChangeStore('https://fixture.test/locks/' + mode, { getItem: () => JSON.stringify([favorite]) });
      expect((await store.advance(ds, [favorite], NOW))?.durable).toBe(false);
      expect((await store.dismiss(before.notices[0]!.id))?.state.notices).toEqual([]);
      expect(writes).toBe(0);
      expect(raw).toEqual(before);
    } finally { vi.unstubAllGlobals(); }
  });

  it('recovers if Web Lock acquisition rejects before entry, without replaying an entered callback', async () => {
    const denied = createCommuteChangeStore({ read: async () => { throw Error('storage blocked'); }, write: async () => { throw Error('storage blocked'); } }, async () => { throw Error('lock denied'); });
    expect((await denied.advance(old(), [favorite], NOW))?.durable).toBe(false);
    const ds = newer(); retime(ds);
    const result = (await denied.advance(ds, [favorite], NOW))!;
    expect(result.state.notices).toHaveLength(1);
    await denied.dismiss(result.state.notices[0]!.id);
    expect((await denied.advance(ds, [favorite], NOW))?.state.notices).toEqual([]);
    let writes = 0;
    const entered = createCommuteChangeStore({ read: async () => undefined, write: async () => { writes++; } }, async job => { await job(); throw Error('failed after entry'); });
    await expect(entered.advance(old(), [favorite], NOW)).rejects.toThrow('failed after entry');
    expect(writes).toBe(1);
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
