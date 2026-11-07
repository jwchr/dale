import { describe, expect, it } from 'vitest';
import { createBusSession, reduceBusSession } from '../../src/domain/busLock';
import { observedDestinationArrival, reportedDestinationArrival, saveLastArrival, readLastArrival, ARRIVAL_KEY, ARRIVAL_RETENTION_MS } from '../../src/domain/destinationArrival';
import { departuresOn } from '../../src/domain/schedule';
import { createNormalizer } from '../../worker/normalize';
import { parseLiveSnapshot, LIVE_SOURCE } from '../../src/domain/liveBus';
import { liveDataset as ds, NOW, vehicle, binaryFeed } from '../helpers/liveBus';
const dep = departuresOn(ds, { stopId: '2', date: '20261104' }).find(d => d.tripId === 'T1')!;
const stop = ds.stops.find(s => s.id === '3')!;
function session(patch = {}) {
  let s = createBusSession(dep, NOW - 600000);
  s = reduceBusSession(s, { type: 'feed_status', state: 'ok', tripInstanceId: dep.tripInstanceId, now: NOW - 1000 });
  return reduceBusSession(s, { type: 'observation', source: 'official', receivedAt: NOW, obs: { tripInstanceId: dep.tripInstanceId, vehicleId: 'bus-A', lat: stop.lat!, lon: stop.lon!, observedAt: NOW - 15000, stopCall: { stopId: '3', stopIndex: 2, status: 'stopped_at' }, ...patch } });
}
describe('destination evidence is distinct and stable', () => {
  it('freezes first explicit stopped-at observation, keeping schedule and source, through ride completion', () => {
    let s = session(); const arrival = observedDestinationArrival(ds, s, 2, NOW)!;
    expect(arrival).toMatchObject({ source: 'njt_stopped_at', at: NOW - 15000, recordedAt: NOW, tripInstanceId: dep.tripInstanceId, stopId: '3', vehicleId: 'bus-A' });
    expect(arrival.scheduledAt).toBeDefined();
    s = reduceBusSession(s, { type: 'destination_arrival', arrival, now: NOW });
    const later = { ...arrival, at: NOW + 10000, recordedAt: NOW + 10000 };
    s = reduceBusSession(s, { type: 'destination_arrival', arrival: later, now: NOW + 10000 });
    expect(s.destinationArrival).toEqual(arrival);
    expect(reduceBusSession(s, { type: 'end', now: NOW + 20000 }).destinationArrival).toEqual(arrival);
  });
  it.each([
    { stopCall: undefined }, { stopCall: { stopId: '2', stopIndex: 1, status: 'stopped_at' } },
    { lat: 40.8 }, { observedAt: NOW - 180000 }, { tripInstanceId: 'T1@20261105' }, { observedAt: NOW + 1000 },
  ])('never confirms a nearby, stale, boarding, wrong-date or future report: %j', patch => {
    expect(observedDestinationArrival(ds, session(patch), 2, NOW)).toBeUndefined();
  });
  it('blocks staging, skipped destinations, missing feeds, unresolved identity and old receipt', () => {
    for (const s of [
      { ...session(), officialFeed: { state: 'missing' as const, checkedAt: NOW } },
      { ...session(), stopChanges: { indices: [2], observedAt: NOW } },
      { ...session(), lock: { ...session().lock, status: 'needs_confirmation' as const } },
    ]) expect(observedDestinationArrival(ds, s, 2, NOW)).toBeUndefined();
    expect(observedDestinationArrival(ds, session(), 2, NOW + 180000)).toBeUndefined();
    const changed = structuredClone(ds); changed.stops.find(s => s.id === '2')!.terminal = 'PABT';
    const start = departuresOn(changed, { stopId: '1', date: '20261104' }).find(d => d.tripId === 'T1')!;
    const s = session({ stopCall: { stopId: '2', stopIndex: 1, status: 'stopped_at' } }); s.departure = start;
    expect(observedDestinationArrival(changed, s, 1, NOW)).toBeUndefined();
  });
  it('manual destination confirmation is explicitly rider sourced and never inferred from boarding or getting off', () => {
    let s = createBusSession(dep, NOW - 600000);
    s = reduceBusSession(s, { type: 'start_waiting', now: NOW - 500000 });
    s = reduceBusSession(s, { type: 'arrived', now: NOW - 400000 });
    expect(s.destinationArrival).toBeUndefined(); expect(reportedDestinationArrival(ds, s, 2, NOW)).toBeUndefined();
    s = reduceBusSession(s, { type: 'boarded', now: NOW - 300000 });
    expect(reportedDestinationArrival(ds, s, 2, NOW)).toMatchObject({ source: 'rider', at: NOW, stopId: '3' });
    expect(reduceBusSession(s, { type: 'end', now: NOW }).destinationArrival).toBeUndefined();
  });
});
describe('official stopped-at normalization', () => {
  const normalize = createNormalizer(ds);
  it('keeps explicit agreed selectors; an absent/default status or conflicting selector proves nothing', () => {
    const good = normalize(binaryFeed([{ id: 'v', vehicle: vehicle({ currentStatus: 1, stopId: '3', currentStopSequence: 3 }) }]), 'vehicles', NOW);
    expect(good.observations[0]?.stopCall).toEqual({ stopId: '3', stopIndex: 2, status: 'stopped_at' });
    for (const patch of [{ stopId: '3' }, { currentStatus: 2, stopId: '3' }, { currentStatus: 1 }, { currentStatus: 1, stopId: '3', currentStopSequence: 2 }])
      expect(normalize(binaryFeed([{ id: 'v', vehicle: vehicle(patch) }]), 'vehicles', NOW).observations[0]?.stopCall).toBeUndefined();
  });
  it('checks stop-call metadata against each observation’s own canonical trip', () => {
    const s = session(), value = { v: 1, source: LIVE_SOURCE, feedVersion: ds.meta.feedVersion, tripInstanceId: dep.tripInstanceId, receivedAt: NOW,
      vehicles: { state: 'ok' }, updates: { state: 'ok' }, observations: [s.lock.last], predictions: [], skippedStops: [] };
    expect(parseLiveSnapshot(value, ds, dep.tripId, dep.serviceDate, NOW).observations[0]?.stopCall?.stopId).toBe('3');
    value.observations[0] = { ...s.lock.last!, stopCall: { stopId: '2', stopIndex: 2, status: 'stopped_at' } };
    expect(() => parseLiveSnapshot(value, ds, dep.tripId, dep.serviceDate, NOW)).toThrow();
  });
});
describe('one minimal local arrival result', () => {
  it('survives ride completion/reload, expires, and dismissal cannot resurrect from a resumed lock', () => {
    const map = new Map<string, string>(), store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v), removeItem: (k: string) => { map.delete(k); } };
    const arrival = observedDestinationArrival(ds, session(), 2, NOW)!;
    saveLastArrival(store, { ...arrival, lat: 40 } as typeof arrival);
    expect(map.get(ARRIVAL_KEY)).not.toContain('lat'); expect(readLastArrival(store, NOW)).toEqual(arrival);
    saveLastArrival(store, undefined, NOW + 1000);
    expect(readLastArrival(store, NOW + 1000)).toBeUndefined(); expect(saveLastArrival(store, arrival, NOW + 2000)).toBe(false);
    expect(readLastArrival(store, NOW + 2000)).toBeUndefined();
    saveLastArrival(store, { ...arrival, at: NOW + 5000, recordedAt: NOW + 5000 });
    expect(readLastArrival(store, NOW + 5000)).toBeDefined();
    expect(readLastArrival(store, NOW + ARRIVAL_RETENTION_MS + 6000)).toBeUndefined();
    map.set(ARRIVAL_KEY, '{broken'); expect(() => readLastArrival(store, NOW)).not.toThrow();
    saveLastArrival(store, arrival, NOW); expect(readLastArrival(store, NOW)).toEqual(arrival);
    map.set(ARRIVAL_KEY, JSON.stringify({ clearedAt: NOW + 86400000 })); saveLastArrival(store, arrival, NOW);
    expect(readLastArrival(store, NOW)).toEqual(arrival);
  });
});
