import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { OwnerHistory, ownerQuery, OWNER_HISTORY_PATH } from '../../worker/owner-history';
import { createFeedClass, createRouter } from '../../worker/service';
import { HistoryJournal } from '../../worker/history-journal';
import { A_LIMIT, B_LIMIT } from '../../worker/history-archive';
import { liveDataset as ds, NOW } from '../helpers/liveBus';

const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));
function harness() {
  const db = new DatabaseSync(':memory:'); dbs.push(db);
  const saved = new Map<string, unknown>();
  const storage = {
    sql: { databaseSize: 4096, exec(q: string, ...b: (string | number | null)[]) { const rows = db.prepare(q).all(...b) as Record<string, unknown>[]; return { toArray: () => rows }; } },
    transactionSync<T>(cb: () => T): T { db.exec('BEGIN'); try { const out = cb(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    get: async <T,>(key: string) => saved.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { saved.set(key, value); },
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  };
  new HistoryJournal(storage, ds, 'ctx');
  db.exec('CREATE TABLE dale_archive_days(day TEXT PRIMARY KEY, class_a INTEGER, class_b INTEGER)');
  return { db, storage };
}
const record = { route: '165', source: 'NJ Transit', observation: { tripInstanceId: 'SYNTHETIC@20261104', vehicleId: 'SYNTHETIC', observedAt: NOW, sourceAt: NOW + 20_000, lat: 40, lon: -74,
  riderLocation: 'MUST-NOT-APPEAR', stopCall: { status: 'stopped_at', stopIndex: 0, stopId: '1', rider: 'MUST-NOT-APPEAR' } }, rider: 'MUST-NOT-APPEAR' };
const batch = { v: 1, receivedAt: NOW, records: [record, { ...record, route: '999' }], rider: 'MUST-NOT-APPEAR', quality: { feedState: 'ok', rider: 'MUST-NOT-APPEAR' } };
const request = (token?: string, query = '', method = 'GET') => new Request(`https://owner.test${OWNER_HISTORY_PATH}${query}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });

async function expectPrivateError(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({ error });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Authorization');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.has('access-control-allow-origin')).toBe(false);
}

it.each([
  ['', 'POST', 405, 'Method not allowed'],
  ['?token=PRIVATE-REQUEST-DETAIL', 'GET', 400, 'Invalid query'],
] as const)('passes the Durable Object %s %s error through as private JSON', async (query, method, status, error) => {
  const { storage } = harness(), secret = randomUUID();
  const Feed = createFeedClass(ds, (async () => { throw Error('must not poll'); }) as typeof fetch, () => NOW);
  const object = new Feed({ storage, blockConcurrencyWhile: async <T,>(cb: () => Promise<T>) => cb() }, { OWNER_HISTORY_SECRET: secret } as never);
  let forwarded = 0;
  // Exercise the object's own guards behind a valid router request.
  const response = await createRouter(ds).fetch(request(secret), { OWNER_HISTORY_SECRET: secret,
    FEED: { idFromName: () => 'corridor', get: () => ({ fetch: async () => {
      forwarded++;
      const result = await object.fetch(request(secret, query, method));
      expect(result.headers.get('content-type')).toContain('application/json');
      return result;
    } }) } } as never);
  expect(forwarded).toBe(1);
  await expectPrivateError(response, status, error);
});

it.each([
  ['disabled', 404, 'Not found'],
  ['unauthorized', 401, 'Unauthorized'],
  ['origin', 403, 'Origin not allowed'],
  ['method', 405, 'Method not allowed'],
  ['query', 400, 'Invalid query'],
  ['unavailable', 503, 'History unavailable'],
] as const)('returns a private JSON router error when %s', async (kind, status, error) => {
  const secret = randomUUID(); let forwarded = 0;
  const req = request(kind === 'unauthorized' ? 'PRIVATE-WRONG-TOKEN' : secret,
    kind === 'query' ? '?token=PRIVATE-REQUEST-DETAIL' : '', kind === 'method' ? 'POST' : 'GET');
  if (kind === 'origin') req.headers.set('origin', 'https://private-origin.test');
  const response = await createRouter(ds).fetch(req, { OWNER_HISTORY_SECRET: kind === 'disabled' ? undefined : secret,
    FEED: { idFromName: () => 'corridor', get: () => ({ fetch: async () => {
      forwarded++;
      throw Error(`Private failure: ${secret} ${req.url}`);
    } }) } } as never);
  expect(forwarded).toBe(kind === 'unavailable' ? 1 : 0);
  await expectPrivateError(response, status, error);
});

it('returns parseable private JSON through the router when history storage is unavailable', async () => {
  const { storage } = harness(), secret = randomUUID();
  const { sql: _sql, transactionSync: _transaction, ...unavailable } = storage;
  let network = 0;
  const Feed = createFeedClass(ds, (async () => { network++; throw Error('no upstream'); }) as typeof fetch, () => NOW);
  const object = new Feed({ storage: unavailable, blockConcurrencyWhile: async <T,>(cb: () => Promise<T>) => cb() }, { OWNER_HISTORY_SECRET: secret } as never);
  const response = await createRouter(ds).fetch(request(secret), { OWNER_HISTORY_SECRET: secret,
    FEED: { idFromName: () => 'corridor', get: () => ({ fetch: (r: Request) => object.fetch(r) }) } } as never);
  expect(response.status).toBe(503);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({ error: 'history-unavailable' });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.has('access-control-allow-origin')).toBe(false);
  expect(network).toBe(0);
});

it('authenticates at both boundaries: unset, missing and wrong never reach storage or upstream; right is read-only', async () => {
  const { db, storage } = harness();
  db.prepare('INSERT INTO dale_history_batches(attempt,received_at,feed_version,context_key,bytes,body) VALUES(?,?,?,?,?,?)').run(NOW, NOW, 'fixture', 'ctx', 1, JSON.stringify(batch));
  const secret = randomUUID(); let network = 0, forwarded = 0;
  const Feed = createFeedClass(ds, (async () => { network++; throw Error('no upstream'); }) as typeof fetch, () => NOW);
  const object = new Feed({ storage, blockConcurrencyWhile: async <T,>(cb: () => Promise<T>) => cb() }, { OWNER_HISTORY_SECRET: secret } as never);
  const router = createRouter(ds);
  const env = { OWNER_HISTORY_SECRET: secret, FEED: { idFromName: () => 'corridor', get: () => ({ fetch: async (r: Request) => { forwarded++; return object.fetch(r); } }) } };
  expect((await router.fetch(request(secret), { ...env, OWNER_HISTORY_SECRET: undefined } as never)).status).toBe(404);
  for (const token of [undefined, randomUUID()]) {
    expect((await router.fetch(request(token), env as never)).status).toBe(401);
    expect((await object.fetch(request(token))).status).toBe(401);
  }
  expect(forwarded).toBe(0);
  const result = await router.fetch(request(secret), env as never);
  expect(result.status).toBe(200);
  const body = await result.text(); expect(body).toContain('SYNTHETIC@'); expect(body).toContain(`"sourceAt":${NOW + 20_000}`); expect(body).not.toMatch(/MUST-NOT-APPEAR|999/);
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(result.headers.has('access-control-allow-origin')).toBe(false);
  const before = db.prepare('SELECT * FROM dale_history_batches').all();
  expect((await object.fetch(request(secret))).status).toBe(200);
  expect(db.prepare('SELECT * FROM dale_history_batches').all()).toEqual(before);
  expect(network).toBe(0);
  for (const [q, method, status] of [['?token=bad', 'GET', 400], ['', 'POST', 405], ['?after=0&after=1', 'GET', 400]] as const)
    expect((await router.fetch(request(secret, q, method), env as never)).status).toBe(status);
  const browser = request(secret); browser.headers.set('origin', 'https://jwchr.github.io');
  expect((await router.fetch(browser, env as never)).status).toBe(403);
  const disabled = new Feed({ storage, blockConcurrencyWhile: async <T,>(cb: () => Promise<T>) => cb() }, {} as never);
  expect((await disabled.fetch(request(secret))).status).toBe(404);
});

it('pages hot evidence without modifying history or reading any other table', async () => {
  const h = harness();
  const put = h.db.prepare('INSERT INTO dale_history_batches(attempt,received_at,feed_version,context_key,bytes,body) VALUES(?,?,?,?,?,?)');
  for (let i = 0; i < 5; i++) put.run(NOW + i, NOW, 'fixture', 'ctx', 1, JSON.stringify(batch));
  const door = new OwnerHistory(h.storage);
  const first = await (await door.read({ kind: 'hot', after: 0 }, NOW, () => { throw Error('hot reads need no writes'); })).json() as { nextAfter: number; batches: unknown[] };
  expect(first.batches).toHaveLength(4);
  const second = await (await door.read({ kind: 'hot', after: first.nextAfter }, NOW, () => true)).json() as { nextAfter: null; batches: unknown[] };
  expect(second.batches).toHaveLength(1); expect(second.nextAfter).toBeNull();
});

it('reads immutable archive evidence with checksum/size limits, field whitelist, shared reservations and no retries', async () => {
  const { db, storage } = harness();
  const raw = new TextEncoder().encode(JSON.stringify(batch));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(n => n.toString(16).padStart(2, '0')).join('');
  const key = `v1/2026-11-04/batches/${NOW}-${hash}.json.gz`;
  const bytes = await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  let gets = 0, lists = 0;
  const bucket = { get: async () => { gets++; return { size: bytes.byteLength, arrayBuffer: async () => bytes }; },
    list: async () => { lists++; return { objects: [{ key, size: bytes.byteLength }, { key: key + '.manifest.json', size: 100 }], truncated: true }; } };
  const door = new OwnerHistory(storage, bucket);
  expect(ownerQuery(new URL(`https://x/?key=${key}`))).toEqual({ kind: 'object', key });
  const list = await (await door.read({ kind: 'list', day: '2026-11-04' }, NOW, () => true)).json() as { keys: string[]; nextAfter: string };
  expect(list.keys).toEqual([key]); expect(list.nextAfter).toBe(key + '.manifest.json');
  expect(ownerQuery(new URL(`https://x/?day=2026-11-04&after=${list.nextAfter}`))).toMatchObject({ kind: 'list' });
  const result = await door.read({ kind: 'object', key }, NOW, () => true);
  expect(result.status).toBe(200); expect(await result.text()).not.toMatch(/MUST-NOT-APPEAR|999/);
  expect([gets, lists]).toEqual([1, 1]);
  expect(db.prepare('SELECT class_a,class_b FROM dale_archive_days').get()).toEqual({ class_a: 1, class_b: 1 });
  expect((await door.read({ kind: 'object', key }, NOW, () => false)).status).toBe(503);
  db.prepare('UPDATE dale_archive_days SET class_a=?,class_b=?').run(A_LIMIT, B_LIMIT);
  expect((await door.read({ kind: 'object', key }, NOW, () => true)).status).toBe(503);
  expect(gets).toBe(1);
  db.exec('DELETE FROM dale_archive_days');
  const badKey = key.replace(hash, '0'.repeat(64));
  expect((await door.read({ kind: 'object', key: badKey }, NOW, () => true)).status).toBe(503);
  expect(gets).toBe(2);
  const oversized = new OwnerHistory(storage, { ...bucket, get: async () => ({ size: 256001, arrayBuffer: async () => { throw Error('must not read'); } }) });
  expect((await oversized.read({ kind: 'object', key }, NOW, () => true)).status).toBe(503);
  const inflated = new Uint8Array(128001);
  const bomb = await new Response(new Blob([inflated]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const expansion = new OwnerHistory(storage, { ...bucket, get: async () => ({ size: bomb.byteLength, arrayBuffer: async () => bomb }) });
  expect((await expansion.read({ kind: 'object', key }, NOW, () => true)).status).toBe(503);
  const manifests = new OwnerHistory(storage, { ...bucket, list: async () => ({ objects: [{ key: key + '.manifest.json', size: 100 }], truncated: true }) });
  const page = await (await manifests.read({ kind: 'list', day: '2026-11-04' }, NOW, () => true)).json() as { keys: string[]; nextAfter: string };
  expect(page.keys).toEqual([]); expect(page.nextAfter).toBe(key + '.manifest.json');

});

it('keeps owner reads open once raw saving passes half of each cap (Neon DEEP Nov 26, B1-4)', async () => {
  const { db, storage } = harness();
  // A month of raw saving: Class A past half, Class B nearly full. A list charges only Class A,
  // an object read only Class B, so each is checked against its own class only.
  db.prepare('INSERT INTO dale_archive_days(day,class_a,class_b) VALUES(?,?,?)').run('2026-11-04', A_LIMIT / 2 + 1000, B_LIMIT);
  let calls = 0;
  const door = new OwnerHistory(storage, {
    list: async () => { calls++; return { objects: [], truncated: false }; },
    get: async () => { calls++; return null; },
  });
  expect((await door.read({ kind: 'list', day: '2026-11-04' }, NOW, () => true)).status).toBe(200);
  expect((await door.read({ kind: 'object', key: `v1/2026-11-04/batches/${NOW}-${'0'.repeat(64)}.json.gz` }, NOW, () => true)).status).toBe(503);
  expect(calls).toBe(1);
});

it('rejects arbitrary object paths, invalid dates, duplicate/unknown params and cross-day cursors', () => {
  for (const q of ['key=rides/a', 'day=2026-02-30', 'day=2026-11-04&after=bad', 'after=-1', 'after=1&trip=x', 'key=x&key=y', 'secret=x'])
    expect(ownerQuery(new URL(`https://x/?${q}`))).toBeUndefined();
});

it.each(['classA', 'classB', 'missing-ledger'])('charges no spare writes or R2 operations for %s', async reason => {
  const { db, storage } = harness();
  if (reason === 'missing-ledger') db.exec('DROP TABLE dale_archive_days');
  else db.prepare('INSERT INTO dale_archive_days(day,class_a,class_b) VALUES(?,?,?)')
    .run('2026-11-04', reason === 'classA' ? A_LIMIT : 0, reason === 'classB' ? B_LIMIT : 0);
  let reserves = 0, calls = 0;
  const door = new OwnerHistory(storage, {
    list: async () => { calls++; return { objects: [], truncated: false }; },
    get: async () => { calls++; return null; },
  });
  const query = reason === 'classB'
    ? { kind: 'object' as const, key: `v1/2026-11-04/batches/${NOW}-${'0'.repeat(64)}.json.gz` }
    : { kind: 'list' as const, day: '2026-11-04' };
  for (let i = 0; i < 3; i++) {
    await expectPrivateError(await door.read(query, NOW, () => { reserves++; return true; }), 503,
      reason === 'missing-ledger' ? 'history-unavailable' : 'free-budget');
  }
  expect(reserves).toBe(0);
  expect(calls).toBe(0);
  if (reason === 'missing-ledger') expect(db.prepare("SELECT name FROM sqlite_master WHERE name='dale_archive_days'").get()).toBeUndefined();
  else expect(db.prepare('SELECT class_a,class_b FROM dale_archive_days').get()).toEqual({
    class_a: reason === 'classA' ? A_LIMIT : 0, class_b: reason === 'classB' ? B_LIMIT : 0,
  });
});

it.each(['list', 'object'] as const)('serves owner archive %s reads while paused, with shared quotas and no collection side effects', async kind => {
  const { db, storage } = harness();
  const journal = new HistoryJournal(storage, ds, 'ctx');
  journal.setEnabled(true, NOW); journal.setEnabled(false, NOW);
  const raw = new TextEncoder().encode(JSON.stringify(batch));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(n => n.toString(16).padStart(2, '0')).join('');
  const key = `v1/2026-11-04/batches/${NOW}-${hash}.json.gz`;
  const bytes = await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  let archiveReads = 0, network = 0, alarms = 0;
  const bucket = {
    get: async () => { archiveReads++; return { size: bytes.byteLength, arrayBuffer: async () => bytes }; },
    list: async () => { archiveReads++; return { objects: [{ key, size: bytes.byteLength }], truncated: false }; },
  };
  storage.setAlarm = async () => { alarms++; };
  const Feed = createFeedClass(ds, async () => { network++; throw Error('must not poll'); }, () => NOW);
  const secret = randomUUID();
  const object = new Feed({ storage, blockConcurrencyWhile: async <T,>(cb: () => Promise<T>) => cb() },
    { OWNER_HISTORY_SECRET: secret, HISTORY_ARCHIVE: bucket, HISTORY_COLLECTION: 'disabled' } as never);
  const q = kind === 'list' ? '?day=2026-11-04' : `?key=${key}`;
  const before = journal.status(NOW);
  const response = await object.fetch(request(secret, q));
  expect(response.status).toBe(200);
  expect(archiveReads).toBe(1);
  expect(journal.status(NOW)).toMatchObject({ enabled: false, reason: 'disabled', batches: 0, observations: 0,
    reservedWrites: before.reservedWrites + 2 });
  expect(journal.beginAttempt(NOW)).toBeUndefined();
  expect(journal.reserveSpareWrites(1, NOW)).toBe(false);
  expect([network, alarms]).toEqual([0, 0]);
  const state = JSON.parse(String(db.prepare('SELECT body FROM dale_history_meta').get()!.body));
  state.reservedWrites = 1_000_000;
  db.prepare('UPDATE dale_history_meta SET body=?').run(JSON.stringify(state));
  expect((await object.fetch(request(secret, q))).status).toBe(503);
  expect(archiveReads).toBe(1);
  expect(db.prepare('SELECT class_a,class_b FROM dale_archive_days').get()).toEqual({ class_a: kind === 'list' ? 1 : 0, class_b: kind === 'object' ? 1 : 0 });
});
