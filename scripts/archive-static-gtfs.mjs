// Private daily originals. ZIP is already compressed: keep its exact bytes as .zip, without gzip.
// Acceptance: synthetic tests prove byte preservation, deduplication, feed isolation and verified
// receipts. Failure analysis: reject bad/large/secret-bearing responses; never advance an index
// after partial uploads or corrupt readback. Only the mutable last-version index is overwritten.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { njtRequest, NjtError } from '../worker/njt-client.ts';

const FEEDS = [
  // Bus logs in with authenticateUser (as the live Worker does); rail GTFSRT with getToken.
  { feed: 'static-bus-gtfs', api: 'bus', login: 'authenticateUser', max: 128 * 1024 * 1024, source: 'NJ Transit GTFSG2 getGTFS' },
  { feed: 'static-rail-gtfs', api: 'rail-gtfsrt', login: 'getToken', max: 64 * 1024 * 1024, source: 'NJ Transit GTFSRT getGTFS' },
];
/** D84 (Jeff, Nov 26, 2026: "All the data, save all the data."): the free public schedule ZIPs that
 *  NJ Transit's developer portal lists, saved daily like the two above. No account or key; plain GET.
 *  Partner and county carriers (several run NJ to Manhattan), NJ Transit's public bus and rail ZIPs,
 *  Coach USA and Seastreak. URLs read from the portal's own script on Nov 26, 2026; each answered
 *  200 with a ZIP that day (NJ Transit's redirect to content.njtransit.com). */
const PARTNERS = [['academy', 'Academy_bus_data'], ['atlantic-county', 'AtlanticCo_bus_data'], ['broadway', 'broadway_bus_data'],
  ['burlington-shuttles', 'BurlingtonShuttles_bus_data'], ['cumberland-county', 'Cumberland_Co_bus_data'],
  ['gloucester-county', 'Gloucester_Co_bus_data'], ['hunterdon-county', 'Hunterdon_Co_bus_data'],
  ['lakeland', 'LakelandBusLines_bus_data'], ['sjta', 'SJTA_bus_data'], ['somerset-county', 'SomersetCounty_bus_data'],
  ['sussex-county', 'sussexcounty_bus_data'], ['trans-bridge', 'Trans-Bridge_bus_data'],
  ['tuckerton-seaport', 'TuckertonSeaport_bus_data'], ['warren-county', 'WCT_bus_data']];
export const PUBLIC_FEEDS = [
  ...PARTNERS.map(([slug, file]) => ({ feed: `static-partner-${slug}`, url: `https://www.njtransit.com/${file}.zip`,
    max: 64 * 1024 * 1024, source: `NJ Transit developer portal ${file}.zip` })),
  { feed: 'static-njt-public-bus-gtfs', url: 'https://www.njtransit.com/bus_data.zip', max: 192 * 1024 * 1024, source: 'NJ Transit developer portal bus_data.zip' },
  { feed: 'static-njt-public-rail-gtfs', url: 'https://www.njtransit.com/rail_data.zip', max: 64 * 1024 * 1024, source: 'NJ Transit developer portal rail_data.zip' },
  { feed: 'static-partner-coach-usa', url: 'https://api.prod.coachusa.com/gtfs', max: 64 * 1024 * 1024, source: 'Coach USA GTFS (listed on NJ Transit developer portal)' },
  { feed: 'static-partner-seastreak', url: 'https://seastreak.com/api/transit/google_transit.zip', max: 64 * 1024 * 1024, source: 'Seastreak GTFS (listed on NJ Transit developer portal)' },
];
/** Redirects are followed by hand, only over HTTPS and only to these hosts. */
const PUBLIC_HOSTS = new Set(['www.njtransit.com', 'njtransit.com', 'content.njtransit.com', 'api.prod.coachusa.com', 'seastreak.com']);
const MAX_REDIRECTS = 3, PUBLIC_TIMEOUT_MS = 120_000;
const CODES = new Set(['configuration-missing', 'access-denied', 'rate-limited', 'http-error',
  'response-too-large', 'timed-out', 'network-error', 'invalid-response', 'upload-failed', 'readback-mismatch']);
// The public downloads also name a refused redirect and an empty body.
const PUBLIC_CODES = new Set([...CODES, 'redirect-refused', 'empty-response']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value));
const fail = code => { throw new NjtError(code); };
const matches = (actual, expected) => actual instanceof Uint8Array
  && actual.byteLength === expected.byteLength && hash(actual) === hash(expected);
function containsSecret(bytes, secrets) {
  return secrets.filter(Boolean).some(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]
    .some(value => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from(value))));
}
// ZIP local-file signature. Includes refusal of small HTTP-200 JSON or HTML error bodies.
const isZip = bytes => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
function parseIndex(bytes, feed) {
  try {
    if (bytes.byteLength > 16_384) fail('invalid-response');
    const index = JSON.parse(new TextDecoder().decode(bytes));
    if (index.v !== 1 || index.feed !== feed || !/^[a-f0-9]{64}$/.test(index.sha256)
      || typeof index.key !== 'string'
      || !new RegExp(`^raw/v1/\\d{4}-\\d{2}-\\d{2}/${feed}/\\d+-${index.sha256}\\.zip$`).test(index.key)
      || !Number.isSafeInteger(index.lastCheckedAt) || index.lastCheckedAt < 0) fail('invalid-response');
    return { v: 1, feed, sha256: index.sha256, key: index.key, lastCheckedAt: index.lastCheckedAt };
  } catch { fail('invalid-response'); }
}

/** Saves one ZIP original with its manifest, verifies both by readback, then advances its index.
 *  An unchanged ZIP only refreshes lastCheckedAt. step() names the operation for failure codes. */
async function store({ feed, bytes, receivedAt, source, secrets, bucket, step }) {
  const sha256 = hash(bytes), indexKey = `raw/v1/static-index/${feed}.json`;
  step('index-read');
  const priorBytes = await bucket.get(indexKey);
  const prior = priorBytes === null ? null : parseIndex(priorBytes, feed);
  if (prior?.sha256 === sha256) {
    const next = json({ ...prior, lastCheckedAt: receivedAt });
    if (containsSecret(next, secrets)) fail('invalid-response');
    step('index-update');
    await bucket.put(indexKey, next, 'application/json');
    return 'unchanged';
  }
  const day = new Date(receivedAt).toISOString().slice(0, 10);
  const key = `raw/v1/${day}/${feed}/${receivedAt}-${sha256}.zip`;
  const manifestKey = `${key}.manifest.json`;
  const manifest = json({ v: 1, feed, receivedAt, sha256, bytes: bytes.byteLength, source });
  const index = json({ v: 1, feed, sha256, key, lastCheckedAt: receivedAt });
  if (containsSecret(manifest, secrets) || containsSecret(index, secrets)) fail('invalid-response');
  for (const [objectKey, data, type] of [[key, bytes, 'application/zip'], [manifestKey, manifest, 'application/json']]) {
    step('archive-read');
    const existing = await bucket.get(objectKey);
    if (existing !== null && !matches(existing, data)) fail('readback-mismatch');
    if (existing === null) {
      step('archive-upload');
      await bucket.put(objectKey, data, type);
    }
  }
  step('readback');
  // Both stored objects must hash to the exact uploaded bodies before the index advances.
  for (const [objectKey, expected] of [[key, bytes], [manifestKey, manifest]]) {
    if (!matches(await bucket.get(objectKey), expected)) fail('readback-mismatch');
  }
  step('index-update');
  await bucket.put(indexKey, index, 'application/json');
  return 'saved';
}

/** Deterministic core: all I/O and time are injected; no filesystem, environment or logging access.
 * Result codes are fixed, never exception text. No retries or extra authentication calls.
 * The workflow serializes writers. Reads before immutable puts preserve same-receipt retries;
 * an interrupted run can leave an unindexed original, which is retained, never removed.
 */
export async function archiveStaticGtfs({ credentials, fetchImpl, clock, bucket }) {
  const feeds = {};
  for (const { feed, api, login, max, source } of FEEDS) {
    let operation = 'configuration', receivedAt;
    const secrets = [credentials?.NJT_API_USERNAME, credentials?.NJT_API_PASSWORD];
    try {
      if (!credentials?.NJT_API_USERNAME?.trim() || !credentials?.NJT_API_PASSWORD?.trim()) fail('configuration-missing');
      operation = 'authentication';
      // Same multipart fields and bounded request helper as existing downloads.
      const auth = await njtRequest(login, { username: credentials.NJT_API_USERNAME,
        password: credentials.NJT_API_PASSWORD }, 16_384, fetchImpl, 120_000, api);
      let value;
      try { value = JSON.parse(new TextDecoder().decode(auth)); } catch { fail('invalid-response'); }
      if (String(value?.Authenticated).toLowerCase() !== 'true') fail('access-denied');
      if (typeof value?.UserToken !== 'string' || !value.UserToken.trim()) fail('invalid-response');
      const token = value.UserToken.trim();
      secrets.push(value.UserToken, token);
      operation = 'download';
      const bytes = await njtRequest('getGTFS', { token }, max, fetchImpl, 120_000, api);
      receivedAt = clock();
      if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) fail('invalid-response');
      if (!isZip(bytes) || containsSecret(bytes, secrets)) fail('invalid-response');
      feeds[feed] = { status: await store({ feed, bytes, receivedAt, source, secrets, bucket, step: op => { operation = op; } }), receivedAt };
    } catch (error) {
      const code = error instanceof NjtError && CODES.has(error.code) ? error.code
        : error instanceof NjtError ? 'invalid-response'
        : ['authentication', 'download'].includes(operation) ? 'network-error' : 'upload-failed';
      feeds[feed] = { status: 'failed', code, operation, ...(receivedAt === undefined ? {} : { receivedAt }) };
    }
  }
  return { feeds, exitCode: Object.values(feeds).some(result => result.status === 'failed') ? 1 : 0 };
}

/** One public GET with a byte cap and one time limit covering redirects and the whole body. */
async function download(url, max, fetchImpl, timeoutMs) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  // A source that ignores the abort signal still cannot hold the run past its time limit.
  const expired = new Promise((_, reject) => ctl.signal.addEventListener('abort', () => reject(new NjtError('timed-out'))));
  expired.catch(() => {});
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const target = new URL(url);
      if (target.protocol !== 'https:' || !PUBLIC_HOSTS.has(target.hostname)) fail('redirect-refused');
      const response = await Promise.race([expired, fetchImpl(target.href, { method: 'GET', redirect: 'manual', cache: 'no-store',
        signal: ctl.signal, headers: { 'user-agent': 'Dale transit app (github.com/jwchr/dale)' } })]);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location) fail('redirect-refused');
        url = new URL(location, target).href;
        continue;
      }
      if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'access-denied' : response.status === 429 ? 'rate-limited' : 'http-error');
      if (!response.body) fail('empty-response');
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await Promise.race([expired, reader.read()]); if (done) break;
          size += value.byteLength;
          if (size > max) { void reader.cancel().catch(() => {}); fail('response-too-large'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
      return bytes;
    }
    fail('redirect-refused');
  } catch (error) {
    if (error instanceof NjtError) throw error;
    throw new NjtError(ctl.signal.aborted ? 'timed-out' : 'network-error');
  } finally { clearTimeout(timer); ctl.abort(); }
}

/** The public ZIPs, one at a time, each failing alone. Same storage, receipts and codes as above. */
export async function archivePublicGtfs({ credentials, fetchImpl, clock, bucket, feeds: list = PUBLIC_FEEDS, timeoutMs = PUBLIC_TIMEOUT_MS }) {
  const feeds = {};
  const secrets = [credentials?.NJT_API_USERNAME, credentials?.NJT_API_PASSWORD];
  for (const { feed, url, max, source } of list) {
    let operation = 'download', receivedAt;
    try {
      const bytes = await download(url, max, fetchImpl, timeoutMs);
      receivedAt = clock();
      if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) fail('invalid-response');
      if (!isZip(bytes) || containsSecret(bytes, secrets)) fail('invalid-response');
      feeds[feed] = { status: await store({ feed, bytes, receivedAt, source, secrets, bucket, step: op => { operation = op; } }), receivedAt };
    } catch (error) {
      const code = error instanceof NjtError && PUBLIC_CODES.has(error.code) ? error.code
        : error instanceof NjtError ? 'invalid-response'
        : operation === 'download' ? 'network-error' : 'upload-failed';
      feeds[feed] = { status: 'failed', code, operation, ...(receivedAt === undefined ? {} : { receivedAt }) };
    }
  }
  return { feeds, exitCode: Object.values(feeds).some(result => result.status === 'failed') ? 1 : 0 };
}

/** CLI-only adapter. Child output is captured and never logged, including on failure. */
export function createWranglerBucket({ directory, env, run = promisify(execFile) }) {
  let sequence = 0;
  const config = fileURLToPath(new URL('../worker/wrangler.jsonc', import.meta.url));
  async function command(method, key, bytes, contentType) {
    // Every data/readback file lives inside the private mkdtemp directory, never the checkout.
    const file = join(directory, `object-${sequence++}`);
    try {
      if (method === 'put') await writeFile(file, bytes, { mode: 0o600 });
      const args = ['--no-install', 'wrangler', 'r2', 'object', method, `dale-history/${key}`,
        '--remote', '--file', file, '--config', config];
      if (method === 'put') args.push('--content-type', contentType, '--cache-control', 'private, no-store');
      try {
        await run('npx', args, { cwd: fileURLToPath(new URL('../', import.meta.url)),
          timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true,
          env: { ...env, NJT_API_USERNAME: '', NJT_API_PASSWORD: '', WRANGLER_SEND_METRICS: 'false',
            WRANGLER_LOG_PATH: join(directory, 'wrangler.log'), CI: 'true' } });
      } catch (error) {
        // Verified against installed Wrangler's remote-get handler. Never treat arbitrary
        // access/network errors as missing, and never expose this captured output.
        if (method === 'get' && error?.code === 1
          && `${error.stdout ?? ''}\n${error.stderr ?? ''}`.includes('The specified key does not exist.')) return null;
        fail('upload-failed');
      }
      return method === 'get' ? new Uint8Array(await readFile(file)) : undefined;
    } finally { await rm(file, { force: true }); }
  }
  return { get: key => command('get', key), put: (key, bytes, contentType) => command('put', key, bytes, contentType) };
}

export async function runCli({ env = process.env, fetchImpl = fetch, clock = Date.now,
  runWrangler, log = line => console.log(line), publicFeeds = PUBLIC_FEEDS } = {}) {
  let directory;
  try {
    if (!env.CLOUDFLARE_API_TOKEN?.trim() || !env.CLOUDFLARE_ACCOUNT_ID?.trim()) fail('configuration-missing');
    directory = await mkdtemp(join(tmpdir(), 'dale-static-gtfs-'));
    const bucket = createWranglerBucket({ directory, env, run: runWrangler });
    // The NJ Transit API downloads run first; a failure there never stops the public ZIPs.
    const api = await archiveStaticGtfs({ credentials: env, fetchImpl, clock, bucket });
    const open = await archivePublicGtfs({ credentials: env, fetchImpl, clock, bucket, feeds: publicFeeds });
    const exitCode = api.exitCode || open.exitCode;
    log(JSON.stringify({ script: 'archive-static-gtfs/v1', node: process.version, feeds: { ...api.feeds, ...open.feeds }, exitCode }));
    return exitCode;
  } catch (error) {
    const code = error instanceof NjtError && CODES.has(error.code) ? error.code : 'upload-failed';
    log(JSON.stringify({ script: 'archive-static-gtfs/v1', node: process.version,
      feeds: Object.fromEntries([...FEEDS, ...publicFeeds].map(({ feed }) => [feed, { status: 'failed', code }])), exitCode: 1 }));
    return 1;
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
