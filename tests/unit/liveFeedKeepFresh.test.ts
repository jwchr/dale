import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createFeedClass } from '../../worker/service';
import { liveDataset as ds, NOW, binaryFeed, vehicle, update } from '../helpers/liveBus';

// #282 (audit DL-005): one failed poll must not blank buses that are still fresh, but history records the gap.
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function harness() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  let now = NOW, failing = false;
  const saved = new Map<string, unknown>();
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
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  };
  const net = (async (url: RequestInfo | URL) => {
    const endpoint = String(url).split('/').pop()!;
    if (endpoint === 'authenticateUser') return Response.json({ Authenticated: 'True', UserToken: 'synthetic-token' });
    if (failing) return new Response('busy', { status: 503 });
    const seconds = Math.floor(now / 1000);
    return new Response(new Uint8Array(binaryFeed([{ id: endpoint,
      ...(endpoint === 'getVehiclePositions' ? { vehicle: vehicle({ timestamp: seconds - 1 }) } : { tripUpdate: update({ timestamp: seconds - 1 }) }),
    }], { timestamp: seconds - 1 })).buffer);
  }) as typeof fetch;
  const ctx = { storage, blockConcurrencyWhile: async <T,>(callback: () => Promise<T>) => callback() };
  const Feed = createFeedClass(ds, net, () => now);
  const env = { NJT_API_USERNAME: 'synthetic', NJT_API_PASSWORD: 'synthetic', HISTORY_COLLECTION: 'enabled', FEED: { idFromName: () => 'one', get: () => object } };
  const object = new Feed(ctx, env);
  type Status = { vehicles: { state: string }; updates: { state: string }; reportingBuses: number; connectionFailures: Record<string, { code: string }> };
  const status = async () => (await (await object.fetch(new Request('https://test/v1/status'))).json()) as Status;
  const lastBatch = () => {
    const row = db.prepare('SELECT body FROM dale_history_batches ORDER BY attempt DESC LIMIT 1').get() as { body: string } | undefined;
    return row && JSON.parse(row.body) as { quality: { feedState: string; updateFeedState: string } };
  };
  return { status, lastBatch, at: (value: number) => { now = value; }, fail: (value: boolean) => { failing = value; } };
}

describe('a failed poll after a good one (#282)', () => {
  it('keeps still-fresh buses, records the gap in history, and drops them once 2 minutes old', async () => {
    const h = harness();
    expect(await h.status()).toMatchObject({ vehicles: { state: 'ok' }, reportingBuses: 1 });
    expect(h.lastBatch()!.quality.feedState).toBe('ok');

    h.fail(true); h.at(NOW + 30_000);
    const during = await h.status();
    expect(during).toMatchObject({ vehicles: { state: 'ok' }, updates: { state: 'ok' }, reportingBuses: 1 });
    expect(during.connectionFailures.vehicles?.code).toBeTruthy();
    // History keeps this poll's real result, not the kept copy.
    expect(h.lastBatch()!.quality).toMatchObject({ feedState: 'unavailable', updateFeedState: 'unavailable' });

    // The feed's own timestamp was NOW - 1 s; past 2 minutes the kept copy is no longer used.
    h.at(NOW + 150_000);
    const after = await h.status();
    expect(after.vehicles.state).toBe('unavailable');
    expect(after.reportingBuses).toBe(0);
  });
});
