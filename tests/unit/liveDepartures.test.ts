import { describe, expect, it } from 'vitest';
import { departureEvidence, departureKey, parseDepartureBatch, readDepartureRequests, requestFor, type DepartureBatch } from '../../src/domain/liveDepartures';
import { summarizeDepartures } from '../../worker/departures';
import { createNormalizer } from '../../worker/normalize';
import { createFeedClass, createRouter } from '../../worker/service';
import { upcomingCandidates, selectUpcoming } from '../../src/domain/upcoming';
import { departuresOn } from '../../src/domain/schedule';
import { LIVE_SOURCE } from '../../src/domain/liveBus';
import { liveDataset as ds, NOW, binaryFeed, vehicle, update, descriptor } from '../helpers/liveBus';
const q = { tripId: 'T1', serviceDate: '20261104', stopIndex: 1, toStopIndex: 2 };
const normalize = createNormalizer(ds);
const positions = () => normalize(binaryFeed([{ id: 'v', vehicle: vehicle() }]), 'vehicles', NOW);
const updates = (patch = {}) => normalize(binaryFeed([{ id: 'u', tripUpdate: update(patch) }]), 'updates', NOW);
function batch(patch = {}): DepartureBatch {
  const v = positions(), u = updates(patch);
  return { v: 1, source: LIVE_SOURCE, feedVersion: ds.meta.feedVersion, receivedAt: NOW, vehicles: v.feed, updates: u.feed, items: summarizeDepartures(ds,[q], v, u, NOW) };
}
describe('exact stop-specific upcoming arrivals', () => {
  it('round-trips a fresh official boarding prediction without selecting/locking a GPS bus', () => {
    const b = parseDepartureBatch(batch(), ds, [q], NOW), item = b.items[0]!;
    expect(departureEvidence(b, item, NOW)).toMatchObject({ kind: 'live', boarding: { stopIndex: 1, at: NOW + 300_000 }, gpsObservedAt: NOW - 15_000 });
    const noGps = { ...b, vehicles: { state: 'unavailable' as const } };
    expect(departureEvidence(noGps, item, NOW).kind).toBe('live');
  });
  it('uses an explicit street-stop arrival when no departure is available, but never treats PABT staging as a departure', () => {
    const u = updates({ stopTimeUpdate: [{ stopId: '2', arrival: { time: NOW / 1000 + 300 } }] });
    const b = { ...batch(), items: summarizeDepartures(ds, [q], positions(), u, NOW) };
    expect(departureEvidence(parseDepartureBatch(b, ds, [q], NOW), b.items[0], NOW).boarding?.kind).toBe('arrival');
    const terminal = structuredClone(ds); terminal.stops.find(s => s.id === '2')!.terminal = 'PABT';
    expect(summarizeDepartures(terminal, [q], positions(), u, NOW)[0]?.boardingArrival).toBeUndefined();
    expect(() => parseDepartureBatch(b, terminal, [q], NOW)).toThrow();
  });
  it('rejects impossible arrival/departure ordering as conflicting source reports', () => {
    for (const stops of [
      [{ stopId: '2', arrival: { time: NOW / 1000 + 400 }, departure: { time: NOW / 1000 + 300 } }],
      [{ stopId: '2', departure: { time: NOW / 1000 + 400 } }, { stopId: '3', arrival: { time: NOW / 1000 + 300 } }],
    ]) { const b = batch({ stopTimeUpdate: stops }); expect(departureEvidence(b, b.items[0], NOW).kind).toBe('ambiguous'); }
  });
  it('accepts a validated response arriving between app clock ticks without refreshing source timestamps', () => {
    const b = batch(); b.receivedAt = NOW + 5000;
    expect(departureEvidence(parseDepartureBatch(b, ds, [q], NOW), b.items[0], NOW).kind).toBe('live');
    expect(b.items[0]?.departure?.observedAt).toBe(NOW - 20_000);
  });
  it('does not turn GPS alone or a prediction at another stop into a live boarding estimate', () => {
    const b = batch({ stopTimeUpdate: [{ stopId: '3', arrival: { time: NOW / 1000 + 1800 } }] });
    const e = departureEvidence(b, b.items[0], NOW);
    expect(e.kind).toBe('no-prediction'); expect(e.boarding).toBeUndefined(); expect(e.arrival?.stopIndex).toBe(2); expect(e.gpsObservedAt).toBeDefined();
  });
  it.each(['stale', 'unavailable', 'invalid'] as const)('rejects an %s update feed despite fresh GPS', (state) => {
    const b = batch(); b.updates.state = state;
    expect(departureEvidence(b, b.items[0], NOW).boarding).toBeUndefined();
  });
  it('expires source, prediction and receipt ages independently and never confirms a passed prediction', () => {
    const b = batch();
    expect(departureEvidence(b, b.items[0], NOW + 121_000).kind).toBe('stale');
    b.receivedAt = NOW + 180_000; b.updates.timestamp = NOW + 180_000;
    expect(departureEvidence(b, b.items[0], NOW + 180_000).kind).toBe('no-prediction');
    const passed = batch({ stopTimeUpdate: [{ stopId: '2', departure: { time: NOW / 1000 - 1 } }] });
    expect(departureEvidence(passed, passed.items[0], NOW).kind).toBe('passed');
  });
  it('separates official cancellation, boarding skip and destination skip from missing data', () => {
    for (const [patch, kind] of [
      [{ trip: { ...descriptor, scheduleRelationship: 3 } }, 'cancelled'],
      [{ stopTimeUpdate: [{ stopId: '2', scheduleRelationship: 1 }] }, 'boarding-skipped'],
      [{ stopTimeUpdate: [{ stopId: '3', scheduleRelationship: 1 }] }, 'destination-skipped'],
    ] as const) { const b = batch(patch); expect(departureEvidence(b, b.items[0], NOW).kind).toBe(kind); }
  });
  it('rejects conflicting updates, predictions or multiple vehicles rather than picking one', () => {
    const b = batch(), v = positions(), u = updates();
    for (const points of [[...v.observations, { ...v.observations[0]!, vehicleId: 'another' }], v.observations]) {
      const manyUpdates = points.length === 1 ? { ...u, updates: [u.updates[0]!, u.updates[0]!] } : u;
      const item = summarizeDepartures(ds,[q], { ...v, observations: points }, manyUpdates, NOW)[0];
      expect(departureEvidence(b, item, NOW).kind).toBe('ambiguous');
    }
    const duplicates = batch({ stopTimeUpdate: [{ stopId: '2', departure: { time: NOW / 1000 + 300 } }, { stopId: '2', departure: { time: NOW / 1000 + 400 } }] });
    expect(departureEvidence(duplicates, duplicates.items[0], NOW).kind).toBe('ambiguous');
  });
  it('explains an actually observed unresolved trip date without inferring today', () => {
    // 2:20 AM: outside every active day's window for the 7:00 AM trip, so no date fits.
    const v = normalize(binaryFeed([{ id: 'v', vehicle: vehicle({ trip: { tripId: 'T1', routeId: '10' }, timestamp: NOW / 1000 - 5 * 3600 }) }]), 'vehicles', NOW);
    expect(v.observations).toEqual([]);
    expect(v.unresolvedDateTrips).toEqual(['T1']);
    const u = { ...updates(), updates: [] }, b = { ...batch(), items: summarizeDepartures(ds,[q], v, u, NOW) };
    expect(departureEvidence(b, b.items[0], NOW).kind).toBe('date-unknown');
  });
  it('rejects incompatible/malformed/misbound response fields before rendering', () => {
    const b = batch();
    for (const bad of [ { ...b, source: 'invented' }, { ...b, feedVersion: 'wrong' }, { ...b, receivedAt: NOW + 31_000 },
      { ...b, items: [] }, { ...b, items: [{ ...b.items[0], query: { ...q, stopIndex: 0 } }] },
      { ...b, items: [{ ...b.items[0], departure: { ...b.items[0]!.departure, stopIndex: 0 } }] },
      { ...b, items: [{ ...b.items[0], gpsObservedAt: NOW + 1 }] },
      { ...b, items: [{ ...b.items[0], updatedAt: NOW - 60_000 }] },
    ]) expect(() => parseDepartureBatch(bad, ds, [q], NOW)).toThrow();
  });
  it('keeps an officially delayed past-scheduled bus, orders by qualified time and preserves its exact identity', () => {
    const now = NOW + 5 * 60_000, set = upcomingCandidates(ds, { stopId: '2', toStopId: '3' }, now, 3);
    expect(set.candidates.some(d => d.tripId === 'T1')).toBe(true);
    expect(selectUpcoming(set, () => undefined, now, 3).some(d => d.tripInstanceId === 'T1@20261104')).toBe(false);
    const rows = selectUpcoming(set, d => d.tripInstanceId === 'T1@20261104' ? { kind: 'live', boarding: { stopIndex: 1, at: now + 300_000, observedAt: now, kind: 'departure' } } : undefined, now, 3);
    expect(rows[0]?.tripInstanceId).toBe('T1@20261104'); expect(requestFor(rows[0]!, '3')).toEqual(q); expect(rows[0]?.departs).toBe(NOW);
  });
});
describe('bounded read-only departure batch on the existing relay', () => {
  it('validates every trip/date/boarding/destination and bounds/deduplicates the batch before upstream work', () => {
    expect(readDepartureRequests(ds, JSON.stringify([q]))).toEqual([q]);
    for (const values of [[], [q, q], Array(51).fill(q), [{ ...q, serviceDate: '20261107' }], [{ ...q, stopIndex: -1 }], [{ ...q, toStopIndex: 1 }], [{ ...q, tripId: 'unknown' }]])
      expect(() => readDepartureRequests(ds, JSON.stringify(values))).toThrow();
    expect(departureKey(q)).not.toBe(departureKey({ ...q, stopIndex: 0 }));
  });
  it('uses the same token and globally coalesced poll across normal-home and locked-trip requests', async () => {
    const saved = new Map<string, unknown>(), calls: string[] = [];
    const ctx = { storage: { get: async <T,>(key: string) => saved.get(key) as T | undefined, put: async (key: string, value: unknown) => { saved.set(key, value); } }, blockConcurrencyWhile: async <T,>(f: () => Promise<T>) => f() };
    const net = (async (url: RequestInfo | URL) => { calls.push(String(url)); return String(url).endsWith('authenticateUser') ? Response.json({ Authenticated: true, UserToken: 'synthetic-private' }) : new Response(new Uint8Array(binaryFeed(String(url).endsWith('getVehiclePositions') ? [{ id: 'v', vehicle: vehicle() }] : [{ id: 'u', tripUpdate: update() }])).buffer); }) as typeof fetch;
    const Feed = createFeedClass(ds, net, () => NOW), env = { NJT_API_USERNAME: 'synthetic', NJT_API_PASSWORD: 'synthetic', FEED: { idFromName: () => 'one', get: () => object } }, object = new Feed(ctx, env), router = createRouter(ds);
    const url = 'https://dale-live.test.workers.dev/v1/departures?q=' + encodeURIComponent(JSON.stringify([q]));
    for (const query of ['bad-json', JSON.stringify([{ ...q, stopIndex: 20 }])]) expect((await router.fetch(new Request(url.slice(0, url.indexOf('?')) + '?q=' + encodeURIComponent(query)), env)).status).toBe(400);
    expect(calls).toHaveLength(0);
    const results = await Promise.all([router.fetch(new Request(url), env), router.fetch(new Request('https://dale-live.test.workers.dev/v1/live?trip=T1&date=20261104'), env)]);
    const text = await results[0]!.text(); expect(text).not.toContain('synthetic-private');
    expect(parseDepartureBatch(JSON.parse(text), ds, [q], NOW).items[0]?.departure?.at).toBe(NOW + 300_000); expect(calls).toHaveLength(3);
  });
});


describe('bounded coalesced GPS distance evidence', () => {
  it('delivers and validates only the original exact-trip observation, with its actual timestamp', () => {
    const b = parseDepartureBatch(batch(), ds, [q], NOW), item = b.items[0]!;
    expect(item.gps).toEqual(positions().observations[0]);
    expect(item.gps?.observedAt).toBe(item.gpsObservedAt);
    for (const patch of [{ tripInstanceId: 'T2@20261104' }, { observedAt: NOW }, { lat: 91 }, { vehicleId: '' }]) {
      const bad = structuredClone(b); Object.assign(bad.items[0]!.gps!, patch);
      expect(() => parseDepartureBatch(bad, ds, [q], NOW)).toThrow();
    }
  });
  it('keeps a valid boarding prediction independently live when contradictory GPS prevents distance', () => {
    const v = positions(), point = v.observations[0]!;
    const item = summarizeDepartures(ds, [q], { ...v, observations: [point, { ...point, lat: point.lat + .001 }] }, updates(), NOW)[0]!;
    const b = { ...batch(), items: [item] };
    expect(parseDepartureBatch(b, ds, [q], NOW).items[0]?.gpsProblem).toBe('ambiguous');
    expect(item.gps).toBeUndefined(); expect(departureEvidence(b, item, NOW).kind).toBe('live');
    const contradiction = { ...b, items: [{ ...item, gps: point }] };
    expect(() => parseDepartureBatch(contradiction, ds, [q], NOW)).toThrow();
  });
  it('omits GPS coordinates for equal-time contradictory samples, uncertain dates or multiple vehicles', () => {
    const v = positions(), point = v.observations[0]!;
    for (const bad of [
      { ...v, observations: [point, { ...point, lat: point.lat + .001 }] },
      { ...v, observations: [point, { ...point, vehicleId: 'another' }] },
      { ...v, unresolvedDateTrips: [q.tripId] },
    ]) expect(summarizeDepartures(ds, [q], bad, updates(), NOW)[0]?.gps).toBeUndefined();
  });
});
