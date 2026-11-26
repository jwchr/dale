import { describe, expect, it } from 'vitest';
import { createFeedClass, createRouter } from '../../worker/service';
import { reserveRequests } from '../../worker/request-budget';
import { authenticateBusDv, njtRequest } from '../../worker/njt-client';
import { NOW, dataset, row } from '../helpers/gates';
import type { Dataset } from '../../src/domain/types';

function harness(options: { ds?: Dataset; enabled?: boolean; authFail?: boolean; failStore?: boolean } = {}) {
  let now = NOW, alarm: number | null = null;
  const ds = options.ds ?? structuredClone(dataset), saved = new Map<string, unknown>(), calls: { url: string; route: string | null; at: number }[] = [];
  const routeBodies = new Map<string, unknown>(); const routeFailures = new Set<string>(); const deniedRoutes = new Set<string>();
  let blocked: Promise<void> | undefined;
  const storage = { get: async <T,>(key: string) => structuredClone(saved.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => { if (options.failStore) throw new Error('synthetic storage failure'); saved.set(key, structuredClone(value)); },
    getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; }, deleteAlarm: async () => { alarm = null; } };
  const ctx = { storage, blockConcurrencyWhile: async <T,>(fn: () => Promise<T>) => fn() };
  const net = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(url), fields = init!.body as FormData, route = fields.get('route') as string | null;
    calls.push({ url: endpoint, route, at: now });
    // A reservation must be durable before even authentication starts.
    const state = saved.get('state-v1') as { gateBudget?: { hours: Record<string, number> } } | undefined;
    if (endpoint.includes('BUSDV2')) expect(Object.values(state?.gateBudget?.hours ?? {}).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    if (endpoint.endsWith('authenticateUser')) return options.authFail ? new Response('denied', { status: 401 }) : Response.json({ Authenticated: true, UserToken: 'synthetic-private-token' });
    if (!endpoint.endsWith('getBusDV')) return new Response(new Uint8Array());
    expect(fields.get('stop')).toBe('PABT'); expect(fields.get('minutesRequested')).toBe('60'); expect(fields.get('direction')).toBe(''); expect(route).toBeTruthy();
    if (blocked) await blocked;
    if (deniedRoutes.has(route!)) return new Response('denied', { status: 401 });
    return routeFailures.has(route!) ? new Response('unavailable', { status: 503 }) : Response.json(routeBodies.get(route!) ?? { DVTrip: [row({ public_route: route })] });
  }) as typeof fetch;
  const Feed = createFeedClass(ds, net, () => now);
  let object: InstanceType<typeof Feed>;
  const env = { NJT_API_USERNAME: 'synthetic-user', NJT_API_PASSWORD: 'synthetic-password', LIVE_GATES: options.enabled === false ? 'off' : 'enabled', FEED: { idFromName: (n: string) => n, get: () => object } };
  object = new Feed(ctx, env);
  const request = (path = '/v1/gates') => new Request('https://dale.test' + path);
  return { ds, saved, calls, env, ctx, Feed, request, routeBodies, routeFailures, deniedRoutes,
    get object() { return object; }, setTime: (at: number) => { now = at; }, block: (p?: Promise<void>) => { blocked = p; },
    read: async () => (await object.fetch(request())).json(), cold: (newDs = ds) => { object = new (createFeedClass(newDs, net, () => now))(ctx, env); return object; } };
}
function fourRoutes(): Dataset {
  const ds = structuredClone(dataset);
  ds.routes = ['163', '164', '165', '165T'].map(shortName => ({ id: shortName, shortName, longName: 'Corridor' }));
  ds.patterns = ds.routes.map(r => ({ ...dataset.patterns[0]!, id: 'p' + r.id, routeId: r.id }));
  ds.trips = ds.patterns.flatMap(p => Array.from({ length: 24 }, (_, hour) => ({ id: p.id + hour, patternId: p.id, serviceId: 'daily', times: [hour * 3600 + 900, hour * 3600 + 1200, hour * 3600 + 1800] })));
  return ds;
}

describe('gates in the existing corridor alarm', () => {
  it('off and no-eligible-route perform zero DV network calls; reads never poll', async () => {
    const off = harness({ enabled: false }); expect(await off.read()).toEqual({ v: 1, available: false }); await off.object.alarm(); expect(off.calls).toEqual([]);
    const ds = structuredClone(dataset); ds.trips = [];
    const idle = harness({ ds }); await idle.object.alarm(); expect(idle.calls).toEqual([]);
    const on = harness(); await on.read(); await on.read(); expect(on.calls).toEqual([]);
  });
  it('a rejected board token is forgotten in durable storage too', async () => {
    const h = harness(); await h.object.alarm();
    expect((h.saved.get('gates-v1') as { token?: unknown }).token).toBeDefined();
    h.deniedRoutes.add('165'); h.setTime(NOW + 60_000); await h.object.alarm();
    expect((h.saved.get('gates-v1') as { token?: unknown }).token).toBeUndefined();
  });
  it('collects once per minute, keeps its own token across a cold start, and leases requests in one write', async () => {
    const h = harness(); let puts = 0; const put = h.ctx.storage.put; h.ctx.storage.put = async (k, v) => { puts++; return put(k, v); };
    await h.object.alarm();
    expect(h.calls.filter(c => c.url.endsWith('getBusDV'))).toHaveLength(1);
    expect((await h.read()).postings[0]).toMatchObject({ gate: '222', door: '3', boardingIndex: 0, ageMs: 0 });
    await h.object.alarm(); expect(h.calls).toHaveLength(2);
    // A restart loses only memory: no new authentication, at most one board call, still inside the durable lease.
    await h.cold().alarm(); expect(h.calls).toHaveLength(3); expect(h.calls.filter(c => c.url.endsWith('authenticateUser'))).toHaveLength(1);
    puts = 0; for (let i = 1; i <= 15; i++) { h.setTime(NOW + i * 60_000); await h.object.alarm(); }
    expect(h.calls).toHaveLength(18); expect(puts).toBeLessThanOrEqual(1);
    const state = h.saved.get('state-v1') as Record<string, unknown>; expect(state.token).toBeUndefined(); expect(state.busBudget).toEqual({ hours: {} });
  });
  it('counts auth failure then enters a one-hour cooldown without a retry loop', async () => {
    const h = harness({ ds: fourRoutes(), authFail: true }); await h.object.alarm(); expect(h.calls).toHaveLength(1);
    for (let i = 1; i < 60; i++) { h.setTime(NOW + i * 60_000); await h.object.alarm(); }
    expect(h.calls).toHaveLength(1); expect((await h.read()).routes.every((r: { state: string }) => r.state === 'unavailable')).toBe(true);
    h.setTime(NOW + 3600_000); await h.object.alarm(); expect(h.calls).toHaveLength(2);
  });
  it('isolates per-route error and empty board; neither renews another route or G2 state', async () => {
    const ds = fourRoutes(); const h = harness({ ds });
    for (const r of ds.routes) h.routeBodies.set(r.shortName, { DVTrip: [row({ public_route: r.shortName })] });
    await h.object.alarm(); expect((await h.read()).postings).toHaveLength(4);
    h.routeFailures.add('163'); h.routeBodies.set('164', { DVTrip: [] }); h.setTime(NOW + 60_000); await h.object.alarm();
    const answer = await h.read(); expect(answer.postings).toHaveLength(3);
    expect(answer.postings.find((p: { tripInstanceId: string }) => p.tripInstanceId.startsWith('p163')).ageMs).toBe(60_000);
    expect(answer.routes.find((r: { route: string }) => r.route === '164').state).toBe('empty');
    expect(answer.routes.find((r: { route: string }) => r.route === '163').state).toBe('unavailable');
    expect((h.saved.get('state-v1') as Record<string, unknown>).vehicles).toBeUndefined();
  });
  it('coalesces overlapping alarms, so a slower completion cannot overwrite a newer board', async () => {
    const h = harness(); let release!: () => void; h.block(new Promise<void>(r => { release = r; }));
    const first = h.object.alarm();
    // Wait until the controlled upstream request is pending.
    for (let i = 0; i < 40 && !h.calls.some(c => c.url.endsWith('getBusDV')); i++) await Promise.resolve();
    h.setTime(NOW + 60_000); const second = h.object.alarm(); release(); await Promise.all([first, second]);
    expect(h.calls.filter(c => c.url.endsWith('getBusDV'))).toHaveLength(1);
    h.block(); h.routeBodies.set('165', { DVTrip: [row({ lanegate: '311' })] }); h.setTime(NOW + 120_000); await h.object.alarm();
    expect((await h.read()).postings[0].gate).toBe('311');
  });
  it('paces each route by its own attempt time even when an earlier route is slow', async () => {
    const h = harness({ ds: fourRoutes() }); let release!: () => void;
    h.block(new Promise<void>(r => { release = r; })); const pending = h.object.alarm();
    for (let i = 0; i < 50 && !h.calls.some(c => c.url.endsWith('getBusDV')); i++) await Promise.resolve();
    h.setTime(NOW + 30_000); release(); await pending; h.block();
    expect(h.calls.find(c => c.route === '164')?.at).toBe(NOW + 30_000);
    h.setTime(NOW + 60_000); await h.object.alarm();
    expect(h.calls.filter(c => c.route === '163')).toHaveLength(2);
    expect(h.calls.filter(c => c.route === '164')).toHaveLength(1);
  });
  it('clears persisted postings on feed rollover but retains durable request accounting', async () => {
    const h = harness(); await h.object.alarm(); expect((await h.read()).postings).toHaveLength(1);
    const ds = structuredClone(dataset); ds.meta.feedVersion = 'new-schedule'; h.cold(ds);
    expect((await h.read()).postings).toEqual([]);
    expect((h.saved.get('state-v1') as Record<string, unknown>).gateBudget).toBeTruthy();
  });
  it('expires at the exclusive boundary and never exposes raw/private upstream fields; rejects queries at both layers', async () => {
    const h = harness(); h.routeBodies.set('165', { DVTrip: [row({ vehicle_id: 'synthetic-private-field', internal_trip_number: 'synthetic-private-field', passload: 'synthetic-private-field' })] });
    await h.object.alarm(); h.setTime(NOW + 119_999); expect((await h.read()).postings).toHaveLength(1);
    h.setTime(NOW + 120_000); const answer = await h.read(); expect(answer.postings).toEqual([]); expect(answer.routes[0].state).toBe('stale');
    const text = JSON.stringify(answer); for (const secret of ['synthetic-private', 'vehicle_id', 'internal_trip_number', 'passload', 'UserToken', 'DVTrip', 'rawBody']) expect(text).not.toContain(secret);
    expect(JSON.stringify(h.saved.get('gates-v1'))).not.toContain('synthetic-private-field');
    expect((await h.object.fetch(h.request('/v1/gates?x=1'))).status).toBe(400);
    expect((await createRouter(dataset).fetch(h.request('/v1/gates?route=165'), h.env)).status).toBe(400);
    expect((await h.object.fetch(h.request())).headers.get('cache-control')).toBe('no-store');
  });
  it('makes at most 1,440 board calls per route over 24 hours and stays below the DV cap including auth', async () => {
    const h = harness({ ds: fourRoutes() });
    for (let i = 0; i < 1440; i++) { h.setTime(NOW + i * 60_000); await h.object.alarm(); }
    for (const r of h.ds.routes) expect(h.calls.filter(c => c.route === r.shortName)).toHaveLength(1440);
    expect(h.calls).toHaveLength(5762);
    const state = h.saved.get('state-v1') as { gateBudget: { hours: Record<string, number> } };
    const reserved = Object.values(state.gateBudget.hours).reduce((a, b) => a + b, 0);
    // Every call was reserved first; leases add at most one unspent lease.
    expect(reserved).toBeGreaterThanOrEqual(5762); expect(reserved).toBeLessThanOrEqual(5762 + 40);
  }, 30_000);
  it('keeps rolling limits across Eastern midnight and the 25-hour fall day while accounting by Eastern day', () => {
    const budget: import('../../worker/request-budget').RequestBudget = { hours: {} };
    const start = Date.UTC(2026, 10, 1, 4);
    for (let i = 0; i < 1500; i++) expect(reserveRequests(budget, 4, start + i * 60_000, 6500)).toBe(true);
    expect(budget.easternDay).toEqual({ date: '20261101', requests: 6000 });
    expect(reserveRequests(budget, 1, start + 25 * 3600_000, 6500)).toBe(true);
    expect(budget.easternDay).toEqual({ date: '20261102', requests: 1 });
    expect(Object.values(budget.hours).reduce((a, b) => a + b, 0)).toBeGreaterThan(5700);
  });
  it('a feed rollover keeps the durable request count while clearing schedule evidence', async () => {
    const h = harness(); await h.object.alarm();
    const ds = structuredClone(dataset); ds.meta.feedVersion = 'new-schedule'; h.cold(ds);
    expect((await h.read()).postings).toEqual([]);
    h.setTime(NOW + 30_000); await h.object.alarm(); expect(h.calls).toHaveLength(3);
    const used = Object.values((h.saved.get('state-v1') as { gateBudget: { hours: Record<string, number> } }).gateBudget.hours).reduce((a, b) => a + b, 0);
    expect(used).toBeGreaterThanOrEqual(3);
  });
  it('fails closed at DV and combined rolling ceilings, including across restart', async () => {
    for (const [budget, count] of [['gateBudget', 6500], ['busBudget', 40_000]] as const) {
      const h = harness(); await h.read(); h.saved.set('state-v1', { authAt: 0, pollAt: 0, feedVersion: dataset.meta.feedVersion, [budget]: { hours: { [Math.floor(NOW / 3600_000)]: count }, lastAt: NOW } });
      h.cold(); await h.object.alarm(); expect(h.calls).toEqual([]); expect((await h.read()).routes[0].state).toBe('quota-paused');
    }
    const budget = { hours: {} }; for (let i = 0; i < 6500; i++) expect(reserveRequests(budget, 1, NOW, 6500)).toBe(true); expect(reserveRequests(budget, 1, NOW, 6500)).toBe(false);
  });
  const gateTotal = (h: ReturnType<typeof harness>) => Object.values((h.saved.get('state-v1') as { gateBudget?: { hours: Record<string, number> } } | undefined)?.gateBudget?.hours ?? {}).reduce((a, b) => a + b, 0);
  it('a failed token save starts no one-hour cooldown; the next minute authenticates (Neon review #296)', async () => {
    const h = harness(); await h.read(); const put = h.ctx.storage.put; let fail = true;
    h.ctx.storage.put = async (k, v) => { if (k === 'gates-v1' && fail) throw new Error('synthetic storage failure'); return put(k, v); };
    await h.object.alarm(); expect(h.calls).toEqual([]);
    fail = false; h.setTime(NOW + 60_000); await h.object.alarm();
    expect(h.calls.map(c => c.url.split('/').pop())).toEqual(['authenticateUser', 'getBusDV']);
  });
  it('a failed budget save leaves no unspent lease behind for the next save (Neon review #296)', async () => {
    const h = harness(); await h.read(); const put = h.ctx.storage.put; let fail = true;
    h.ctx.storage.put = async (k, v) => { if (k === 'state-v1' && fail) throw new Error('synthetic storage failure'); return put(k, v); };
    await h.object.alarm(); expect(h.calls).toEqual([]);
    fail = false; h.setTime(NOW + 60_000); await h.object.alarm();
    expect(h.calls).toHaveLength(2); expect(gateTotal(h)).toBe(40);
  });
  it('drops lease credit after an hour and reserves again, so every request stays in the ceiling (CodeRabbit #296)', async () => {
    const h = harness({ ds: fourRoutes() }); await h.object.alarm(); expect(gateTotal(h)).toBe(40);
    h.setTime(NOW + 3600_000); await h.object.alarm(); expect(gateTotal(h)).toBe(80);
  });
  it('makes no upstream call when durable storage fails', async () => {
    const h = harness({ failStore: true }); await h.object.alarm(); expect(h.calls).toEqual([]);
  });
  it('resets shape diagnostics at Eastern midnight without resetting quota', async () => {
    const h = harness(); await h.object.alarm(); expect((await h.read()).diagnostics['165'].rowsSeen).toBe(1);
    h.setTime(Date.UTC(2026, 10, 27, 5)); expect((await h.read()).diagnostics['165'].rowsSeen).toBe(0);
  });
});

describe('BUSDV2 transport', () => {
  it('uses separate authentication endpoint and refuses redirects', async () => {
    const calls: string[] = []; const net = (async (url: RequestInfo | URL) => { calls.push(String(url)); return Response.json({ Authenticated: true, UserToken: 'synthetic-token' }); }) as typeof fetch;
    expect(await authenticateBusDv({ NJT_API_USERNAME: 'synthetic', NJT_API_PASSWORD: 'synthetic' }, net)).toBe('synthetic-token');
    expect(calls).toEqual(['https://pcsdata.njtransit.com/api/BUSDV2/authenticateUser']);
    await expect(njtRequest('getBusDV', {}, 256 * 1024, (async () => new Response(null, { status: 302 })) as typeof fetch, 100, 'bus-dv')).rejects.toMatchObject({ code: 'redirect-refused' });
  });
  it('caps getBusDV at 256 KiB even if the caller asks for more', async () => {
    await expect(njtRequest('getBusDV', {}, 1000_000, (async () => new Response(new Uint8Array(256 * 1024 + 1))) as typeof fetch, 100, 'bus-dv')).rejects.toMatchObject({ code: 'response-too-large' });
  });
});
