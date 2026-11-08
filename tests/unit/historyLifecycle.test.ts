import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createFeedClass } from '../../worker/service';
// @ts-expect-error Native deployment helper intentionally has no declaration.
import { disabledArchiveEvidence, preservesArchiveEvidence } from '../../scripts/disabled-archive-evidence.mjs';
import { liveDataset as ds, NOW, binaryFeed, vehicle, update } from '../helpers/liveBus';
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function harness(enabled = true, blocked?: Promise<void>) {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  let now = NOW, alarmAt: number | null = null;
  const saved = new Map<string, unknown>(), calls: string[] = [];
  const storage = {
    sql: { get databaseSize() { return Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size); }, exec(query: string, ...bindings: (string | number | null)[]) {
      const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[]; return { toArray: () => rows };
    } },
    transactionSync<T>(callback: () => T): T {
      db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    get: async <T,>(key: string) => structuredClone(saved.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => { saved.set(key, structuredClone(value)); },
    getAlarm: async () => alarmAt,
    setAlarm: async (at: number) => { alarmAt = at; },
    deleteAlarm: async () => { alarmAt = null; },
  };
  const net = (async (url: RequestInfo | URL) => {
    const endpoint = String(url).split('/').pop()!; calls.push(endpoint);
    if (endpoint === 'authenticateUser') return Response.json({ Authenticated: 'True', UserToken: 'private-test-token' });
    if (blocked) await blocked;
    const seconds = Math.floor(now / 1000);
    return new Response(new Uint8Array(binaryFeed([{ id: endpoint,
      ...(endpoint === 'getVehiclePositions' ? { vehicle: vehicle({ timestamp: seconds - 1 }) } : { tripUpdate: update({ timestamp: seconds - 1 }) }),
    }], { timestamp: seconds - 1 })).buffer);
  }) as typeof fetch;
  const ctx = { storage, blockConcurrencyWhile: async <T,>(callback: () => Promise<T>) => callback() };
  const Feed = createFeedClass(ds, net, () => now);
  const env = { NJT_API_USERNAME: 'synthetic', NJT_API_PASSWORD: 'synthetic', HISTORY_COLLECTION: enabled ? 'enabled' : 'disabled',
    FEED: { idFromName: () => 'one', get: () => object } };
  const object = new Feed(ctx, env);
  const health = async (target = object) => (await (await target.fetch(new Request('https://test/v1/collection'))).json()).collection;
  return { object, env, Feed, ctx, db, calls, health, clock: (value: number) => { now = value; },
    alarm: async (target = object) => { alarmAt = null; await target.alarm(); } };
}
describe('collector and existing relay lifecycle', () => {
  it('restoration accepts the real disabled service schema without invented archive counters or archive I/O', async () => {
    const h = harness(false); await h.health();
    let archiveCalls = 0;
    const env = { ...h.env, HISTORY_ARCHIVE: {
      put: async () => { archiveCalls++; throw new Error('disabled archive write forbidden'); },
      get: async () => { archiveCalls++; throw new Error('disabled archive read forbidden'); },
    } };
    const stopped = new h.Feed(h.ctx, env);
    const before = await h.health(stopped);
    expect(before.archive).toEqual({ configured: true, enabled: false });
    const evidence = disabledArchiveEvidence(before.archive);
    expect(evidence).toEqual({ kind: 'unreported' });
    expect(evidence).not.toHaveProperty('verifiedObjects');
    expect(evidence).not.toHaveProperty('reservedBytes');
    h.clock(NOW + 35_000); await h.alarm(stopped);
    const after = await h.health(stopped);
    expect(preservesArchiveEvidence(evidence, disabledArchiveEvidence(after.archive))).toBe(true);
    expect(after).toMatchObject({ enabled: false, reason: 'disabled', alarmAt: null, observations: before.observations, batches: before.batches, bytes: before.bytes });
    expect(h.calls).toEqual([]); expect(archiveCalls).toBe(0);
  });
  it('starts explicitly, collects without demand, survives eviction and stops on disabled deployment', async () => {
    const h = harness();
    expect(await h.health()).toMatchObject({ enabled: true, observations: 0, reason: 'starting' }); expect(h.calls).toEqual([]);
    await h.alarm(); expect(h.calls).toHaveLength(3);
    const before = await h.health(); expect(before).toMatchObject({ observations: 1, batches: 1, reason: 'collecting' });
    const resumed = new h.Feed(h.ctx, h.env);
    expect((await h.health(resumed)).alarmAt).toBe(before.alarmAt);
    h.clock(NOW + 30_000); await h.alarm(resumed);
    expect((await h.health(resumed)).observations).toBe(2); expect(h.calls).toHaveLength(5);
    const stopped = new h.Feed(h.ctx, { ...h.env, HISTORY_COLLECTION: 'disabled' });
    expect(await h.health(stopped)).toMatchObject({ enabled: false, reason: 'disabled', alarmAt: null, observations: 2 });
    h.clock(NOW + 60_000); await h.alarm(stopped); expect(h.calls).toHaveLength(5);
  });
  it('coalesces a demand refresh with a concurrent alarm instead of polling or recording twice', async () => {
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    const h = harness(true, blocked); await h.health();
    const demand = h.object.fetch(new Request('https://test/v1/status'));
    await expect.poll(() => h.calls.length).toBe(3);
    const alarm = h.alarm(); release(); await Promise.all([demand, alarm]);
    expect(h.calls).toHaveLength(3); expect(await h.health()).toMatchObject({ observations: 1, batches: 1 });
  });
  it('never starts background requests while disabled and never offers a public start endpoint', async () => {
    const h = harness(false); await h.health(); await h.alarm();
    expect(h.calls).toEqual([]); expect(await h.health()).toMatchObject({ enabled: false, alarmAt: null });
  });
  it('pauses background polling on the journal budget without disabling ordinary live reads', async () => {
    const h = harness(); await h.health();
    const state = JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_meta').get()!.body));
    state.reservedWrites = 75_000; h.db.prepare('UPDATE dale_history_meta SET body=?').run(JSON.stringify(state));
    await h.alarm(); expect(h.calls).toEqual([]);
    expect(await h.health()).toMatchObject({ enabled: true, reason: 'quota-paused', observations: 0, alarmAt: Date.parse('2026-11-05T00:00:00Z') });
    await h.object.fetch(new Request('https://test/v1/status')); expect(h.calls).toHaveLength(3);
    expect((await h.health()).observations).toBe(0);
  });
});
