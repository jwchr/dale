import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryArchive, type HistoryBucket } from '../../worker/history-archive';
import { HistoryJournal, historyContextKey, type HistoryStorage } from '../../worker/history-journal';
import { RawArchive, newRawArchiveState, type RawArchiveState, type RawResponse } from '../../worker/raw-archive';
import { createFeedClass } from '../../worker/service';
import { liveDataset as ds, NOW, binaryFeed, vehicle, update } from '../helpers/liveBus';
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const original = () => new Uint8Array(binaryFeed([{ id: 'synthetic', vehicle: vehicle() }]));
const input = (receivedAt = NOW, bytes = original()): RawResponse => ({ feed: 'getVehiclePositions', receivedAt, bytes });
function sqlite() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const storage: HistoryStorage = {
    sql: { get databaseSize() { return Number(db.prepare('PRAGMA page_count').get()!.page_count) * 4096; },
      exec(query, ...bindings) { const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[]; return { toArray: () => rows }; } },
    transactionSync<T>(callback: () => T): T {
      db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, storage };
}
async function harness() {
  const { db, storage } = sqlite();
  const journal = new HistoryJournal(storage, ds, await historyContextKey(ds)); journal.setEnabled(true, NOW);
  const objects = new Map<string, Uint8Array<ArrayBuffer>>(), calls: string[] = [];
  let fail = '', ambiguous = false;
  const bucket: HistoryBucket = {
    async put(key, bytes, options) {
      calls.push('put:' + key);
      expect(options.onlyIf).toEqual({ etagDoesNotMatch: '*' });
      expect(options.storageClass).toBe('Standard');
      expect(sha(new Uint8Array(bytes))).toBe(Buffer.from(options.sha256).toString('hex'));
      const meta = JSON.parse(String(db.prepare('SELECT body FROM dale_archive_meta').get()!.body));
      expect(meta.reservedBytes).toBeGreaterThan(bytes.byteLength);
      if (fail && key.includes(fail)) throw new Error('synthetic failure');
      if (!objects.has(key)) objects.set(key, new Uint8Array(bytes.slice(0)));
      if (ambiguous) { ambiguous = false; throw new Error('synthetic ambiguous completion'); }
      return null; // Conditional-create collisions still require identical readback.
    },
    async get(key) {
      calls.push('get:' + key); const data = objects.get(key);
      return data ? { size: data.byteLength, arrayBuffer: async () => data.slice().buffer } : null;
    },
  };
  const archive = new HistoryArchive(storage, journal, bucket);
  let state = newRawArchiveState(), saved = structuredClone(state), checkpoints = 0;
  const make = () => new RawArchive(state, archive, bucket, async () => { checkpoints++; saved = structuredClone(state); });
  let raw = make();
  return { db, storage, journal, archive, objects, calls, bucket,
    get raw() { return raw; }, get state() { return state; }, get checkpoints() { return checkpoints; },
    finish: () => { saved = structuredClone(state); },
    restart: () => { state = structuredClone(saved); raw = make(); },
    fail: (value: string) => { fail = value; }, ambiguous: () => { ambiguous = true; } };
}
describe('private as-received raw archives', () => {
  it('preserves the original bytes, both hashes and header time, with no normalization or filtering', async () => {
    const h = await harness(), bytes = original(); await h.raw.capture([input(NOW, bytes)], NOW, []);
    const key = [...h.objects.keys()].find(k => k.endsWith('.pb.gz'))!;
    const compressed = h.objects.get(key)!, manifest = JSON.parse(new TextDecoder().decode(h.objects.get(key + '.manifest.json')));
    expect(new Uint8Array(gunzipSync(compressed))).toEqual(bytes);
    expect(manifest).toMatchObject({ feed: 'getVehiclePositions', receivedAt: NOW, rawBytes: bytes.length,
      gzipBytes: compressed.length, sha256: sha(bytes), gzipSHA256: sha(compressed), upstreamHeaderTimestamp: NOW / 1000 - 10 });
    expect(key).toBe(`raw/v1/${new Date(NOW).toISOString().slice(0, 10)}/getVehiclePositions/${NOW}-${sha(bytes)}.pb.gz`);
  });
  it('preserves successful response bodies even when the protobuf cannot normalize, with an unknown header time', async () => {
    const h = await harness(), bytes = new Uint8Array([255, 0, 64, 201, 17]);
    await h.raw.capture([input(NOW, bytes)], NOW, []);
    const key = [...h.objects.keys()].find(k => k.endsWith('.pb.gz'))!;
    expect(new Uint8Array(gunzipSync(h.objects.get(key)!))).toEqual(bytes);
    expect(JSON.parse(new TextDecoder().decode(h.objects.get(key + '.manifest.json'))).upstreamHeaderTimestamp).toBeNull();
  });
  it('saves every identical response separately, including after eviction, but replaying the same receipt is idempotent', async () => {
    const h = await harness(); await h.raw.capture([input()], NOW, []); h.finish(); h.restart();
    await h.raw.capture([input(NOW + 30_000)], NOW + 30_000, []); h.finish();
    await h.raw.capture([input(NOW + 30_000)], NOW + 30_000, []);
    expect(h.objects.size).toBe(4);
    expect(h.raw.status().hoursUTC[0]!.feeds.getVehiclePositions).toMatchObject({ count: 2, identical: 1 });
  });
  it('batches all feeds into one checkpoint per poll and one immutable hourly ledger, including both repeated DST hours', async () => {
    const h = await harness();
    const first = Date.parse('2026-11-01T05:59:30Z'), second = first + 30_000;
    const feeds = (at: number): RawResponse[] => [input(at), { ...input(at), feed: 'getTripUpdates' }];
    await h.raw.capture(feeds(first), first, []); h.finish();
    expect(h.checkpoints).toBe(1); expect(h.objects.size).toBe(4);
    await h.raw.capture(feeds(second), second, []); h.finish();
    expect(h.checkpoints).toBe(2);
    const key = 'raw/v1/2026-11-01/ledgers/05.json';
    const ledger = JSON.parse(new TextDecoder().decode(h.objects.get(key)));
    expect(ledger.hour).toBe('2026-11-01T05'); expect(ledger.feeds.getVehiclePositions.count).toBe(1);
    expect(h.raw.status().hoursUTC[0]!.hour).toBe('2026-11-01T06');
  });
  it('uses block reservations rather than SQL writes per file and keeps capacity for the normal corridor day', async () => {
    const h = await harness();
    await h.raw.capture([input(), { ...input(), feed: 'getTripUpdates' }], NOW, []); h.finish();
    const reserved = h.journal.status(NOW).reservedWrites;
    await h.raw.capture([input(NOW + 30_000), { ...input(NOW + 30_000), feed: 'getTripUpdates' }], NOW + 30_000, []);
    expect(h.journal.status(NOW).reservedWrites).toBe(reserved);
    expect(h.checkpoints).toBe(2);
    const state = JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_meta').get()!.body));
    state.reservedWrites = 74_900; h.db.prepare('UPDATE dale_history_meta SET body=?').run(JSON.stringify(state));
    expect(h.archive.reserveRaw(0, 64, 64, 128, NOW)).toBe('sql-write-budget');
    expect(h.journal.beginAttempt(NOW)).toBe(NOW);
  });
  it('retries an hourly ledger after a crash with exactly the same body and count', async () => {
    const h = await harness(); await h.raw.capture([input()], NOW, []); h.finish();
    await h.raw.capture([], NOW + 3600_000, []);
    const key = [...h.objects.keys()].find(k => k.includes('/ledgers/'))!, bytes = h.objects.get(key)!.slice();
    h.restart(); await h.raw.capture([], NOW + 3600_000, []); h.finish();
    expect(h.objects.get(key)).toEqual(bytes);
    expect(JSON.parse(new TextDecoder().decode(bytes)).feeds.getVehiclePositions.count).toBe(1);
    expect(h.raw.status().hoursUTC).toHaveLength(0);
  });
  it('preserves a conflicting existing object and never acknowledges corrupted readback', async () => {
    const h = await harness(), key = `raw/v1/${new Date(NOW).toISOString().slice(0, 10)}/getVehiclePositions/${NOW}-${sha(original())}.pb.gz`;
    const corrupt = new Uint8Array([1, 2, 3]); h.objects.set(key, corrupt.slice());
    await h.raw.capture([input(), { ...input(), feed: 'getTripUpdates' }], NOW, []);
    expect(h.objects.get(key)).toEqual(corrupt);
    expect(h.raw.status().hoursUTC[0]!.feeds.getVehiclePositions).toBeUndefined();
    expect(h.raw.status().hoursUTC[0]!.feeds.getTripUpdates!.count).toBe(1);
    expect(h.state.pending).toHaveLength(1);
  });
  it('keeps independent receipt dates across UTC midnight without treating UTC folders as service dates', async () => {
    const h = await harness(), late = Date.parse('2026-11-05T23:59:59Z'), next = late + 2000;
    await h.raw.capture([input(late), { ...input(next), feed: 'getTripUpdates' }], next, []); h.finish();
    expect(h.raw.status().hoursUTC).toHaveLength(2);
    await h.raw.capture([input(next + 30_000)], next + 30_000, []);
    expect(h.objects.has('raw/v1/2026-11-05/ledgers/23.json')).toBe(true);
    expect([...h.objects.keys()].some(k => k.startsWith('raw/v1/2026-11-06/getTripUpdates/'))).toBe(true);
  });
  it('resumes an ambiguous data write after eviction and never double counts a receipt', async () => {
    const h = await harness(); h.ambiguous(); await h.raw.capture([input()], NOW, []);
    expect(h.state.pending).toHaveLength(1); h.restart();
    await h.raw.capture([input(NOW + 30_000)], NOW + 30_000, []); h.finish();
    expect(h.state.pending).toHaveLength(0); expect(h.objects.size).toBe(4);
    expect(h.raw.status().hoursUTC[0]!.feeds.getVehiclePositions).toMatchObject({ count: 2, identical: 1 });
  });
  it('reconciles data and manifest after a crash before the relay saves completion', async () => {
    const h = await harness(); await h.raw.capture([input()], NOW, []); h.restart();
    await h.raw.capture([], NOW + 30_000, []); h.finish();
    expect(h.objects.size).toBe(2); expect(h.raw.status().hoursUTC[0]!.feeds.getVehiclePositions!.count).toBe(1);
    h.restart(); await h.raw.capture([], NOW + 60_000, []);
    expect(h.raw.status().hoursUTC[0]!.feeds.getVehiclePositions!.count).toBe(1);
  });
  it.each(['bytes', 'classA', 'classB', 'sql'])('stops raw storage at the shared %s guard without bucket calls', async guard => {
    const h = await harness();
    if (guard === 'bytes') h.db.prepare('INSERT INTO dale_archive_meta(id,body) VALUES(1,?)').run(JSON.stringify({ v: 1, reservedBytes: 8_999_999_999, verifiedObjects: 0, failures: 0, reason: 'ready' }));
    else if (guard === 'sql') {
      const meta = JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_meta').get()!.body)); meta.reservedWrites = 75_000;
      h.db.prepare('UPDATE dale_history_meta SET body=?').run(JSON.stringify(meta));
    } else h.db.prepare('INSERT INTO dale_archive_days(day,class_a,class_b) VALUES(?,?,?)').run(new Date(NOW).toISOString().slice(0, 10), guard === 'classA' ? 500_000 : 0, guard === 'classB' ? 2_000_000 : 0);
    await h.raw.capture([input()], NOW, []);
    expect(h.calls).toEqual([]); expect(h.raw.status().reason).toBe(guard === 'bytes' ? 'free-storage-budget' : guard === 'sql' ? 'sql-write-budget' : 'free-operation-budget');
    expect(h.journal.status(NOW).enabled).toBe(true);
  });
  it.each(['getVehiclePositions', 'rail-getVehiclePositions'] as const)('does not let failing %s archive writes block the other feeds on either poll', async failed => {
    const h = await harness(); h.fail(`/${failed}/`);
    const batch = (at: number): RawResponse[] => (['getVehiclePositions', 'getTripUpdates', 'rail-getVehiclePositions', 'rail-getTripUpdates'] as const)
      .map(feed => ({ ...input(at), feed }));
    await h.raw.capture(batch(NOW), NOW, []); h.finish();
    await h.raw.capture(batch(NOW + 30_000), NOW + 30_000, []);
    expect(h.raw.status().hoursUTC[0]!.feeds.getTripUpdates!.count).toBe(2);
    expect(h.raw.status().hoursUTC[0]!.feeds['rail-getTripUpdates']!.count).toBe(2);
    expect(h.raw.status().missing).toBe(1);
  });
  it('rejects secret echoes without redacting data or saving request fields, tokens or credentials', async () => {
    const h = await harness(), secrets = ['synthetic-user', 'synthetic-password', 'synthetic-token'];
    await h.raw.capture(secrets.map((secret, n) => ({ feed: 'rail-getVehiclePositions', receivedAt: NOW + n,
      bytes: new TextEncoder().encode(JSON.stringify({ echo: secret })) })), NOW, secrets);
    expect(h.objects.size).toBe(0); expect(h.raw.status().blockedSecrets).toBe(3);
    await h.raw.capture([input()], NOW, secrets);
    const all = [...h.objects.values()].map(b => new TextDecoder().decode(b)).join('');
    for (const secret of secrets) expect(all).not.toContain(secret);
    const health = JSON.stringify(h.raw.status());
    expect(health).not.toContain('sha256'); expect(health).not.toContain('synthetic'); expect(health).not.toContain('.pb');
  });
});

describe('raw collection through the bus Worker', () => {
  async function service(enabled = true, railEnabled = true) {
    const h = await harness(); let now = NOW, railCalls = 0, busFailure = false, railFailure = false, authFailure = false;
    let oversized = '', large = '';
    const urls: string[] = [];
    const saved = new Map<string, unknown>(); let alarmAt: number | null = null;
    const storage = { ...h.storage, get: async <T,>(key: string) => structuredClone(saved.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => { saved.set(key, structuredClone(value)); },
      getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; } };
    const fetchImpl = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      const endpoint = String(url).split('/').pop();
      const isRail = String(url).includes('/GTFSRT/');
      if (endpoint === 'getVehicleData') throw new Error('No background RailData calls');
      if (authFailure && endpoint === 'authenticateUser') return new Response('', { status: 401 });
      if (endpoint === 'authenticateUser' || endpoint === 'getToken') return Response.json({ Authenticated: 'True', UserToken: 'synthetic-token' });
      if (isRail) { railCalls++; if (railFailure) return new Response('', { status: 503 }); }
      const feed = (isRail ? 'rail-' : '') + endpoint;
      if (feed === oversized) {
        let n = 0;
        return new Response(new ReadableStream({ pull(controller) { if (n++ < 33) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close(); } }));
      }
      if (feed === large) return new Response(new Uint8Array(9 * 1024 * 1024));
      if (!isRail && busFailure && endpoint === 'getVehiclePositions') return new Response('', { status: 503 });
      return new Response(new Uint8Array(binaryFeed([{ id: 'synthetic', ...(endpoint === 'getVehiclePositions' ? { vehicle: vehicle() } : { tripUpdate: update() }) }])));
    }) as typeof fetch;
    const Feed = createFeedClass(ds, fetchImpl, () => now), ctx = { storage, blockConcurrencyWhile: async <T,>(fn: () => Promise<T>) => fn() };
    const env = { NJT_API_USERNAME: 'synthetic-user', NJT_API_PASSWORD: 'synthetic-password', HISTORY_COLLECTION: enabled ? 'enabled' : 'disabled', HISTORY_ARCHIVE: h.bucket, RAIL_GTFSRT_RAW: railEnabled ? 'enabled' : undefined,
      FEED: { idFromName: () => 'one', get: () => object } };
    let object = new Feed(ctx, env);
    const poll = async () => { await object.fetch(new Request('https://test/v1/status')); };
    return { ...h, poll, saved, urls, oversized: (feed: string) => { oversized = feed; }, large: (feed: string) => { large = feed; }, failAuth: () => { authFailure = true; }, get railCalls() { return railCalls; }, time: (at: number) => { now = at; }, failBus: () => { busFailure = true; }, failRail: () => { railFailure = true; },
      restart: () => { object = new Feed(ctx, env); }, health: async () => (await (await object.fetch(new Request('https://test/v1/collection'))).json()).collection };
  }
  it('saves both rail protobuf originals every 30 seconds, including after eviction, using one cached token', async () => {
    const h = await service(); await h.poll();
    expect(h.railCalls).toBe(2);
    const railKey = [...h.objects.keys()].find(k => k.includes('/rail-getVehiclePositions/') && k.endsWith('.pb.gz'))!;
    expect(new Uint8Array(gunzipSync(h.objects.get(railKey)!))).toEqual(original());
    expect(railKey).toBe(`raw/v1/${new Date(NOW).toISOString().slice(0, 10)}/rail-getVehiclePositions/${NOW}-${sha(original())}.pb.gz`);
    h.restart(); h.time(NOW + 30_000); await h.poll(); expect(h.railCalls).toBe(4);
    h.time(NOW + 60_000); await h.poll(); expect(h.railCalls).toBe(6);
    expect(h.urls.filter(url => url.endsWith('/getToken'))).toHaveLength(1);
    const feeds = (await h.health()).rawArchive.hoursUTC[0].feeds;
    for (const feed of ['getVehiclePositions', 'getTripUpdates', 'rail-getVehiclePositions', 'rail-getTripUpdates']) expect(feeds[feed].count).toBe(3);
    expect(JSON.stringify(await h.health())).not.toContain('synthetic');
    expect(h.urls.some(url => url.includes('/TrainData/'))).toBe(false);
  });
  it('keeps trip updates and rail when vehicle positions fail upstream', async () => {
    const h = await service(); h.failBus(); await h.poll();
    const feeds = (await h.health()).rawArchive.hoursUTC[0].feeds;
    expect(feeds.getVehiclePositions).toBeUndefined(); expect(feeds.getTripUpdates.count).toBe(1); expect(feeds['rail-getVehiclePositions'].count).toBe(1);
  });
  it('keeps both complete bus feeds when statewide rail fails upstream', async () => {
    const h = await service(); h.failRail(); await h.poll();
    const feeds = (await h.health()).rawArchive.hoursUTC[0].feeds;
    expect(feeds.getVehiclePositions.count).toBe(1); expect(feeds.getTripUpdates.count).toBe(1);
    expect(feeds['rail-getVehiclePositions']).toBeUndefined(); expect(feeds['rail-getTripUpdates']).toBeUndefined();
  });
  it('saves both rail feeds even when bus authentication fails', async () => {
    const h = await service(); h.failAuth(); await h.poll();
    const feeds = (await h.health()).rawArchive.hoursUTC[0].feeds;
    expect(feeds.getVehiclePositions).toBeUndefined(); expect(feeds.getTripUpdates).toBeUndefined();
    expect(feeds['rail-getVehiclePositions'].count).toBe(1); expect(feeds['rail-getTripUpdates'].count).toBe(1);
  });
  it('leaves rail off when the flag is absent and continues bus raw saving', async () => {
    const h = await service(true, false); await h.poll();
    expect(h.railCalls).toBe(0); expect(h.urls.some(url => url.includes('/GTFSRT/'))).toBe(false);
    expect((await h.health()).rawArchive.hoursUTC[0].feeds.getVehiclePositions.count).toBe(1);
  });
  it.each(['getVehiclePositions', 'rail-getVehiclePositions'])('counts an oversized %s stream in the durable hourly ledger without saving a partial original', async feed => {
    const h = await service(); h.oversized(feed); await h.poll();
    let health = (await h.health()).rawArchive;
    expect(health.hoursUTC[0].events[feed]['response-too-large']).toBe(1);
    expect(health.hoursUTC[0].feeds[feed]).toBeUndefined();
    expect([...h.objects.keys()].some(key => key.includes(`/${feed}/`))).toBe(false);
    h.restart(); h.time(NOW + 3600_000); await h.poll();
    const key = [...h.objects.keys()].find(key => key.includes('/ledgers/'))!;
    const ledger = JSON.parse(new TextDecoder().decode(h.objects.get(key)));
    expect(ledger.events[feed]['response-too-large']).toBe(1);
    expect(ledger.feeds[feed]).toBeUndefined();
    health = (await h.health()).rawArchive;
    expect(health.hoursUTC[0].events[feed]['response-too-large']).toBe(1);
  });
  it.each(['getVehiclePositions', 'rail-getVehiclePositions'])('preserves a complete %s response above the former 8 MB limit', async feed => {
    const h = await service(); h.large(feed); await h.poll();
    const key = [...h.objects.keys()].find(key => key.includes(`/${feed}/`) && key.endsWith('.pb.gz'))!;
    expect(gunzipSync(h.objects.get(key)!).byteLength).toBe(9 * 1024 * 1024);
    expect((await h.health()).rawArchive.hoursUTC[0].feeds[feed].rawBytes).toBe(9 * 1024 * 1024);
  });
  it.each(['bus', 'rail'])('enforces the %s API ceiling across restart while the other API still saves', async api => {
    const h = await service(); await h.poll();
    const saved = h.saved.get('state-v1') as { busBudget: { hours: Record<string, number> }; railGtfsrt: { budget: { hours: Record<string, number> } } };
    const budget = api === 'bus' ? saved.busBudget : saved.railGtfsrt.budget;
    budget.hours = { [Math.floor(NOW / 3600_000)]: 40_000 };
    const before = h.urls.length;
    h.restart(); h.time(NOW + 30_000); await h.poll();
    const urls = h.urls.slice(before);
    expect(urls.filter(url => api === 'bus' ? url.includes('/GTFSG2/') : url.includes('/GTFSRT/'))).toHaveLength(0);
    expect(urls.filter(url => api === 'bus' ? url.includes('/GTFSRT/') : url.includes('/GTFSG2/'))).toHaveLength(2);
    const feeds = (await h.health()).rawArchive.hoursUTC[0].feeds;
    expect(feeds[api === 'bus' ? 'rail-getVehiclePositions' : 'getVehiclePositions'].count).toBe(2);
  });
  it('does not collect raw data or call rail when history collection is disabled', async () => {
    const h = await service(false); await h.poll();
    expect(h.objects.size).toBe(0); expect(h.railCalls).toBe(0); expect((await h.health()).rawArchive).toBeUndefined();
  });
});
