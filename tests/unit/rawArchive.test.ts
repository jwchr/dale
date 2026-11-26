import bindings from 'gtfs-realtime-bindings';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryArchive, type HistoryBucket } from '../../worker/history-archive';
import { reserveRequests, type RequestBudget } from '../../worker/request-budget';
import { HistoryJournal, historyContextKey, type HistoryStorage } from '../../worker/history-journal';
import { RawArchive, newRawArchiveState, type RawArchiveState, type RawResponse } from '../../worker/raw-archive';
import { REGION_COUNTIES } from '../../worker/region-raw';
import { createFeedClass } from '../../worker/service';
import { liveDataset as ds, NOW, binaryFeed, vehicle, update } from '../helpers/liveBus';
const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
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
  let state = newRawArchiveState(), saved = structuredClone(state), checkpoints = 0, failCheckpoint = false;
  const make = () => new RawArchive(state, archive, bucket, async () => { checkpoints++; if (failCheckpoint) { failCheckpoint = false; throw new Error('synthetic checkpoint failure'); } saved = structuredClone(state); });
  let raw = make();
  return { db, storage, journal, archive, objects, calls, bucket,
    get raw() { return raw; }, get state() { return state; }, get checkpoints() { return checkpoints; },
    failNextCheckpoint: () => { failCheckpoint = true; },
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
  it.each(['same-receipt', 'committed-predecessor'])('does not remember a credit-denied response: %s', async retry => {
    const h = await harness(), changed = new Uint8Array([255, 0, 64, 201, 17]);
    await h.raw.capture([input()], NOW, []);
    h.state.credit.writes = 0;
    const reservation = vi.spyOn(h.archive, 'reserveRaw').mockReturnValue('sql-write-budget');
    await h.raw.capture([input(NOW + 30_000, changed)], NOW + 30_000, []);
    expect(h.objects.size).toBe(2); expect(h.state.pending).toHaveLength(0);
    h.finish(); h.restart(); reservation.mockRestore();
    const at = retry === 'same-receipt' ? NOW + 30_000 : NOW + 60_000;
    const bytes = retry === 'same-receipt' ? changed : original();
    await h.raw.capture([input(at, bytes)], at, []);
    const key = [...h.objects.keys()].find(key => key.includes(`/${at}-`) && key.endsWith('.pb.gz'))!;
    expect(key).toBeDefined();
    expect(new Uint8Array(gunzipSync(h.objects.get(key)!))).toEqual(bytes);
    const manifest = JSON.parse(new TextDecoder().decode(h.objects.get(key + '.manifest.json')));
    expect(manifest.identical).toBe(retry === 'same-receipt' ? 0 : 1);
    await h.raw.capture([input(at, bytes)], at, []);
    expect(h.objects.size).toBe(4);
    expect(h.raw.status().hoursUTC[0]!.feeds.getVehiclePositions!.count).toBe(2);
  });
  it('retries an uncommitted receipt after a recovery checkpoint fails and the relay saves its final state', async () => {
    const h = await harness(), changed = new Uint8Array([255, 0, 64, 201, 17]);
    h.ambiguous(); await h.raw.capture([input()], NOW, []);
    h.failNextCheckpoint();
    await expect(h.raw.capture([input(NOW + 30_000, changed)], NOW + 30_000, [])).rejects.toThrow('synthetic checkpoint failure');
    h.finish(); h.restart();
    await h.raw.capture([input(NOW + 30_000, changed)], NOW + 30_000, []);
    expect(h.objects.size).toBe(4); expect(h.state.pending).toHaveLength(0);
    expect(h.raw.status().hoursUTC[0]!.feeds.getVehiclePositions).toMatchObject({ count: 2, identical: 0 });
  });
  it('compares staged responses in one batch and skips duplicate receipts', async () => {
    const h = await harness();
    await h.raw.capture([input(), input(), input(NOW + 30_000)], NOW + 30_000, []);
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
    state.reservedWrites = 984_900; h.db.prepare('UPDATE dale_history_meta SET body=?').run(JSON.stringify(state));
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
  it('acknowledges an interrupted receipt even when the raw byte budget refuses new originals', async () => {
    const h = await harness(); h.ambiguous(); await h.raw.capture([input()], NOW, []);
    expect(h.state.pending).toHaveLength(1); h.restart();
    // The budget is nearly used up: a new original needs a fresh 8 MB block, which is refused.
    h.state.credit.bytes = 0;
    const meta = JSON.parse(String(h.db.prepare('SELECT body FROM dale_archive_meta').get()!.body));
    meta.reservedBytes = 497_999_999_000; h.db.prepare('UPDATE dale_archive_meta SET body=?').run(JSON.stringify(meta));
    await h.raw.capture([input(NOW + 30_000, new Uint8Array([255, 0, 64, 201, 17]))], NOW + 30_000, []);
    expect(h.raw.status().reason).toBe('free-storage-budget');
    expect(h.state.pending).toHaveLength(0); expect(h.objects.size).toBe(2);
    expect(h.raw.status().hoursUTC[0]!.feeds.getVehiclePositions!.count).toBe(1);
    h.restart(); expect(h.state.pending).toHaveLength(0);
  });
  it('acknowledges an interrupted receipt after corridor history pushed the shared total past the raw byte stop (CodeRabbit, #278)', async () => {
    const h = await harness(); h.ambiguous(); await h.raw.capture([input()], NOW, []);
    expect(h.state.pending).toHaveLength(1); h.restart();
    // Corridor history keeps its own reserve, so the shared total can pass the raw limit. No cached
    // grant is left, so recovery must buy operations (no bytes) from the archive.
    Object.assign(h.state.credit, { bytes: 0, a: 0, b: 0, writes: 0 });
    const meta = JSON.parse(String(h.db.prepare('SELECT body FROM dale_archive_meta').get()!.body));
    meta.reservedBytes = 498_500_000_000; h.db.prepare('UPDATE dale_archive_meta SET body=?').run(JSON.stringify(meta));
    await h.raw.capture([input(NOW + 30_000, new Uint8Array([255, 0, 64, 201, 17]))], NOW + 30_000, []);
    expect(h.state.pending).toHaveLength(0);
    expect([...h.objects.keys()].filter(k => k.endsWith('.manifest.json'))).toHaveLength(1);
    expect(h.raw.status().hoursUTC[0]!.feeds.getVehiclePositions!.count).toBe(1);
    // New originals still wait: no new bytes are bought past the stop.
    expect(h.raw.status().reason).toBe('free-storage-budget');
    expect([...h.objects.keys()].filter(k => k.endsWith('.pb.gz'))).toHaveLength(1);
    const after = JSON.parse(String(h.db.prepare('SELECT body FROM dale_archive_meta').get()!.body));
    expect(after.reservedBytes).toBe(498_500_000_000);
  });
  it('closes a finished hourly ledger at the raw byte stop while new originals wait (Neon, #278)', async () => {
    const h = await harness(); await h.raw.capture([input()], NOW, []); h.finish();
    // Only the 4096 bytes kept back for the open ledger remain, and no new 8 MB block can be bought.
    h.state.credit.bytes = 4096;
    const meta = JSON.parse(String(h.db.prepare('SELECT body FROM dale_archive_meta').get()!.body));
    meta.reservedBytes = 497_999_999_000; h.db.prepare('UPDATE dale_archive_meta SET body=?').run(JSON.stringify(meta));
    await h.raw.capture([input(NOW + 3600_000)], NOW + 3600_000, []);
    expect(h.raw.status().reason).toBe('free-storage-budget');
    expect([...h.objects.keys()].filter(k => k.includes('/ledgers/'))).toHaveLength(1);
    expect(h.raw.status().hoursUTC).toHaveLength(0); expect(h.state.pending).toHaveLength(0);
    expect([...h.objects.keys()].filter(k => k.endsWith('.pb.gz'))).toHaveLength(1);
  });
  it('closes a ledger whose first close failed at the byte stop, buying only the bytes it needs (Neon Nov24 c, #278)', async () => {
    const h = await harness(); await h.raw.capture([input()], NOW, []); h.finish();
    // The ledger's 4096 bytes were spent on a failed put; 10,000 bytes remain, less than one 8 MB block.
    h.state.credit.bytes = 0;
    const meta = JSON.parse(String(h.db.prepare('SELECT body FROM dale_archive_meta').get()!.body));
    meta.reservedBytes = 497_999_990_000; h.db.prepare('UPDATE dale_archive_meta SET body=?').run(JSON.stringify(meta));
    await h.raw.capture([], NOW + 3600_000, []);
    expect([...h.objects.keys()].filter(k => k.includes('/ledgers/'))).toHaveLength(1);
    const after = JSON.parse(String(h.db.prepare('SELECT body FROM dale_archive_meta').get()!.body));
    expect(after.reservedBytes).toBeLessThan(498_000_000_000);
  });
  it('takes a new original only when its hourly ledger can still be closed afterwards (Neon, #278)', async () => {
    const probe = await harness(); await probe.raw.capture([input()], NOW, []);
    const gzipBytes = probe.objects.get([...probe.objects.keys()].find(k => k.endsWith('.pb.gz'))!)!.byteLength;
    const h = await harness(); expect(h.archive.reserveRaw(0, 64, 64, 128, NOW)).toBeUndefined();
    // Enough for the original and its manifest, but not the 4096 bytes its ledger will need.
    h.state.credit = { ...h.state.credit, bytes: gzipBytes + 4096 };
    const meta = JSON.parse(String(h.db.prepare('SELECT body FROM dale_archive_meta').get()!.body));
    meta.reservedBytes = 497_999_999_000; h.db.prepare('UPDATE dale_archive_meta SET body=?').run(JSON.stringify(meta));
    await h.raw.capture([input()], NOW, []);
    expect(h.raw.status().reason).toBe('free-storage-budget'); expect(h.objects.size).toBe(0);
    expect(h.raw.status().hoursUTC).toHaveLength(0);
  });
  it('does not close an hour whose original arrived just before the hour turned (Neon, #278)', async () => {
    const h = await harness(), hourStart = Date.parse('2026-11-05T13:00:00Z');
    await h.raw.capture([input(hourStart - 60_000)], hourStart - 60_000, []); h.finish();
    h.ambiguous(); // the original is stored but its write reports failure, so it stays pending
    await h.raw.capture([input(hourStart - 100, new Uint8Array([255, 0, 64, 201, 17]))], hourStart + 200, []);
    expect(h.state.pending).toHaveLength(1);
    expect([...h.objects.keys()].some(k => k.includes('/ledgers/'))).toBe(false);
    await h.raw.capture([], hourStart + 30_000, []);
    const ledgers = [...h.objects.keys()].filter(k => k.includes('/ledgers/'));
    expect(ledgers).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(h.objects.get(ledgers[0]!))).feeds.getVehiclePositions.count).toBe(2);
  });
  it.each(['bytes', 'classA', 'classB', 'sql'])('stops raw storage at the shared %s guard without bucket calls', async guard => {
    const h = await harness();
    if (guard === 'bytes') h.db.prepare('INSERT INTO dale_archive_meta(id,body) VALUES(1,?)').run(JSON.stringify({ v: 1, reservedBytes: 499_999_999_999, verifiedObjects: 0, failures: 0, reason: 'ready' }));
    else if (guard === 'sql') {
      const meta = JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_meta').get()!.body)); meta.reservedWrites = 1_000_000;
      h.db.prepare('UPDATE dale_history_meta SET body=?').run(JSON.stringify(meta));
    } else h.db.prepare('INSERT INTO dale_archive_days(day,class_a,class_b) VALUES(?,?,?)').run(new Date(NOW).toISOString().slice(0, 10), guard === 'classA' ? 3_000_000 : 0, guard === 'classB' ? 9_000_000 : 0);
    await h.raw.capture([input()], NOW, []);
    expect(h.calls).toEqual([]); expect(h.raw.status().reason).toBe(guard === 'bytes' ? 'free-storage-budget' : guard === 'sql' ? 'sql-write-budget' : 'free-operation-budget');
    expect(h.journal.status(NOW).enabled).toBe(true);
  });
  it.each(['bytes', 'classA', 'classB'])('stops raw storage at the corridor reserve (%s)', async guard => {
    const h = await harness(), day = new Date(NOW).toISOString().slice(0, 10);
    if (guard === 'bytes') h.db.prepare('INSERT INTO dale_archive_meta(id,body) VALUES(1,?)').run(JSON.stringify({ v: 1, reservedBytes: 497_999_999_000, verifiedObjects: 0, failures: 0, reason: 'ready' }));
    else h.db.prepare('INSERT INTO dale_archive_days(day,class_a,class_b) VALUES(?,?,?)').run(day, guard === 'classA' ? 2_850_000 : 0, guard === 'classB' ? 8_850_000 : 0);
    await h.raw.capture([input()], NOW, []);
    expect(h.calls).toEqual([]); expect(h.raw.status().reason).toBe(guard === 'bytes' ? 'free-storage-budget' : 'free-operation-budget');
    expect(h.archive.status(NOW)).toMatchObject({ rawByteLimit: 498_000_000_000, rawClassALimit32Days: 2_850_000, rawClassBLimit32Days: 8_850_000 });
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
    expect(h.raw.status().reason).toBe('secret-response-rejected');
    await h.raw.capture([input()], NOW, secrets);
    expect(h.raw.status().reason).toBe('ready'); expect(h.raw.status().blockedSecrets).toBe(3);
    const all = [...h.objects.values()].map(b => new TextDecoder().decode(b)).join('');
    for (const secret of secrets) expect(all).not.toContain(secret);
    const health = JSON.stringify(h.raw.status());
    expect(health).not.toContain('sha256'); expect(health).not.toContain('synthetic'); expect(health).not.toContain('.pb');
  });
  it('finds a secret by bytes, including after a near miss, URL-encoded or JSON-escaped (audit DL-007)', async () => {
    const h = await harness(), secret = 'synthetic"pass word';
    const bodies = [`synthetic"pass worX synthetic"pass word`, `a=${encodeURIComponent(secret)}`, JSON.stringify({ echo: secret }), 'synthetic"pass wor'];
    await h.raw.capture(bodies.map((body, n) => ({ feed: 'rail-getTripUpdates', receivedAt: NOW + n, bytes: new TextEncoder().encode(body) })), NOW, [secret]);
    expect(h.raw.status().blockedSecrets).toBe(3);
    expect(h.raw.status().hoursUTC[0]!.feeds['rail-getTripUpdates']!.count).toBe(1);
  });
  it('checks a large response for secrets without decoding it into a string (audit DL-007)', async () => {
    const h = await harness(), big = new Uint8Array(4 * 1024 * 1024);
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    await h.raw.capture([input(NOW, big)], NOW, ['synthetic-password']);
    expect(decode.mock.calls.some(([bytes]) => ((bytes as ArrayBufferView | undefined)?.byteLength ?? 0) >= big.byteLength)).toBe(false);
    expect(h.raw.status().blockedSecrets).toBe(0); expect(h.raw.status().reason).toBe('ready');
  });
});

describe('raw collection through the bus Worker', () => {
  const regionAsset = { v: 1, feedVersion: ds.meta.feedVersion, counties: REGION_COUNTIES, routeIds: ['10'] };
  async function service(enabled = true, railEnabled = true, rawEnabled = true, region?: unknown, busEntities?: bindings.transit_realtime.IFeedEntity[]) {
    const dependency = arguments.length >= 4 ? region : regionAsset;
    const h = await harness(); let now = NOW, railCalls = 0, busFailure = false, railFailure = false, authFailure = false;
    let oversized = '', large = '', malformed = '', echo = false;
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
      if (isRail && echo) return new Response(new Uint8Array(binaryFeed([{ id: 'synthetic-token', vehicle: vehicle() }])));
      const feed = (isRail ? 'rail-' : '') + endpoint;
      if (feed === malformed) return new Response(new Uint8Array([0]));
      if (feed === oversized) {
        let n = 0;
        return new Response(new ReadableStream({ pull(controller) { if (n++ < 33) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close(); } }));
      }
      if (feed === large) {
        const largeBytes = new Uint8Array(binaryFeed([{ id: 'large-synthetic', vehicle: vehicle({ vehicle: { id: 'x'.repeat(9 * 1024 * 1024) } }) }]));
        return new Response(largeBytes);
      }
      if (!isRail && busEntities) return new Response(new Uint8Array(binaryFeed(busEntities)));
      if (!isRail && busFailure && endpoint === 'getVehiclePositions') return new Response('', { status: 503 });
      return new Response(new Uint8Array(binaryFeed([{ id: 'synthetic', ...(endpoint === 'getVehiclePositions' ? { vehicle: vehicle() } : { tripUpdate: update() }) }])));
    }) as typeof fetch;
    const Feed = createFeedClass(ds, fetchImpl, () => now, dependency), ctx = { storage, blockConcurrencyWhile: async <T,>(fn: () => Promise<T>) => fn() };
    const env = { NJT_API_USERNAME: 'synthetic-user', NJT_API_PASSWORD: 'synthetic-password', HISTORY_COLLECTION: enabled ? 'enabled' : 'disabled', HISTORY_ARCHIVE: h.bucket, RAW_ARCHIVE: rawEnabled ? 'enabled' : undefined, RAIL_GTFSRT_RAW: railEnabled ? 'enabled' : undefined,
      FEED: { idFromName: () => 'one', get: () => object } };
    let object = new Feed(ctx, env);
    const poll = async () => { await object.fetch(new Request('https://test/v1/status')); };
    return { ...h, poll, saved, urls, env, malformed: (feed: string) => { malformed = feed; }, oversized: (feed: string) => { oversized = feed; }, large: (feed: string) => { large = feed; }, failAuth: () => { authFailure = true; }, get railCalls() { return railCalls; }, time: (at: number) => { now = at; }, failBus: () => { busFailure = true; }, failRail: () => { railFailure = true; }, echoSecret: () => { echo = true; },
      restart: () => { object = new Feed(ctx, env); }, health: async () => (await (await object.fetch(new Request('https://test/v1/collection'))).json()).collection };
  }

  it.each(['vehicle', 'tripUpdate'] as const)('filters %s bus entities and records original provenance', async kind => {
    const entity = (id: string, routeId?: string) => ({ id, [kind]: kind === 'vehicle'
      ? vehicle({ trip: routeId ? { routeId } : {} }) : update({ trip: routeId ? { routeId } : {} }) });
    const entities = [entity('kept', '10'), entity('outside', '99'), entity('no-route')];
    const source = new Uint8Array(binaryFeed(entities));
    const h = await service(true, true, true, regionAsset, entities); await h.poll();
    const feed = kind === 'vehicle' ? 'getVehiclePositions' : 'getTripUpdates';
    const key = [...h.objects.keys()].find(k => k.includes(`/${feed}/`) && k.endsWith('.pb.gz'))!;
    const bytes = new Uint8Array(gunzipSync(h.objects.get(key)!));
    const decoded = bindings.transit_realtime.FeedMessage.decode(bytes);
    expect(decoded.entity.map(e => e.id)).toEqual(['kept']);
    expect(decoded.header).toEqual(bindings.transit_realtime.FeedMessage.decode(source).header);
    const manifest = JSON.parse(new TextDecoder().decode(h.objects.get(key + '.manifest.json')));
    expect(manifest).toMatchObject({ sha256: sha(bytes), rawBytes: bytes.byteLength,
      filtered: { v: 1, counties: REGION_COUNTIES, sourceSHA256: sha(source), sourceBytes: source.byteLength, entities: 3, kept: 1, noRoute: 1 } });
  });
  it('keeps an archive stop reason visible with no region file (Neon Nov25 k)', async () => {
    const h = await service(true, true, true, null); h.echoSecret(); await h.poll();
    expect((await h.health()).rawArchive).toMatchObject({ reason: 'secret-response-rejected', busRegion: 'statewide' });
  });
  it.each([null, undefined, { v: 1, feedVersion: 'old', counties: REGION_COUNTIES, routeIds: ['10'] },
    { v: 1, feedVersion: ds.meta.feedVersion, counties: REGION_COUNTIES, routeIds: [] }])('saves every statewide bus response whole with no usable region file (D84, %j)', async region => {
    const h = await service(true, true, true, region); await h.poll();
    // D84: bus alerts are saved whole too, alongside both bus feeds.
    for (const feed of ['getVehiclePositions', 'getTripUpdates', 'getAlerts']) {
      const busKey = [...h.objects.keys()].find(k => k.includes(`/${feed}/`) && k.endsWith('.pb.gz'))!;
      const sent = binaryFeed([{ id: 'synthetic', ...(feed === 'getVehiclePositions' ? { vehicle: vehicle() } : { tripUpdate: update() }) }]);
      expect(new Uint8Array(gunzipSync(h.objects.get(busKey)!))).toEqual(new Uint8Array(sent));
    }
    const railKey = [...h.objects.keys()].find(k => k.includes('/rail-getVehiclePositions/') && k.endsWith('.pb.gz'))!;
    expect(new Uint8Array(gunzipSync(h.objects.get(railKey)!))).toEqual(original());
    expect((await h.health()).rawArchive).toMatchObject({ busRegion: 'statewide' });
    expect((await h.health()).rawArchive.reason).not.toBe('region-unavailable');
    expect([...h.objects.keys()].some(k => k.includes('/rail-getAlerts/') && k.endsWith('.pb.gz'))).toBe(true);
    const normal = await service(); await normal.poll();
    const history = (db: DatabaseSync) => db.prepare('SELECT body FROM dale_history_batches ORDER BY attempt').all();
    expect(history(h.db).length).toBeGreaterThan(0);
    expect(history(h.db)).toEqual(history(normal.db));
    const savedFeed = (h.saved.get('state-v1') as { vehicles: unknown; updates: unknown });
    const normalFeed = (normal.saved.get('state-v1') as { vehicles: unknown; updates: unknown });
    expect(savedFeed.vehicles).toEqual(normalFeed.vehicles);
    expect(savedFeed.updates).toEqual(normalFeed.updates);
  });
  it('counts bus protobuf decode failure without interrupting the other feed or rail', async () => {
    const h = await service(); h.malformed('getVehiclePositions'); await h.poll();
    const raw = (await h.health()).rawArchive;
    expect(raw.failures).toBe(1);
    expect(raw.hoursUTC[0].events.getVehiclePositions['invalid-response']).toBe(1);
    expect(raw.hoursUTC[0].feeds.getVehiclePositions).toBeUndefined();
    expect(raw.hoursUTC[0].feeds.getTripUpdates.count).toBe(1);
    expect(raw.hoursUTC[0].feeds['rail-getVehiclePositions'].count).toBe(1);
    expect([...h.objects.keys()].some(k => k.includes('/getVehiclePositions/'))).toBe(false);
  });
  it('checks original secret echoes even in discarded bus entities and drops alerts', async () => {
    const entities = [{ id: 'keep', vehicle: vehicle() },
      { id: 'synthetic-password', vehicle: vehicle({ trip: { routeId: '99' } }) },
      { id: 'alert', alert: {}, vehicle: vehicle() }];
    const h = await service(true, true, true, regionAsset, entities); await h.poll();
    expect([...h.objects.keys()].some(k => /\/get(VehiclePositions|TripUpdates)\//.test(k))).toBe(false);
    expect((await h.health()).rawArchive.blockedSecrets).toBe(2);
  });
  it('saves all three rail protobuf originals every 30 seconds, including after eviction, using one cached token', async () => {
    const h = await service(); await h.poll();
    expect(h.railCalls).toBe(3);
    const railKey = [...h.objects.keys()].find(k => k.includes('/rail-getVehiclePositions/') && k.endsWith('.pb.gz'))!;
    expect(new Uint8Array(gunzipSync(h.objects.get(railKey)!))).toEqual(original());
    expect(railKey).toBe(`raw/v1/${new Date(NOW).toISOString().slice(0, 10)}/rail-getVehiclePositions/${NOW}-${sha(original())}.pb.gz`);
    h.restart(); h.time(NOW + 30_000); await h.poll(); expect(h.railCalls).toBe(6);
    h.time(NOW + 60_000); await h.poll(); expect(h.railCalls).toBe(9);
    expect(h.urls.filter(url => url.endsWith('/getToken'))).toHaveLength(1);
    const feeds = (await h.health()).rawArchive.hoursUTC[0].feeds;
    for (const feed of ['getVehiclePositions', 'getTripUpdates', 'rail-getVehiclePositions', 'rail-getTripUpdates', 'rail-getAlerts']) expect(feeds[feed].count).toBe(3);
    expect(JSON.stringify(await h.health())).not.toContain('synthetic');
    expect(h.urls.some(url => url.includes('/TrainData/'))).toBe(false);
  });
  it('tries statewide rail again an hour after a budget stop, even when nothing else clears it (audit DL-006)', async () => {
    const h = await service(); h.failAuth(); await h.poll(); expect(h.railCalls).toBe(3);
    const state = h.saved.get('state-v1') as { rawArchive: RawArchiveState };
    state.rawArchive.reason = 'free-storage-budget'; state.rawArchive.budgetAt = NOW + 30_000;
    h.restart(); h.time(NOW + 60_000); await h.poll(); expect(h.railCalls).toBe(3);
    h.restart(); h.time(NOW + 30_000 + 3_600_000); await h.poll(); expect(h.railCalls).toBe(6);
  });
  it('waits another hour when the rail retry after a budget stop fails before saving anything (Neon Nov24 d, #278)', async () => {
    const h = await service(); h.failAuth(); await h.poll(); expect(h.railCalls).toBe(3);
    const state = h.saved.get('state-v1') as { rawArchive: RawArchiveState };
    state.rawArchive.reason = 'free-storage-budget'; state.rawArchive.budgetAt = NOW + 30_000;
    h.failRail(); h.restart(); h.time(NOW + 30_000 + 3_600_000); await h.poll(); expect(h.railCalls).toBe(6);
    h.time(NOW + 90_000 + 3_600_000); await h.poll(); expect(h.railCalls).toBe(6);
    h.time(NOW + 30_000 + 7_200_000); await h.poll(); expect(h.railCalls).toBe(9);
  });
  it('bus refusals during a budget stop do not push back the hourly rail retry (CodeRabbit, #278)', async () => {
    const h = await service(); await h.poll(); expect(h.railCalls).toBe(3);
    const state = h.saved.get('state-v1') as { rawArchive: RawArchiveState };
    state.rawArchive.reason = 'free-storage-budget'; state.rawArchive.budgetAt = NOW + 30_000; state.rawArchive.credit.bytes = 0;
    const meta = JSON.parse(String(h.db.prepare('SELECT body FROM dale_archive_meta').get()!.body));
    meta.reservedBytes = 498_500_000_000; h.db.prepare('UPDATE dale_archive_meta SET body=?').run(JSON.stringify(meta));
    // Each poll's new bus originals are refused at the byte stop; rail stays paused.
    h.restart(); h.time(NOW + 60_000); await h.poll(); expect(h.railCalls).toBe(3);
    h.time(NOW + 1_800_000); await h.poll(); expect(h.railCalls).toBe(3);
    expect((await h.health()).rawArchive.reason).toBe('free-storage-budget');
    // One hour after the stop began, rail tries once, then waits another hour.
    h.time(NOW + 30_000 + 3_600_000); await h.poll(); expect(h.railCalls).toBe(6);
    h.time(NOW + 60_000 + 3_600_000); await h.poll(); expect(h.railCalls).toBe(6);
  });
  it('keeps trip updates and rail when vehicle positions fail upstream', async () => {
    const h = await service(); h.failBus(); await h.poll();
    const feeds = (await h.health()).rawArchive.hoursUTC[0].feeds;
    expect(feeds.getVehiclePositions).toBeUndefined(); expect(feeds.getTripUpdates.count).toBe(1); expect(feeds['rail-getVehiclePositions'].count).toBe(1);
  });
  it('a failed statewide bus alerts call is counted and never touches live buses or the shared token (D84)', async () => {
    const h = await service(true, true, true, null); h.oversized('getAlerts'); await h.poll();
    const raw = (await h.health()).rawArchive;
    expect(raw.hoursUTC[0].events.getAlerts['response-too-large']).toBe(1);
    expect(raw.hoursUTC[0].feeds.getVehiclePositions.count).toBe(1);
    expect(raw.hoursUTC[0].feeds.getTripUpdates.count).toBe(1);
    expect((h.saved.get('state-v1') as { token?: unknown }).token).toBeDefined();
    expect((h.saved.get('state-v1') as { vehicles: { feed: { state: string } } }).vehicles.feed.state).not.toBe('unavailable');
  });
  it('live buses reserve first: alerts are skipped and counted when only the bus feeds still fit (Neon Nov26 e, #301)', async () => {
    const h = await service(true, true, true, null); await h.poll();
    const state = h.saved.get('state-v1') as { busBudget: RequestBudget }, at = NOW + 45_000;
    // Leave exactly two requests in the rolling day: enough for both bus feeds, not for alerts.
    while (reserveRequests(structuredClone(state.busBudget), 3, at)) reserveRequests(state.busBudget, 1, at);
    h.saved.set('state-v1', state); h.restart(); h.time(at); await h.poll();
    const raw = (await h.health()).rawArchive;
    expect(raw.hoursUTC[0].feeds.getVehiclePositions.count).toBe(2);
    expect(raw.hoursUTC[0].feeds.getTripUpdates.count).toBe(2);
    expect(raw.hoursUTC[0].feeds.getAlerts.count).toBe(1);
    expect(raw.hoursUTC[0].events.getAlerts['request-ceiling']).toBe(1);
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
  it('reserves no bus requests during auth cooldown and records each skipped feed across restart', async () => {
    const h = await service(true, false); h.failAuth(); await h.poll();
    const budget = () => (h.saved.get('state-v1') as { busBudget: { hours: Record<string, number> } }).busBudget;
    const first = structuredClone(budget());
    expect(Object.values(first.hours)).toEqual([3]);
    for (const at of [NOW + 30_000, NOW + 60_000]) { h.restart(); h.time(at); await h.poll(); }
    expect(budget()).toEqual(first);
    expect(h.urls).toHaveLength(1);
    const ledger = (await h.health()).rawArchive.hoursUTC[0];
    for (const feed of ['getVehiclePositions', 'getTripUpdates']) {
      expect(ledger.events[feed]).toEqual({ 'access-denied': 1, 'authentication-cooldown': 2 });
      expect(ledger.feeds[feed]).toBeUndefined();
    }
    h.time(NOW + 3600_000); await h.poll();
    expect(Object.values(budget().hours).reduce((sum, n) => sum + n, 0)).toBe(6);
    expect(h.urls).toHaveLength(2);
  });
  it('reports a rail token-save SQL budget failure without mislabeling the agency ceiling', async () => {
    const reserve = HistoryJournal.prototype.reserveRawWrites;
    vi.spyOn(HistoryJournal.prototype, 'reserveRawWrites').mockImplementation(function (this: HistoryJournal, units, now) {
      return units === 3 ? false : reserve.call(this, units, now);
    });
    const h = await service(); await h.poll();
    expect(h.urls.filter(url => url.endsWith('/getToken'))).toHaveLength(1);
    expect(h.railCalls).toBe(0);
    expect((h.saved.get('state-v1') as { railGtfsrt: { reason: string } }).railGtfsrt.reason).toBe('sql-write-budget');
    const ledger = (await h.health()).rawArchive.hoursUTC[0];
    for (const feed of ['rail-getVehiclePositions', 'rail-getTripUpdates']) expect(ledger.events[feed]).toEqual({ 'sql-write-budget': 1 });
    expect(ledger.feeds.getVehiclePositions.count).toBe(1);
  });
  it.each(['token-limit', 'configuration-missing'])('records rail prepare %s for both skipped feeds', async code => {
    const h = await service(); await h.poll();
    const state = h.saved.get('state-v1') as { railGtfsrt: { token?: unknown; mints: number[] } };
    state.railGtfsrt.token = undefined;
    if (code === 'token-limit') state.railGtfsrt.mints = [NOW];
    else h.env.NJT_API_USERNAME = '';
    const before = h.urls.length;
    h.restart(); h.time(NOW + 30_000); await h.poll();
    expect(h.urls.slice(before).filter(url => url.includes('/GTFSRT/'))).toHaveLength(0);
    const ledger = (await h.health()).rawArchive.hoursUTC[0];
    for (const feed of ['rail-getVehiclePositions', 'rail-getTripUpdates']) expect(ledger.events[feed]).toEqual({ [code]: 1 });
    expect(ledger.feeds.getVehiclePositions.count).toBe(2);
  });
  it('saves no bus or rail original while RAW_ARCHIVE is absent, and keeps corridor history and live buses', async () => {
    const h = await service(true, true, false); await h.poll();
    expect(h.railCalls).toBe(0); expect(h.urls.some(url => url.includes('/GTFSRT/'))).toBe(false);
    expect([...h.objects.keys()].some(key => key.startsWith('raw/'))).toBe(false);
    const health = await h.health();
    expect(health.rawArchive).toBeUndefined();
    expect(health.enabled).toBe(true);
    expect(h.urls.filter(url => url.endsWith('/getVehiclePositions'))).toHaveLength(1);
  });
  it('turned off, finishes its open hourly ledger without saving or fetching anything new', async () => {
    const h = await service(); await h.poll();
    const rawKeys = () => [...h.objects.keys()].filter(key => key.startsWith('raw/') && key.endsWith('.pb.gz')).length;
    const saved = rawKeys(), railCalls = h.railCalls;
    expect((await h.health()).rawArchive.hoursUTC).toHaveLength(1);
    (h.env as { RAW_ARCHIVE?: string }).RAW_ARCHIVE = undefined; h.restart();
    h.time(NOW + 3600_000); await h.poll();
    expect(rawKeys()).toBe(saved); expect(h.railCalls).toBe(railCalls);
    expect([...h.objects.keys()].filter(key => key.startsWith('raw/') && key.includes('ledger'))).toHaveLength(1);
    expect((await h.health()).rawArchive).toMatchObject({ saving: false, pending: 0, hoursUTC: [] });
    h.restart(); h.time(NOW + 3630_000); await h.poll();
    expect((await h.health()).rawArchive).toBeUndefined(); expect(rawKeys()).toBe(saved);
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
    const size = gunzipSync(h.objects.get(key)!).byteLength;
    expect(size).toBeGreaterThan(9 * 1024 * 1024);
    expect((await h.health()).rawArchive.hoursUTC[0].feeds[feed].rawBytes).toBe(size);
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
    expect(urls.filter(url => api === 'bus' ? url.includes('/GTFSRT/') : url.includes('/GTFSG2/'))).toHaveLength(api === 'bus' ? 3 : 2);
    const ledger = (await h.health()).rawArchive.hoursUTC[0];
    for (const feed of api === 'bus' ? ['getVehiclePositions', 'getTripUpdates'] : ['rail-getVehiclePositions', 'rail-getTripUpdates'])
      expect(ledger.events[feed]).toEqual({ 'request-ceiling': 1 });
    const feeds = ledger.feeds;
    expect(feeds[api === 'bus' ? 'rail-getVehiclePositions' : 'getVehiclePositions'].count).toBe(2);
  });
  it('does not collect raw data or call rail when history collection is disabled', async () => {
    const h = await service(false); await h.poll();
    expect(h.objects.size).toBe(0); expect(h.railCalls).toBe(0); expect((await h.health()).rawArchive).toBeUndefined();
  });
});
