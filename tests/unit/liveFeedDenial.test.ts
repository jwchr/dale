import { describe, expect, it } from 'vitest';
import { createFeedClass } from '../../worker/service';
import { liveDataset as ds, NOW, binaryFeed, vehicle } from '../helpers/liveBus';

describe('one refused feed', () => {
  it('keeps the other feed live instead of dropping the shared token for an hour', async () => {
    let now = NOW; const saved = new Map<string, unknown>(), calls: string[] = [];
    const storage = { get: async <T,>(k: string) => structuredClone(saved.get(k)) as T | undefined, put: async (k: string, v: unknown) => { saved.set(k, structuredClone(v)); } };
    const ctx = { storage, blockConcurrencyWhile: async <T,>(fn: () => Promise<T>) => fn() };
    const Feed = createFeedClass(ds, (async (url: RequestInfo | URL) => {
      const u = String(url); calls.push(u.split('/').pop()!);
      if (u.endsWith('authenticateUser')) return Response.json({ Authenticated: 'True', UserToken: 'tok' });
      if (u.endsWith('getTripUpdates')) return new Response('denied', { status: 403 });
      return new Response(new Uint8Array(binaryFeed([{ id: 'v', vehicle: vehicle({ timestamp: Math.floor(now / 1000) - 5 }) }], { timestamp: Math.floor(now / 1000) - 5 })).buffer);
    }) as typeof fetch, () => now);
    const feed = new Feed(ctx, { NJT_API_USERNAME: 'u', NJT_API_PASSWORD: 'p', FEED: { idFromName: () => '', get: () => feed } });
    for (let i = 0; i < 4; i++) {
      const status = await (await feed.fetch(new Request('https://x/v1/status'))).json() as { vehicles: { state: string }; reportingBuses: number; connectionFailures: Record<string, { code: string }> };
      expect(status.vehicles.state).toBe('ok');
      expect(status.reportingBuses).toBe(1);
      expect(status.connectionFailures.updates?.code).toBe('access-denied');
      expect(status.connectionFailures.authentication).toBeUndefined();
      now += 30_000;
    }
    // One login, then both feeds on every poll: no re-login storm and no cooldown blackout.
    expect(calls.filter(c => c === 'authenticateUser')).toHaveLength(1);
    expect(calls.filter(c => c === 'getVehiclePositions')).toHaveLength(4);
  });
});
