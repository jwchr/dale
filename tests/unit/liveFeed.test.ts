import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNormalizer } from '../../worker/normalize';
import { createFeedClass, createRouter } from '../../worker/service';
import { njtRequest, authenticate } from '../../worker/njt-client';
import { departuresOn } from '../../src/domain/schedule';
import { liveApiUrl, parseLiveSnapshot, LIVE_SOURCE } from '../../src/domain/liveBus';
import { createBusSession, reduceBusSession } from '../../src/domain/busLock';
import { gpsLost } from '../../src/domain/alternatives';
import { liveDataset as ds, NOW, binaryFeed, descriptor, vehicle, update } from '../helpers/liveBus';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const normalize = createNormalizer(ds);
const gps = () => binaryFeed([{ id: 'v', vehicle: vehicle() }]);
const updates = () => binaryFeed([{ id: 'u', tripUpdate: update() }]);
const dep = () => departuresOn(ds, { stopId: '2', date: '20261104' }).find((d) => d.tripId === 'T1')!;
const request = (path = '/v1/live?trip=T1&date=20261104') => new Request('https://dale-live.test.workers.dev' + path);
const creds = { NJT_API_USERNAME: 'synthetic-user', NJT_API_PASSWORD: 'synthetic-password' };
function harness(positions = gps) {
  let now = NOW;
  const saved = new Map<string, unknown>(), calls: string[] = [];
  const storage = { get: async <T,>(key: string) => structuredClone(saved.get(key)) as T | undefined, put: async (key: string, v: unknown) => { saved.set(key, structuredClone(v)); } };
  const ctx = { storage, blockConcurrencyWhile: async <T,>(fn: () => Promise<T>) => fn() };
  const net = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    if (String(url).endsWith('authenticateUser')) return Response.json({ Authenticated: 'True', UserToken: 'private-synthetic-token' });
    return new Response(new Uint8Array(String(url).endsWith('getVehiclePositions') ? positions() : updates()).buffer);
  }) as typeof fetch;
  const Feed = createFeedClass(ds, net, () => now);
  const env = { ...creds, FEED: { idFromName: (name: string) => name, get: () => object } };
  const object = new Feed(ctx, env);
  return { object, env, ctx, calls, Feed, saved, clock: (n: number) => { now = n; } };
}

describe('official GTFS-RT normalization', () => {
  it('decodes an exact canonical trip/date/route with its actual timestamp, and explicit stop prediction', () => {
    expect(normalize(gps(), 'vehicles', NOW)).toMatchObject({ feed: { state: 'ok', timestamp: NOW - 10_000 }, observations: [{ tripInstanceId: 'T1@20261104', vehicleId: 'bus-A', observedAt: NOW - 15_000 }] });
    expect(normalize(updates(), 'updates', NOW).updates[0]).toMatchObject({ cancelled: false, predictions: [{ stopIndex: 1, at: NOW + 300_000, observedAt: NOW - 20_000, kind: 'departure' }] });
  });
  it.each([
    { trip: { ...descriptor, startDate: '' } }, { trip: { ...descriptor, startDate: '20261344' } },
    { trip: { ...descriptor, routeId: 'other' } }, { trip: { ...descriptor, directionId: 1 } },
    { trip: { ...descriptor, startDate: '20261107' } }, { trip: { ...descriptor, tripId: 'not-in-static-feed' } },
    { trip: { ...descriptor, scheduleRelationship: 1 } }, { timestamp: 0 }, { timestamp: NOW / 1000 + 5 },
    { vehicle: {} }, { position: { latitude: 91, longitude: 0 } },
  ])('does not invent a match/measurement for unsupported descriptor or position: %j', (patch) => {
    expect(normalize(binaryFeed([{ id: 'v', vehicle: vehicle(patch) }]), 'vehicles', NOW).observations).toEqual([]);
  });
  it('distinguishes a deleted vehicle from an official trip cancellation', () => {
    expect(normalize(binaryFeed([{ id: 'v', isDeleted: true, vehicle: vehicle() }]), 'vehicles', NOW).observations).toEqual([]);
    expect(normalize(binaryFeed([{ id: 'u', tripUpdate: update({ trip: { ...descriptor, scheduleRelationship: 3 } }) }]), 'updates', NOW).updates[0]?.cancelled).toBe(true);
  });
  it('requires both stop selectors to agree and does not infer predictions from skipped/no-data stops or delays', () => {
    const stops = [
      { stopSequence: 2, stopId: '3', departure: { time: NOW / 1000 + 2 } },
      { stopSequence: 2, stopId: '2', scheduleRelationship: 1, departure: { time: NOW / 1000 + 2 } },
      { stopSequence: 3, stopId: '3', scheduleRelationship: 2, departure: { time: NOW / 1000 + 2 } },
      { stopSequence: 1, stopId: '1', departure: { delay: 300 } },
    ];
    const out = normalize(binaryFeed([{ id: 'u', tripUpdate: update({ stopTimeUpdate: stops }) }]), 'updates', NOW).updates[0]!;
    expect(out.predictions).toEqual([]); expect(out.skippedStops).toEqual([1]);
  });
  it('rejects malformed/differential/future feeds and keeps old timestamps stale', () => {
    expect(normalize(new Uint8Array([255]), 'vehicles', NOW).feed.state).toBe('invalid');
    expect(normalize(binaryFeed([], { incrementality: 1 }), 'vehicles', NOW).feed.state).toBe('invalid');
    expect(normalize(binaryFeed([], { timestamp: NOW / 1000 + 1 }), 'vehicles', NOW).feed.state).toBe('invalid');
    expect(normalize(gps(), 'vehicles', NOW + 180_000).feed).toEqual({ state: 'stale', timestamp: NOW - 10_000 });
  });
});

describe('single paced private live relay', () => {
  it('authenticates once, coalesces concurrent requests and never sends a token/password to clients', async () => {
    const h = harness();
    const responses = await Promise.all([h.object.fetch(request()), h.object.fetch(request()), h.object.fetch(request())]);
    expect(h.calls).toHaveLength(3);
    for (const response of responses) {
      const text = await response.text(); expect(text).not.toContain('private-synthetic-token'); expect(text).not.toContain(creds.NJT_API_PASSWORD);
      const snapshot = parseLiveSnapshot(JSON.parse(text), ds, 'T1', '20261104', NOW);
      expect(snapshot.observations).toHaveLength(1); expect(snapshot.predictions).toHaveLength(1);
    }
    h.clock(NOW + 10_000); await h.object.fetch(request()); expect(h.calls).toHaveLength(3);
    // Cold start respects persisted token and pace; the next allowed poll reuses the token.
    const cold = new h.Feed(h.ctx, h.env); await cold.fetch(request()); expect(h.calls).toHaveLength(3);
    h.clock(NOW + 31_000); await cold.fetch(request()); expect(h.calls).toHaveLength(5);
    expect(h.calls.filter((s) => s.endsWith('authenticateUser'))).toHaveLength(1);
  });
  it('round-trips printable fleet identifiers through normalization, protocol and subsequent exact-vehicle queries', async () => {
    for (const vehicleId of ['NJT 5412', '165:1', 'bus.12', 'bus/12', 'autobús']) {
      const h = harness(() => binaryFeed([{ id: 'v', vehicle: vehicle({ vehicle: { id: vehicleId } }) }]));
      const url = new URL(request().url); url.searchParams.set('vehicle', vehicleId);
      const response = await createRouter(ds).fetch(new Request(url), h.env);
      expect(response.status).toBe(200);
      expect(parseLiveSnapshot(await response.json(), ds, 'T1', '20261104', NOW).observations[0]?.vehicleId).toBe(vehicleId);
    }
    const h = harness();
    for (const vehicleId of ['', ' ', 'a'.repeat(129), 'bad\u0000id']) {
      const url = new URL(request().url); url.searchParams.set('vehicle', vehicleId);
      expect((await createRouter(ds).fetch(new Request(url), h.env)).status).toBe(400);
      expect(normalize(binaryFeed([{ id: 'v', vehicle: vehicle({ vehicle: { id: vehicleId } }) }]), 'vehicles', NOW).observations).toEqual([]);
    }
    expect(h.calls).toHaveLength(0);
  });
  it('retains distinct buses and the locked vehicle reassignment after duplicate reports, within the packet bound', async () => {
    const reports = Array.from({ length: 12 }, (_, i) => ({ id: 'duplicate-' + i, vehicle: vehicle({ timestamp: NOW / 1000 - 20 + i }) }));
    reports.push({ id: 'second', vehicle: vehicle({ vehicle: { id: 'bus-B' }, timestamp: NOW / 1000 - 1 }) });
    reports.push({ id: 'reassigned', vehicle: vehicle({ trip: { ...descriptor, tripId: 'T2' }, vehicle: { id: 'locked-bus' }, timestamp: NOW / 1000 - 2 }) });
    const h = harness(() => binaryFeed(reports));
    const snapshot = parseLiveSnapshot(await (await h.object.fetch(request('/v1/live?trip=T1&date=20261104&vehicle=locked-bus'))).json(), ds, 'T1', '20261104', NOW);
    expect(snapshot.observations).toHaveLength(3);
    expect(snapshot.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ vehicleId: 'bus-A', observedAt: NOW - 9000 }),
      expect.objectContaining({ vehicleId: 'bus-B' }),
      expect.objectContaining({ vehicleId: 'locked-bus', tripInstanceId: 'T2@20261104' }),
    ]));
    const profile = await (await h.object.fetch(request('/v1/status'))).json();
    expect(profile.example.vehicleId).toBe('bus-B');
    for (let i = 0; i < 15; i++) reports.push({ id: 'extra-' + i, vehicle: vehicle({ vehicle: { id: 'extra-' + i } }) });
    const crowded = harness(() => binaryFeed(reports));
    const limited = parseLiveSnapshot(await (await crowded.object.fetch(request('/v1/live?trip=T1&date=20261104&vehicle=locked-bus'))).json(), ds, 'T1', '20261104', NOW);
    expect(limited.observations).toHaveLength(10);
    expect(limited.observations.some((o) => o.vehicleId === 'locked-bus')).toBe(true);
    expect(new Set(limited.observations.filter((o) => o.tripInstanceId === 'T1@20261104').map((o) => o.vehicleId)).size).toBeGreaterThan(1);
  });
  it('rejects newest equal-time contradictory locked fixes while retaining distinct buses and reassignment evidence', async () => {
    for (const reverse of [false, true]) {
      const reports = [
        { id: 'a', vehicle: vehicle() },
        { id: 'a-conflict', vehicle: vehicle({ position: { latitude: 40.88, longitude: -74.04 } }) },
        { id: 'b', vehicle: vehicle({ vehicle: { id: 'bus-B' } }) },
        { id: 'moving', vehicle: vehicle({ vehicle: { id: 'locked-bus' }, trip: { ...descriptor, tripId: 'T2' } }) },
      ];
      if (reverse) reports.reverse();
      const h = harness(() => binaryFeed(reports));
      const snapshot = parseLiveSnapshot(await (await h.object.fetch(request('/v1/live?trip=T1&date=20261104&vehicle=locked-bus'))).json(), ds, 'T1', '20261104', NOW);
      expect(snapshot.vehicles.state).toBe('invalid');
      expect(snapshot.observations.some(o => o.vehicleId === 'bus-A')).toBe(false);
      expect(snapshot.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ vehicleId: 'bus-B', tripInstanceId: 'T1@20261104' }),
        expect.objectContaining({ vehicleId: 'locked-bus', tripInstanceId: 'T2@20261104' }),
      ]));
    }
  });
  it('accepts identical newest duplicates and a newer resolved sample without letting old contradictions win', async () => {
    const reports = [{ id: 'old-a', vehicle: vehicle() }, { id: 'old-b', vehicle: vehicle({ position: { latitude: 40.88, longitude: -74.04 } }) },
      { id: 'new-a', vehicle: vehicle({ timestamp: NOW / 1000 - 1 }) }, { id: 'new-b', vehicle: vehicle({ timestamp: NOW / 1000 - 1 }) }];
    const h = harness(() => binaryFeed(reports));
    const snapshot = parseLiveSnapshot(await (await h.object.fetch(request())).json(), ds, 'T1', '20261104', NOW);
    expect(snapshot.vehicles.state).toBe('ok'); expect(snapshot.observations).toHaveLength(1);
    expect(snapshot.observations[0]?.observedAt).toBe(NOW - 1000);
  });
  it('drops old normalized stop indices after a schedule change while preserving token reuse and pacing', async () => {
    const h = harness(); await h.object.fetch(request());
    const changed = structuredClone(ds); changed.meta.feedVersion = 'next-feed';
    const Next = createFeedClass(changed, (async () => { throw new Error('Must not poll before paced deadline'); }) as typeof fetch, () => NOW + 1000);
    const next = new Next(h.ctx, h.env), packet = await (await next.fetch(request())).json();
    expect(packet.feedVersion).toBe('next-feed'); expect(packet.observations).toEqual([]); expect(packet.predictions).toEqual([]);
    expect((h.saved.get('state-v1') as { token: unknown }).token).toBeDefined();
  });
  it('does not turn receipt time into an observation timestamp', async () => {
    const h = harness(); await h.object.fetch(request()); h.clock(NOW + 180_000);
    const snapshot = await (await h.object.fetch(request())).json();
    expect(snapshot.receivedAt).toBe(NOW + 180_000); expect(snapshot.vehicles.state).toBe('stale');
    expect(snapshot.observations[0].observedAt).toBe(NOW - 15_000);
  });
  it('keeps an unavailable feed unknown, paces failed requests and backs off failed authentication', async () => {
    let calls = 0;
    const ctx = { storage: { get: async <T,>() => undefined as T | undefined, put: async () => {} }, blockConcurrencyWhile: async <T,>(f: () => Promise<T>) => f() };
    const Feed = createFeedClass(ds, (async () => { calls++; throw new Error(creds.NJT_API_PASSWORD); }) as typeof fetch, () => NOW);
    const h = harness(), instance = new Feed(ctx, h.env);
    const text = await (await instance.fetch(request())).text();
    expect(text).not.toContain(creds.NJT_API_PASSWORD); expect(JSON.parse(text).vehicles.state).toBe('unavailable');
    await instance.fetch(request()); expect(calls).toBe(1);
  });
  it('routes only approved-origin read requests and known active trips, and serves the canonical static feed', async () => {
    const h = harness(), router = createRouter(ds);
    expect((await router.fetch(new Request(request(), { method: 'POST' }), h.env)).status).toBe(405);
    expect((await router.fetch(new Request(request(), { headers: { origin: 'https://bad.example' } }), h.env)).status).toBe(403);
    for (const path of ['/v1/live?trip=other&date=20261104', '/v1/live?trip=T1&date=20261301', '/v1/live?trip=T1&date=20261107']) {
      expect((await router.fetch(request(path), h.env)).status).toBe(400);
    }
    expect(h.calls).toHaveLength(0);
    const schedule = await router.fetch(request('/v1/schedule'), h.env); expect(await schedule.json()).toMatchObject({ meta: { realtime: { provider: 'njt-bus-g2' } } });
    const options = await router.fetch(new Request(request(), { method: 'OPTIONS' }), h.env); expect(options.status).toBe(204);
    const status = await (await router.fetch(request('/v1/status'), h.env)).json(); expect(status.reportingBuses).toBe(1); expect(status.example.tripInstanceId).toBe('T1@20261104');
  });
});

describe('safe live protocol and existing lock', () => {
  it('requires a compatible version, fixed trip and sane source timestamps', async () => {
    const h = harness(), packet = await (await h.object.fetch(request())).json();
    expect(parseLiveSnapshot(packet, ds, 'T1', '20261104', NOW).source).toBe(LIVE_SOURCE);
    for (const patch of [{ feedVersion: 'changed' }, { tripInstanceId: 'T2@20261104' }, { receivedAt: NOW + 60_000 }, { observations: [{ vehicleId: 'A' }] }]) {
      expect(() => parseLiveSnapshot({ ...packet, ...patch }, ds, 'T1', '20261104', NOW)).toThrow();
    }
    expect(liveApiUrl('https://dale-live.test.workers.dev')).toBeDefined();
    for (const url of ['http://dale-live.test.workers.dev', 'https://evil.example', 'https://dale-live.test.workers.dev/?token=secret']) expect(liveApiUrl(url)).toBeUndefined();
  });
  it.each(['confirm_pending', 'reject_pending'] as const)('keeps GPS loss visible when %s follows a missing feed', (type) => {
    let session = createBusSession(dep(), NOW - 30_000);
    const point = { tripInstanceId: dep().tripInstanceId, vehicleId: 'A', observedAt: NOW - 2000, lat: 40.89, lon: -74.04 };
    session = reduceBusSession(session, { type: 'observation', source: 'official', receivedAt: NOW, obs: point });
    session = reduceBusSession(session, { type: 'observation', source: 'official', receivedAt: NOW, obs: { ...point, vehicleId: 'B', observedAt: NOW - 1000 } });
    expect(session.lock.status).toBe('needs_confirmation');
    session = reduceBusSession(session, { type: 'feed_status', tripInstanceId: dep().tripInstanceId, state: 'missing', now: NOW });
    session = reduceBusSession(session, { type, now: NOW });
    expect(session.lock.status).toBe('stale'); expect(gpsLost(session, NOW)).toBe(true);
    expect(session.lock.vehicleId).toBe(type === 'confirm_pending' ? 'B' : 'A');
  });
  it('falls back immediately on a checked feed gap without changing identity, cancelling or inventing observations', () => {
    let session = createBusSession(dep(), NOW - 30_000);
    session = reduceBusSession(session, { type: 'observation', source: 'official', receivedAt: NOW, obs: { tripInstanceId: dep().tripInstanceId, vehicleId: 'A', observedAt: NOW - 1000, lat: 40.89, lon: -74.04 } });
    session = reduceBusSession(session, { type: 'feed_status', tripInstanceId: dep().tripInstanceId, state: 'missing', now: NOW });
    expect(session.lock.status).toBe('stale'); expect(gpsLost(session, NOW)).toBe(true);
    expect(reduceBusSession(session, { type: 'tick', now: NOW + 1000 }).lock.status).toBe('stale');
    expect(session.lock.vehicleId).toBe('A'); expect(session.history).toHaveLength(1); expect(session.lock.tripInstanceId).toBe(dep().tripInstanceId);
    session = reduceBusSession(session, { type: 'feed_status', tripInstanceId: dep().tripInstanceId, state: 'ok', now: NOW + 1000 });
    expect(session.lock.status).toBe('tracked');
  });
});


describe('bounded private NJ Transit client', () => {
  it('does not accept string False or log echoed credentials', async () => {
    const log = vi.spyOn(console, 'log'), error = vi.spyOn(console, 'error');
    await expect(authenticate(creds, (async () => Response.json({ Authenticated: 'False', UserToken: 'do-not-use' })) as typeof fetch)).rejects.toThrow('access-denied');
    await expect(njtRequest('getVehiclePositions', { token: 'private-token' }, 100, (async () => { throw new Error('private-token'); }) as typeof fetch)).rejects.toThrow('network-error');
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
  it('bounds response size and refuses redirects before a token can reach another host', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual'); return new Response('x'.repeat(101));
    }) as unknown as typeof fetch;
    await expect(njtRequest('getTripUpdates', { token: 'private-token' }, 100, fetchImpl)).rejects.toThrow('response-too-large');
  });
  it('refuses redirects without sending the token to a second host', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/collect' } });
    }) as unknown as typeof fetch;
    await expect(njtRequest('getVehiclePositions', { token: 'synthetic-private-token' }, 100, fetchImpl)).rejects.toThrow('redirect-refused');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchImpl).mock.calls[0]![0])).toBe('https://pcsdata.njtransit.com/api/GTFSG2/getVehiclePositions');
  });
  it('enforces a deadline through a stalled body read without returning raw errors', async () => {
    vi.useFakeTimers();
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1])); init?.signal?.addEventListener('abort', () => controller.error(new Error('private-token')));
    } }))) as typeof fetch;
    const checked = expect(njtRequest('getTripUpdates', { token: 'private-token' }, 100, fetchImpl, 30)).rejects.toThrow('timed-out');
    await vi.advanceTimersByTimeAsync(31); await checked; expect(vi.getTimerCount()).toBe(0);
  });
});

describe('fixed secret-safe connection diagnostics', () => {
  it('keeps configuration failure distinct and preserves its cause during cooldown', async () => {
    let now = NOW;
    const saved = new Map<string, unknown>();
    const ctx = { storage: { get: async <T,>(k: string) => saved.get(k) as T | undefined, put: async (k: string, v: unknown) => { saved.set(k, structuredClone(v)); } }, blockConcurrencyWhile: async <T,>(f: () => Promise<T>) => f() };
    const Feed = createFeedClass(ds, (async () => { throw new Error('must-not-call-without-credentials'); }) as typeof fetch, () => now);
    const object = new Feed(ctx, { NJT_API_USERNAME: '', NJT_API_PASSWORD: '', FEED: { idFromName: () => '', get: () => object } });
    const first = await (await object.fetch(request('/v1/status'))).json();
    expect(first.connectionFailures.authentication).toEqual({ code: 'configuration-missing', at: NOW });
    now += 31_000;
    const retry = await (await object.fetch(request('/v1/status'))).json();
    expect(retry.connectionFailures.authentication).toEqual(first.connectionFailures.authentication);
    expect(retry.vehicles.state).toBe('unavailable');
  });
  it('distinguishes upstream authorization and rate-limit failures without leaking response content', async () => {
    const ctx = { storage: { get: async <T,>() => undefined as T | undefined, put: async () => {} }, blockConcurrencyWhile: async <T,>(f: () => Promise<T>) => f() };
    const Feed = createFeedClass(ds, (async (url: RequestInfo | URL) => {
      if (String(url).endsWith('authenticateUser')) return Response.json({ Authenticated: true, UserToken: 'secret-token' });
      return new Response('secret-token and password', { status: String(url).endsWith('getVehiclePositions') ? 403 : 429 });
    }) as typeof fetch, () => NOW);
    const object = new Feed(ctx, { ...creds, FEED: { idFromName: () => '', get: () => object } });
    const text = await (await object.fetch(request('/v1/status'))).text();
    expect(text).not.toContain('secret-token'); expect(text).not.toContain(creds.NJT_API_PASSWORD);
    expect(JSON.parse(text).connectionFailures).toEqual({ vehicles: { code: 'access-denied', at: NOW }, updates: { code: 'rate-limited', at: NOW } });
  });
  it('retains endpoint failures through cooldown and cold restart, then clears only the successfully retried endpoint', async () => {
    let now = NOW, recover = false;
    const saved = new Map<string, unknown>();
    const ctx = { storage: { get: async <T,>(k: string) => structuredClone(saved.get(k)) as T | undefined, put: async (k: string, v: unknown) => { saved.set(k, structuredClone(v)); } }, blockConcurrencyWhile: async <T,>(f: () => Promise<T>) => f() };
    const Feed = createFeedClass(ds, (async (url: RequestInfo | URL) => {
      if (String(url).endsWith('authenticateUser')) return Response.json({ Authenticated: true, UserToken: 'private-token' });
      if (recover && String(url).endsWith('getVehiclePositions')) return new Response(new Uint8Array(gps()).buffer);
      return new Response('private-error-body', { status: String(url).endsWith('getVehiclePositions') ? 403 : 429 });
    }) as typeof fetch, () => now);
    const env = { ...creds, FEED: { idFromName: () => '', get: () => object } };
    const object = new Feed(ctx, env);
    const first = await (await object.fetch(request('/v1/status'))).json();
    expect(first.connectionFailures.vehicles).toEqual({ code: 'access-denied', at: NOW });
    now += 31_000;
    const cold = new Feed(ctx, env), cooling = await (await cold.fetch(request('/v1/status'))).json();
    expect(cooling.connectionFailures.vehicles).toEqual(first.connectionFailures.vehicles);
    expect(cooling.connectionFailures.updates).toEqual(first.connectionFailures.updates);
    expect(cooling.connectionFailures.authentication.code).toBe('authentication-cooldown');
    recover = true; now = NOW + 3600_000;
    const text = await (await cold.fetch(request('/v1/status'))).text(), retry = JSON.parse(text);
    expect(retry.connectionFailures.authentication).toBeUndefined();
    expect(retry.connectionFailures.vehicles).toBeUndefined();
    expect(retry.connectionFailures.updates).toEqual({ code: 'rate-limited', at: now });
    expect(text).not.toContain('private-token'); expect(text).not.toContain('private-error-body');
  });
  it('allows only fixed NjtError categories and discards arbitrary error messages and codes', async () => {
    const { safeNjtFailure, NjtError } = await import('../../worker/njt-client');
    expect(safeNjtFailure(new Error('password-secret'))).toBe('unknown-error');
    expect(safeNjtFailure(new NjtError('token-secret'))).toBe('unknown-error');
    expect(safeNjtFailure(new NjtError('timed-out'))).toBe('timed-out');
    expect(safeNjtFailure(new NjtError('network-error'))).toBe('network-error');
  });
});

describe('known legacy pre-network transport failure migration', () => {
  it.each([
    { version: undefined, code: 'network-error', token: undefined, retry: true },
    { version: undefined, code: 'access-denied', token: undefined, retry: false },
    { version: 2, code: 'network-error', token: undefined, retry: false },
    { version: undefined, code: 'network-error', token: { value: 'existing-synthetic-token', expiresAt: NOW + 3600_000 }, retry: true },
  ])('preserves pacing and releases only the known legacy no-token failure: %j', async ({ version, code, token, retry }) => {
    let now = NOW, calls: string[] = [];
    const saved = new Map<string, unknown>([['state-v1', { transportVersion: version, feedVersion: ds.meta.feedVersion, authAt: NOW - 1000, pollAt: NOW - 1000, token, failures: { authentication: { code, at: NOW - 1000 } } }]]);
    const ctx = { storage: { get: async <T,>(k: string) => structuredClone(saved.get(k)) as T | undefined, put: async (k: string, v: unknown) => { saved.set(k, structuredClone(v)); } }, blockConcurrencyWhile: async <T,>(f: () => Promise<T>) => f() };
    const Feed = createFeedClass(ds, (async (url: RequestInfo | URL) => {
      calls.push(String(url));
      if (String(url).endsWith('authenticateUser')) throw new Error('synthetic-transport-failure');
      return new Response(new Uint8Array(String(url).endsWith('getVehiclePositions') ? gps() : updates()).buffer);
    }) as typeof fetch, () => now);
    const env = { ...creds, FEED: { idFromName: () => '', get: () => object } }, object = new Feed(ctx, env);
    await object.fetch(request('/v1/status')); expect(calls).toHaveLength(0);
    expect((saved.get('state-v1') as { transportVersion: number }).transportVersion).toBe(2);
    now += 31_000; await object.fetch(request('/v1/status'));
    expect(calls.length > 0).toBe(retry);
    if (token) { expect(calls).toHaveLength(2); expect((saved.get('state-v1') as { token: unknown }).token).toEqual(token); }
    else if (retry) {
      expect(calls).toHaveLength(1);
      // A new transport failure survives a cold start without granting another migration retry.
      now += 31_000; await new Feed(ctx, env).fetch(request('/v1/status')); expect(calls).toHaveLength(1);
    }
  });
});
