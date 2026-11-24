import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEarlierDomain, parseEarlierQuery, type EarlierState } from '../../src/domain/earlierBuses';
import { pollWhileVisible } from '../../src/ui/EarlierBuses';
import { liveDataset } from '../helpers/liveBus';
import type { Dataset } from '../../src/domain/types';

// Audit batch B (Nov 24, 2026): Earlier buses treats every Port Authority stop ID as one place,
// reads Port Authority arrival at the final terminal call, and polls only the newest, visible request.
const now = Date.parse('2026-11-04T13:00:00Z');
const at = (clock: string) => Date.parse(`2026-11-04T${clock}:00-05:00`);
const fresh = (): EarlierState => ({ v: 1, context: 'ctx', checkpoint: now - 1, coverageStart: at('06:00'), through: now, gap: false, trips: {} });

function dataset(): Dataset {
  const ds = structuredClone(liveDataset);
  const route = ds.routes.find(r => r.shortName === '165')!.id;
  const base = ds.trips.find(t => t.id === 'T1')!;
  // '4' is the Port Authority drop-off before the final call '3'; '6' is another Port Authority gate.
  ds.stops.push({ id: '4', name: 'PORT AUTHORITY DROP OFF', terminal: 'PABT', lat: 40.7567, lon: -73.9921 });
  ds.stops.push({ id: '6', name: 'PORT AUTHORITY BUS TERMINAL GATE', terminal: 'PABT', lat: 40.7562, lon: -73.991 });
  ds.patterns.push({ ...ds.patterns.find(p => p.id === 'P1')!, id: 'IN', routeId: route, directionId: 0, stopIds: ['1', '2', '4', '3'], stopSequences: [1, 2, 3, 4] });
  ds.patterns.push({ ...ds.patterns.find(p => p.id === 'P1')!, id: 'OUT', routeId: route, directionId: 1, stopIds: ['6', '2', '1'], stopSequences: [1, 2, 3] });
  ds.trips.push({ ...base, id: 'IN1', patternId: 'IN', times: [25200, 26400, 27500, 27600], arrivals: [25200, 26400, 27500, 27600] });
  ds.trips.push({ ...base, id: 'OUT1', patternId: 'OUT', times: [25800, 27000, 28200], arrivals: [25800, 27000, 28200] });
  return ds;
}
const seen = (ds: Dataset, trip: string, index: number, clock: string) => {
  const pattern = ds.patterns.find(p => p.id === ds.trips.find(t => t.id === trip)!.patternId)!;
  return { observation: { tripInstanceId: `${trip}@20261104`, observedAt: at(clock), stopCall: { status: 'stopped_at', stopIndex: index, stopId: pattern.stopIds[index]! } } };
};

describe('Earlier buses at Port Authority', () => {
  it('accepts and answers a Port Authority stop ID the trip does not use exactly', () => {
    const ds = dataset(), d = createEarlierDomain(ds), state = fresh();
    const query = parseEarlierQuery(new URLSearchParams({ route: '165', stop: '3', direction: '1' }), ds);
    expect(query).toEqual({ route: '165', stop: '3', direction: 1 });
    d.fold(state, { records: [seen(ds, 'OUT1', 0, '07:12'), seen(ds, 'OUT1', 1, '07:31')] }, now);
    const items = d.answer(state, query!, now).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ route: '165', direction: 1, stop: { scheduledAt: at('07:10'), evidence: { kind: 'gps', at: at('07:12'), minutesLate: 2 } }, portAuthority: null });
  });

  it('still rejects a stop no pattern of that route and direction serves', () => {
    const ds = dataset();
    expect(parseEarlierQuery(new URLSearchParams({ route: '165', stop: '6', direction: '0' }), ds)).toEqual({ route: '165', stop: '6', direction: 0 });
    expect(parseEarlierQuery(new URLSearchParams({ route: '165', stop: 'nowhere', direction: '1' }), ds)).toBeUndefined();
  });

  it('reports Port Authority arrival at the final terminal call, not the drop-off before it', () => {
    const ds = dataset(), d = createEarlierDomain(ds), state = fresh();
    d.fold(state, { records: [seen(ds, 'IN1', 0, '07:01'), seen(ds, 'IN1', 1, '07:22'), seen(ds, 'IN1', 2, '07:38'), seen(ds, 'IN1', 3, '07:42')] }, now);
    const bus = d.answer(state, { route: '165', stop: '1', direction: 0 }, now).items.find(b => b.stop.scheduledAt === at('07:00'))!;
    expect(bus.portAuthority).toMatchObject({ scheduledAt: at('07:40'), evidence: { kind: 'gps', at: at('07:42'), minutesLate: 2 } });
  });

  it('does not list a bus as gone from Port Authority when it was only seen at the drop-off', () => {
    const ds = dataset(), d = createEarlierDomain(ds), state = fresh();
    d.fold(state, { records: [seen(ds, 'IN1', 2, '07:38')] }, now);
    expect(d.answer(state, { route: '165', stop: '4', direction: 0 }, now).items).toEqual([]);
  });
});

describe('pollWhileVisible', () => {
  afterEach(() => vi.useRealTimers());
  const fakeDoc = () => {
    const listeners = new Set<() => void>();
    return {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_: string, f: () => void) => listeners.add(f),
      removeEventListener: (_: string, f: () => void) => listeners.delete(f),
      fire() { listeners.forEach(f => f()); }, listeners,
    };
  };

  it('skips polls while hidden and loads again when the tab is shown', () => {
    vi.useFakeTimers();
    const doc = fakeDoc(), load = vi.fn();
    const end = pollWhileVisible(load, doc as never, 60_000);
    expect(load).toHaveBeenCalledTimes(1);
    doc.visibilityState = 'hidden';
    vi.advanceTimersByTime(180_000); doc.fire();
    expect(load).toHaveBeenCalledTimes(1);
    doc.visibilityState = 'visible'; doc.fire();
    expect(load).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(load).toHaveBeenCalledTimes(3);
    end();
    expect(doc.listeners.size).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('lets only the newest run show its answer when an older one finishes late', async () => {
    vi.useFakeTimers();
    const doc = fakeDoc(), shown: number[] = [], resolvers: (() => void)[] = [];
    let run = 0;
    const end = pollWhileVisible(isLatest => {
      const mine = ++run;
      return new Promise<void>(resolve => resolvers.push(() => { if (isLatest()) shown.push(mine); resolve(); }));
    }, doc as never, 60_000);
    vi.advanceTimersByTime(60_000);
    resolvers[1]!(); resolvers[0]!();
    await Promise.resolve();
    expect(shown).toEqual([2]);
    end();
  });
});
