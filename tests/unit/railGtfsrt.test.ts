import { describe, expect, it } from 'vitest';
import { RailGtfsrt, newRailGtfsrtState, RAIL_GTFSRT_MINT_LIMIT } from '../../worker/rail-gtfsrt';
import { reserveRequests, NJT_REQUEST_LIMIT, type RequestBudget } from '../../worker/request-budget';
import { binaryFeed, NOW } from '../helpers/liveBus';

function harness() {
  let now = NOW, state = newRailGtfsrtState(), saved = structuredClone(state), refuse = '', failSave = false;
  const calls: { url: string; fields: Record<string, string> }[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const fields = Object.fromEntries((init!.body as FormData).entries()) as Record<string, string>;
    calls.push({ url: String(url), fields });
    expect(String(url)).toMatch(/^https:\/\/raildata\.njtransit\.com\/api\/GTFSRT\/(getToken|getVehiclePositions|getTripUpdates)$/);
    expect(init?.redirect).toBe('manual');
    const method = String(url).split('/').pop();
    if (method === 'getToken') return Response.json({ Authenticated: 'True', UserToken: 'synthetic-token' });
    expect(fields).toEqual({ token: 'synthetic-token' });
    if (refuse === 'denied') return new Response('', { status: 401 });
    if (refuse === method) return new Response('', { status: 503 });
    if (refuse === 'json-error') return Response.json({ errorMessage: 'Invalid token.' });
    if (refuse === 'quota') return Response.json({ errorMessage: 'Daily usage limit:40000.' });
    return new Response(new Uint8Array(binaryFeed([])));
  }) as typeof fetch;
  const checkpoint = async () => { if (failSave) throw new Error('synthetic storage failure'); saved = structuredClone(state); };
  return { calls, get state() { return state; }, time: (at: number) => { now = at; }, refuse: (value: string) => { refuse = value; },
    failSave: () => { failSave = true; }, restart: () => { state = structuredClone(saved); },
    async run() {
      const rail = new RailGtfsrt(state, { NJT_API_USERNAME: 'synthetic-user', NJT_API_PASSWORD: 'synthetic-password' }, checkpoint, fetchImpl, () => now);
      const plan = rail.prepare(now);
      saved = structuredClone(state); // Same pre-I/O checkpoint as service.ts.
      if (!plan) return;
      const result = await rail.collect(plan); saved = structuredClone(state); return result;
    } };
}

describe('rail GTFS-RT token and independent feeds', () => {
  it('reuses the persisted token over 24 hours of 30-second polls, refreshing only after 23 hours', async () => {
    const h = harness();
    for (let i = 0; i < 2880; i++) {
      h.time(NOW + i * 30_000);
      if (i % 100 === 0) h.restart();
      expect((await h.run())?.responses).toHaveLength(2);
    }
    expect(h.calls.filter(call => call.url.endsWith('/getToken'))).toHaveLength(2);
    expect(h.calls.filter(call => !call.url.endsWith('/getToken'))).toHaveLength(5760);
    expect(h.calls[0]!.fields).toEqual({ username: 'synthetic-user', password: 'synthetic-password' });
  });
  it('persists failed-token attempts across restarts and never exceeds the allowance, including Eastern midnight and DST', async () => {
    const h = harness(); h.refuse('denied');
    const start = Date.parse('2026-11-01T03:30:00Z');
    for (let i = 0; i < 48; i++) { h.time(start + i * 30 * 60_000); await h.run(); h.restart(); }
    const tokenCalls = h.calls.filter(call => call.url.endsWith('/getToken'));
    expect(tokenCalls).toHaveLength(RAIL_GTFSRT_MINT_LIMIT);
    expect(tokenCalls.length).toBeLessThanOrEqual(10);
    h.time(start + 86400_000); await h.run();
    expect(h.calls.filter(call => call.url.endsWith('/getToken'))).toHaveLength(RAIL_GTFSRT_MINT_LIMIT + 1);
  });
  it.each(['getVehiclePositions', 'getTripUpdates'])('still saves the other rail feed when %s fails', async method => {
    const h = harness(); h.refuse(method);
    const result = await h.run();
    expect(result?.responses).toHaveLength(1);
    expect(result?.failures).toEqual([{ feed: `rail-${method}`, code: 'http-error', at: NOW }]);
  });
  it('does not save documented JSON error bodies as rail protobuf or mint on every denial', async () => {
    const h = harness(); h.refuse('json-error');
    expect((await h.run())?.responses).toEqual([]);
    h.time(NOW + 30_000); expect(await h.run()).toBeUndefined();
    expect(h.calls.filter(call => call.url.endsWith('/getToken'))).toHaveLength(1);
  });
  it('pauses both endpoints on an agency quota response and retains the token across restart', async () => {
    const h = harness(); h.refuse('quota');
    expect((await h.run())?.responses).toEqual([]); h.restart();
    h.time(NOW + 30_000); expect(await h.run()).toBeUndefined();
    expect(h.calls).toHaveLength(3);
    h.refuse(''); h.time(NOW + 15 * 60_000); expect((await h.run())?.responses).toHaveLength(2);
    expect(h.calls.filter(call => call.url.endsWith('/getToken'))).toHaveLength(1);
  });
  it('reserves attempts before I/O and makes no data call if saving the minted token fails', async () => {
    const h = harness(); h.failSave();
    const result = await h.run();
    expect(result?.responses).toEqual([]); expect(h.calls).toHaveLength(1);
    expect(h.state.mints).toEqual([NOW]);
    expect(Object.values(h.state.budget.hours)).toEqual([3]);
    expect(result?.secrets).toContain('synthetic-token');
  });
  it('keeps its 30-second pace during the separate five-second bus cadence test and across eviction', async () => {
    const h = harness(); await h.run(); h.restart();
    h.time(NOW + 5000); expect(await h.run()).toBeUndefined();
    h.time(NOW + 30_000); expect((await h.run())?.responses).toHaveLength(2);
    expect(h.calls).toHaveLength(5);
  });
});

describe('persistent per-API request ceiling', () => {
  it('admits exactly the last available requests and refuses overflow', () => {
    const state: RequestBudget = { hours: {} };
    expect(reserveRequests(state, NJT_REQUEST_LIMIT - 2, NOW)).toBe(true);
    expect(reserveRequests(state, 2, NOW)).toBe(true);
    expect(reserveRequests(structuredClone(state), 1, NOW + 30_000)).toBe(false);
  });
  it.each(['2026-11-01T05:59:59Z', '2027-03-14T06:59:59Z', '2026-11-22T23:59:59Z'])('never resets quota at midnight or a DST boundary (%s)', date => {
    const at = Date.parse(date), state: RequestBudget = { hours: {} };
    expect(reserveRequests(state, NJT_REQUEST_LIMIT, at)).toBe(true);
    expect(reserveRequests(state, 1, at + 2000)).toBe(false);
    expect(reserveRequests(state, 1, at + 86400_000 - 1)).toBe(false);
    expect(reserveRequests(state, 1, at + 25 * 3600_000)).toBe(true);
  });
  it('fails closed on a regressed clock or invalid count', () => {
    const state: RequestBudget = { hours: {} };
    expect(reserveRequests(state, 1, NOW)).toBe(true);
    expect(reserveRequests(state, 1, NOW - 1)).toBe(false);
    expect(reserveRequests(state, -1, NOW)).toBe(false);
  });
});
