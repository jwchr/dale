import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error native Node ESM script without declarations
import { PUBLIC_FEEDS, archivePublicGtfs, archiveStaticGtfs, createWranglerBucket, runCli } from '../../scripts/archive-static-gtfs.mjs';

const BUS = 'static-bus-gtfs', RAIL = 'static-rail-gtfs';
const NOW = Date.UTC(2026, 10, 26, 9, 17);
const credentials = { NJT_API_USERNAME: 'synthetic-user-3981', NJT_API_PASSWORD: 'synthetic-password-7412' };
const tokens = { bus: 'synthetic-bus-token-3728', rail: 'synthetic-rail-token-9924' };
const zip = (suffix = 1) => new Uint8Array([0x50, 0x4b, 3, 4, 0, 255, suffix]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const indexKey = (feed: string) => `raw/v1/static-index/${feed}.json`;
const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function harness() {
  let at = NOW, bus = zip(), rail = zip(2);
  let railStatus = 200, busStatus = 200, authStatus = 200;
  let corrupt = '', putFailure = '', getFailure = '';
  const objects = new Map<string, Uint8Array>();
  const writes: { key: string; bytes: Uint8Array; type: string }[] = [];
  const reads: string[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const bucket = {
    async get(key: string): Promise<Uint8Array | null> {
      reads.push(key);
      if (getFailure && key.includes(getFailure)) throw new Error(credentials.NJT_API_PASSWORD);
      const bytes = objects.get(key);
      if (bytes && corrupt && key.endsWith(corrupt)) return new Uint8Array([8, 9]);
      return bytes?.slice() ?? null;
    },
    async put(key: string, bytes: Uint8Array, type: string) {
      if (putFailure && key.includes(putFailure)) throw new Error(tokens.rail);
      writes.push({ key, bytes: bytes.slice(), type }); objects.set(key, bytes.slice());
    },
  };
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const isRail = url.includes('raildata.'), token = isRail ? tokens.rail : tokens.bus;
    if ((url.endsWith('/getToken') || url.endsWith('/authenticateUser'))) return new Response(json({ Authenticated: true, UserToken: token }), { status: authStatus });
    return new Response((isRail ? rail : bus).slice().buffer, { status: isRail ? railStatus : busStatus });
  });
  return { objects, writes, reads, requests, bucket, fetchImpl,
    run: () => archiveStaticGtfs({ credentials, fetchImpl, clock: () => at, bucket }),
    day: () => { at += 86_400_000; }, setBus: (bytes: Uint8Array) => { bus = new Uint8Array(bytes); },
    setRail: (bytes: Uint8Array) => { rail = new Uint8Array(bytes); }, railStatus: (status: number) => { railStatus = status; },
    busStatus: (status: number) => { busStatus = status; }, authStatus: (status: number) => { authStatus = status; },
    corrupt: (suffix: string) => { corrupt = suffix; }, failPut: (part: string) => { putFailure = part; },
    failGet: (part: string) => { getFailure = part; } };
}

describe('daily private static timetable archive', () => {
  it('1: first run saves both exact ZIPs, manifests and indices with UTC receipt keys', async () => {
    const h = harness(), result = await h.run();
    expect(result.exitCode).toBe(0); expect(h.writes).toHaveLength(6);
    expect(h.objects.size).toBe(6);
    for (const [feed, bytes, source] of [[BUS, zip(), 'NJ Transit GTFSG2 getGTFS'],
      [RAIL, zip(2), 'NJ Transit GTFSRT getGTFS']] as const) {
      const key = `raw/v1/2026-11-26/${feed}/${NOW}-${sha(bytes)}.zip`;
      expect(h.objects.get(key)).toEqual(bytes);
      expect(decode(h.objects.get(`${key}.manifest.json`)!)).toEqual({ v: 1, feed, receivedAt: NOW,
        sha256: sha(bytes), bytes: bytes.length, source });
      expect(decode(h.objects.get(indexKey(feed))!)).toEqual({ v: 1, feed, sha256: sha(bytes), key, lastCheckedAt: NOW });
      expect(h.reads.filter(k => k === key)).toHaveLength(2);
      expect(h.reads.filter(k => k === `${key}.manifest.json`)).toHaveLength(2);
      expect(h.writes.find(w => w.key === key)?.type).toBe('application/zip');
    }
    expect(h.requests.map(r => r.url)).toEqual([
      'https://pcsdata.njtransit.com/api/GTFSG2/authenticateUser', 'https://pcsdata.njtransit.com/api/GTFSG2/getGTFS',
      'https://raildata.njtransit.com/api/GTFSRT/getToken', 'https://raildata.njtransit.com/api/GTFSRT/getGTFS']);
    for (const { url, init } of h.requests) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', cache: 'no-store' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const body = init.body as FormData;
      expect([...body.keys()]).toEqual(/getToken|authenticateUser/.test(url) ? ['username', 'password'] : ['token']);
      if (/getToken|authenticateUser/.test(url)) expect(body.get('username')).toBe(credentials.NJT_API_USERNAME);
      else expect(body.get('token')).toBe(url.includes('raildata.') ? tokens.rail : tokens.bus);
    }
  });

  it('2: identical second run writes only lastCheckedAt in both indices', async () => {
    const h = harness(); await h.run();
    const before = new Map(h.objects); h.writes.length = 0; h.day();
    expect((await h.run()).feeds).toMatchObject({ [BUS]: { status: 'unchanged' }, [RAIL]: { status: 'unchanged' } });
    expect(h.writes.map(w => w.key)).toEqual([indexKey(BUS), indexKey(RAIL)]);
    for (const feed of [BUS, RAIL]) expect(decode(h.objects.get(indexKey(feed))!))
      .toEqual({ ...decode(before.get(indexKey(feed))!), lastCheckedAt: NOW + 86_400_000 });
    for (const [key, bytes] of before) if (!key.includes('static-index')) expect(h.objects.get(key)).toEqual(bytes);
  });

  it('3: changed bus bytes save a new bus version only, preserving the original', async () => {
    const h = harness(); await h.run(); const before = new Map(h.objects);
    h.writes.length = 0; h.day(); h.setBus(zip(3));
    expect((await h.run()).feeds).toMatchObject({ [BUS]: { status: 'saved' }, [RAIL]: { status: 'unchanged' } });
    expect(h.writes).toHaveLength(4); expect(h.objects.size).toBe(8);
    expect(h.writes.filter(w => w.key.endsWith('.zip')).map(w => w.bytes)).toEqual([zip(3)]);
    for (const [key, bytes] of before) if (!key.includes('static-index')) expect(h.objects.get(key)).toEqual(bytes);
  });

  it('4: rail 503 still saves bus and produces a nonzero exit with http-error', async () => {
    const h = harness(); h.railStatus(503); const result = await h.run();
    expect(result.exitCode).toBe(1);
    expect(result.feeds).toMatchObject({ [BUS]: { status: 'saved' }, [RAIL]: { status: 'failed', code: 'http-error' } });
    expect(h.writes).toHaveLength(3); expect(h.objects.has(indexKey(BUS))).toBe(true);
    expect(h.objects.has(indexKey(RAIL))).toBe(false);
  });

  it('5: HTTP-200 JSON error bodies are invalid-response and save nothing', async () => {
    const h = harness(); const error = json({ errorMessage: credentials.NJT_API_PASSWORD });
    h.setBus(error); h.setRail(error); const result = await h.run();
    expect(result.exitCode).toBe(1);
    for (const feed of [BUS, RAIL]) expect(result.feeds[feed].code).toBe('invalid-response');
    expect(h.writes).toHaveLength(0);
  });

  it('6: streamed bytes over the rail cap are refused even with a false Content-Length', async () => {
    const h = harness(); let cancelled = false;
    h.fetchImpl.mockImplementation(async (url: string) => {
      if ((url.endsWith('/getToken') || url.endsWith('/authenticateUser'))) return new Response(json({ Authenticated: true, UserToken: tokens.rail }));
      if (!url.includes('raildata.')) return new Response(zip().buffer);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 * 1024)); controller.enqueue(zip());
      }, cancel() { cancelled = true; } }), { headers: { 'Content-Length': '4' } });
    });
    const result = await h.run();
    expect(result.feeds[RAIL].code).toBe('response-too-large'); expect(result.exitCode).toBe(1);
    expect(cancelled).toBe(true); expect(h.objects.has(indexKey(RAIL))).toBe(false);
    expect(result.feeds[BUS].status).toBe('saved');
  });

  it.each(['.zip', '.manifest.json'])('7: readback mismatch in %s never updates the index', async suffix => {
    const h = harness(); await h.run();
    const priorBus = h.objects.get(indexKey(BUS))!.slice(), priorRail = h.objects.get(indexKey(RAIL))!.slice();
    h.writes.length = 0; h.day(); h.setBus(zip(8)); h.setRail(zip(9)); h.corrupt(suffix);
    const result = await h.run(); expect(result.exitCode).toBe(1);
    for (const feed of [BUS, RAIL]) expect(result.feeds[feed]).toMatchObject({ status: 'failed', code: 'readback-mismatch' });
    expect(h.objects.get(indexKey(BUS))).toEqual(priorBus); expect(h.objects.get(indexKey(RAIL))).toEqual(priorRail);
    expect(h.writes.some(w => w.key.includes('static-index'))).toBe(false);
  });

  it('8: no credentials or tokens enter saved bytes or log output, including thrown errors', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness(); const first = await h.run();
    h.day(); h.setBus(zip(3)); h.failPut(RAIL); h.setRail(zip(4)); const second = await h.run();
    const output = JSON.stringify([first, second, log.mock.calls, errorLog.mock.calls]);
    for (const secret of [...Object.values(credentials), ...Object.values(tokens)]) {
      expect(output).not.toContain(secret);
      for (const bytes of h.objects.values()) expect(new TextDecoder().decode(bytes)).not.toContain(secret);
    }
    expect(log).not.toHaveBeenCalled(); expect(errorLog).not.toHaveBeenCalled();
    expect(second.feeds[RAIL].code).toBe('upload-failed');
  });

  it.each([...Object.values(credentials), tokens.bus, encodeURIComponent(credentials.NJT_API_PASSWORD)])(
    'rejects a ZIP carrying a secret echo (%#)', async secret => {
      const h = harness(); h.setBus(new Uint8Array([...zip(), ...new TextEncoder().encode(secret)]));
      expect((await h.run()).feeds[BUS].code).toBe('invalid-response');
      expect(h.writes.some(w => w.key.includes(BUS))).toBe(false);
    });

  it.each([[401, 'access-denied'], [403, 'access-denied'], [429, 'rate-limited'], [302, 'invalid-response']])(
    'maps HTTP %s to the fixed code %s and continues rail', async (status, code) => {
      const h = harness(); h.busStatus(Number(status)); const result = await h.run();
      expect(result.feeds[BUS].code).toBe(code); expect(result.feeds[RAIL].status).toBe('saved');
    });

  it('reports missing credentials without fetching or writing', async () => {
    const h = harness(); const result = await archiveStaticGtfs({ credentials: {}, fetchImpl: h.fetchImpl, clock: () => NOW, bucket: h.bucket });
    expect(result.exitCode).toBe(1); expect(h.fetchImpl).not.toHaveBeenCalled(); expect(h.writes).toHaveLength(0);
    for (const feed of [BUS, RAIL]) expect(result.feeds[feed].code).toBe('configuration-missing');
  });

  it('times out a stalled response stream at 120 seconds and continues the other feed', async () => {
    vi.useFakeTimers(); const h = harness();
    h.fetchImpl.mockImplementation(async (url: string, init: RequestInit) => {
      if ((url.endsWith('/getToken') || url.endsWith('/authenticateUser'))) return new Response(json({ Authenticated: true, UserToken: tokens.bus }));
      if (url.includes('raildata.')) return new Response(zip(2).buffer);
      return new Response(new ReadableStream({ start(controller) {
        init.signal!.addEventListener('abort', () => controller.error(new Error(credentials.NJT_API_PASSWORD)));
      } }));
    });
    const pending = h.run(); await vi.advanceTimersByTimeAsync(120_000);
    const result = await pending; expect(result.feeds[BUS].code).toBe('timed-out');
    expect(result.feeds[RAIL].status).toBe('saved'); expect(result.exitCode).toBe(1);
  });

  it('reports network failure without leaking exception text', async () => {
    const h = harness(); h.fetchImpl.mockRejectedValue(new Error(tokens.bus));
    const result = await h.run(); expect(result.exitCode).toBe(1);
    for (const feed of [BUS, RAIL]) expect(result.feeds[feed].code).toBe('network-error');
    expect(JSON.stringify(result)).not.toContain(tokens.bus);
  });

  it('rejects malformed authentication, empty ZIPs and malformed indices', async () => {
    const h = harness(); h.fetchImpl.mockResolvedValue(new Response('not-json'));
    expect((await h.run()).feeds[BUS].code).toBe('invalid-response');
    const empty = harness(); empty.setBus(new Uint8Array());
    expect((await empty.run()).feeds[BUS].code).toBe('invalid-response');
    const badIndex = harness(); badIndex.objects.set(indexKey(BUS), json({ sha256: sha(zip()) }));
    expect((await badIndex.run()).feeds[BUS].code).toBe('invalid-response');
    expect(badIndex.writes.some(w => w.key.includes(BUS))).toBe(false);
  });

  it('does not turn index-read errors into a missing index or overwrite same-key originals', async () => {
    const h = harness(); h.failGet(BUS);
    expect((await h.run()).feeds[BUS].code).toBe('upload-failed');
    expect(h.writes.some(w => w.key.includes(BUS))).toBe(false);
    const collision = harness(), key = `raw/v1/2026-11-26/${BUS}/${NOW}-${sha(zip())}.zip`;
    collision.objects.set(key, zip(77));
    expect((await collision.run()).feeds[BUS].code).toBe('readback-mismatch');
    expect(collision.objects.get(key)).toEqual(zip(77)); expect(collision.objects.has(indexKey(BUS))).toBe(false);
  });

  it('recovers a partial manifest upload without rewriting an existing original', async () => {
    const h = harness(); h.failPut(`${BUS}/${NOW}-${sha(zip())}.zip.manifest`);
    expect((await h.run()).feeds[BUS].code).toBe('upload-failed');
    expect(h.objects.has(indexKey(BUS))).toBe(false);
    h.failPut(''); h.writes.length = 0;
    expect((await h.run()).feeds[BUS].status).toBe('saved');
    expect(h.writes.some(w => w.key.endsWith('.zip'))).toBe(false);
  });
});

describe('wrangler wiring and private temporary files', () => {
  it('uses remote put/get, config and exact bytes; distinguishes missing from other errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dale-static-test-')); directories.push(directory);
    let missing = false, denied = false; const commands: string[][] = [];
    const run = vi.fn(async (command: string, args: string[], options: { env: Record<string, string> }) => {
      expect(command).toBe('npx'); commands.push(args);
      const file = args[args.indexOf('--file') + 1]!;
      expect(dirname(file)).toBe(directory); expect(args[0]).toBe('--no-install');
      expect(args).toContain('--remote'); expect(args[args.indexOf('--config') + 1]).toMatch(/worker\/wrangler\.jsonc$/);
      expect(options.env.NJT_API_PASSWORD).toBe(''); expect(options.env.WRANGLER_SEND_METRICS).toBe('false');
      if (denied) throw Object.assign(new Error(tokens.bus), { code: 1, stderr: 'Forbidden' });
      if (missing) throw Object.assign(new Error(tokens.bus), { code: 1, stderr: 'The specified key does not exist.' });
      if (args.includes('put')) expect(new Uint8Array(await readFile(file))).toEqual(zip());
      else await writeFile(file, zip());
      return { stdout: tokens.bus, stderr: credentials.NJT_API_PASSWORD };
    });
    const bucket = createWranglerBucket({ directory, env: credentials, run });
    await bucket.put('raw/test.zip', zip(), 'application/zip'); expect(await bucket.get('raw/test.zip')).toEqual(zip());
    expect(commands[0]).toContain('dale-history/raw/test.zip'); expect(commands[0]).toContain('application/zip');
    missing = true; expect(await bucket.get('raw/missing')).toBeNull();
    denied = true; await expect(bucket.get('raw/denied')).rejects.toMatchObject({ code: 'upload-failed' });
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([false, true])('CLI logs only fixed diagnostics and removes all temporary files (failure=%s)', async failure => {
    const h = harness(), objects = new Map<string, Uint8Array>(), logs: string[] = [];
    const paths = new Set<string>();
    const runWrangler = async (_command: string, args: string[]) => {
      const file = args[args.indexOf('--file') + 1]!, key = args[5]!; paths.add(dirname(file));
      if (failure) throw Object.assign(new Error(credentials.NJT_API_PASSWORD), { code: 1, stderr: tokens.bus });
      if (args.includes('put')) objects.set(key, new Uint8Array(await readFile(file)));
      else {
        const bytes = objects.get(key);
        if (!bytes) throw Object.assign(new Error('synthetic missing'), { code: 1, stderr: 'The specified key does not exist.' });
        await writeFile(file, bytes);
      }
      return { stdout: tokens.bus, stderr: credentials.NJT_API_PASSWORD };
    };
    const exit = await runCli({ env: { ...credentials, CLOUDFLARE_API_TOKEN: 'synthetic-cf-token', CLOUDFLARE_ACCOUNT_ID: 'synthetic-cf-account' },
      fetchImpl: h.fetchImpl, clock: () => NOW, runWrangler, log: (line: string) => logs.push(line) });
    expect(exit).toBe(failure ? 1 : 0); expect(paths.size).toBe(1);
    for (const path of paths) await expect(access(path)).rejects.toThrow();
    for (const secret of [...Object.values(credentials), ...Object.values(tokens), 'synthetic-cf-token', 'synthetic-cf-account']) {
      expect(logs.join('')).not.toContain(secret);
    }
    expect(JSON.parse(logs[0]!).exitCode).toBe(exit);
    expect(objects.size).toBe(failure ? 0 : 6 + 3 * PUBLIC_FEEDS.length);
  });

  it('CLI reports missing Cloudflare configuration for both feeds without I/O', async () => {
    const h = harness(), logs: string[] = [], runWrangler = vi.fn();
    expect(await runCli({ env: credentials, fetchImpl: h.fetchImpl, runWrangler, log: (line: string) => logs.push(line) })).toBe(1);
    expect(runWrangler).not.toHaveBeenCalled(); expect(h.fetchImpl).not.toHaveBeenCalled();
    for (const result of Object.values(JSON.parse(logs[0]!).feeds)) expect(result).toMatchObject({ code: 'configuration-missing' });
  });

  it('workflow pins existing action SHAs, daily UTC schedule, serialized main-only runs and secret scope', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/static-archive.yml', import.meta.url), 'utf8');
    const existing = await readFile(new URL('../../.github/workflows/live-worker.yml', import.meta.url), 'utf8');
    for (const line of workflow.split('\n').filter(line => line.includes('uses:'))) expect(existing).toContain(line.trim());
    expect(workflow).toContain("cron: '17 9 * * *'"); expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('contents: read'); expect(workflow).toContain('group: dale-static-gtfs-archive');
    expect(workflow).toContain('cancel-in-progress: false'); expect(workflow).toContain('node-version: 22');
    expect(workflow).toContain('run: npm ci'); expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain("github.ref == 'refs/heads/main' && github.repository == 'jwchr/dale'");
    for (const name of ['NJT_API_USERNAME', 'NJT_API_PASSWORD', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'])
      expect(workflow).toContain(`${name}: \u0024{{ secrets.${name} }}`);
    expect(workflow).not.toContain('upload-artifact');
  });
});

describe('daily private archive of the public partner and NJ Transit schedule ZIPs', () => {
  type Feed = { feed: string; url: string; max: number; source: string };
  const two: Feed[] = [
    { feed: 'static-partner-a', url: 'https://www.njtransit.com/A_bus_data.zip', max: 64, source: 'synthetic A' },
    { feed: 'static-partner-b', url: 'https://api.prod.coachusa.com/gtfs', max: 64, source: 'synthetic B' },
  ];
  function open(answer: (url: string) => Response | Promise<Response>, feeds = two, timeoutMs = 1_000) {
    const objects = new Map<string, Uint8Array>(), writes: string[] = [], requests: { url: string; init: RequestInit }[] = [];
    let at = NOW;
    const bucket = {
      async get(key: string) { return objects.get(key)?.slice() ?? null; },
      async put(key: string, bytes: Uint8Array) { writes.push(key); objects.set(key, bytes.slice()); },
    };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => { requests.push({ url, init }); return answer(url); });
    return { objects, writes, requests, day: () => { at += 86_400_000; },
      run: () => archivePublicGtfs({ credentials, fetchImpl, clock: () => at, bucket, feeds, timeoutMs }) };
  }
  const moved = (location: string, status = 301) => new Response(null, { status, headers: { location } });
  const cdn = (url: string) => url.replace('https://www.njtransit.com/', 'https://content.njtransit.com/sites/default/files/developers-resources/');

  it('lists every ZIP the developer portal names, each on HTTPS at a known host, under its own feed', () => {
    expect(PUBLIC_FEEDS).toHaveLength(18);
    const feeds = PUBLIC_FEEDS as Feed[];
    expect(new Set(feeds.map(f => f.feed)).size).toBe(18); expect(new Set(feeds.map(f => f.url)).size).toBe(18);
    for (const { feed, url } of feeds) {
      expect(feed).toMatch(/^static-(partner|njt-public)-[a-z-]+$/);
      expect(new URL(url).protocol).toBe('https:');
      expect(['www.njtransit.com', 'api.prod.coachusa.com', 'seastreak.com']).toContain(new URL(url).hostname);
    }
    expect(feeds.map(f => f.url)).toEqual(expect.arrayContaining(['https://www.njtransit.com/LakelandBusLines_bus_data.zip',
      'https://www.njtransit.com/bus_data.zip', 'https://www.njtransit.com/rail_data.zip', 'https://api.prod.coachusa.com/gtfs',
      'https://seastreak.com/api/transit/google_transit.zip']));
  });

  it('follows NJ Transit\'s redirect, saves each exact ZIP with manifest and index, and on an unchanged day only refreshes the index', async () => {
    const h = open(url => url.startsWith('https://www.njtransit.com/') ? moved(cdn(url)) : new Response(zip(url.includes('coachusa') ? 3 : 4).slice().buffer));
    const result = await h.run();
    expect(result).toEqual({ exitCode: 0, feeds: { 'static-partner-a': { status: 'saved', receivedAt: NOW }, 'static-partner-b': { status: 'saved', receivedAt: NOW } } });
    const key = `raw/v1/2026-11-26/static-partner-a/${NOW}-${sha(zip(4))}.zip`;
    expect(h.objects.get(key)).toEqual(zip(4));
    expect(decode(h.objects.get(`${key}.manifest.json`)!)).toEqual({ v: 1, feed: 'static-partner-a', receivedAt: NOW, sha256: sha(zip(4)), bytes: zip(4).length, source: 'synthetic A' });
    expect(decode(h.objects.get(indexKey('static-partner-a'))!)).toEqual({ v: 1, feed: 'static-partner-a', sha256: sha(zip(4)), key, lastCheckedAt: NOW });
    expect(h.requests.map(r => r.url)).toEqual([two[0]!.url, cdn(two[0]!.url), two[1]!.url]);
    for (const { init } of h.requests) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', cache: 'no-store' });
      expect((init.headers as Record<string, string>)['user-agent']).toMatch(/^Dale transit app/);
      expect(init.body).toBeUndefined();
    }
    h.writes.length = 0; h.day();
    expect((await h.run()).feeds['static-partner-a']).toEqual({ status: 'unchanged', receivedAt: NOW + 86_400_000 });
    expect(h.writes).toEqual([indexKey('static-partner-a'), indexKey('static-partner-b')]);
  });

  it.each([
    ['a redirect to another host', () => moved('https://example.invalid/a.zip'), 'redirect-refused'],
    ['a redirect off HTTPS', () => moved('http://content.njtransit.com/a.zip', 302), 'redirect-refused'],
    ['a redirect with no location', () => new Response(null, { status: 302 }), 'redirect-refused'],
    ['an endless redirect loop', () => moved('https://www.njtransit.com/A_bus_data.zip'), 'redirect-refused'],
    ['an HTML error page', () => new Response('<!DOCTYPE html><html>Page not found</html>'), 'invalid-response'],
    ['a missing file', () => new Response('', { status: 404 }), 'http-error'],
    ['rate limiting', () => new Response('', { status: 429 }), 'rate-limited'],
    ['a file over its cap', () => new Response(new Uint8Array(65).fill(0x50).buffer), 'response-too-large'],
    ['a network failure', () => { throw new TypeError('offline'); }, 'network-error'],
    ['a hung answer', () => new Promise<Response>(() => {}), 'timed-out'],
    ['a body that stalls', () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0x50])); } })), 'timed-out'],
  ])('refuses %s with a fixed code, saves nothing for it, and still saves the next', async (_, bad, code) => {
    const h = open(url => url.includes('A_bus') ? bad() : new Response(zip(5).slice().buffer), two, 30);
    const result = await h.run();
    expect(result.exitCode).toBe(1);
    expect(result.feeds['static-partner-a']).toMatchObject({ status: 'failed', code, operation: 'download' });
    expect(result.feeds['static-partner-b']).toEqual({ status: 'saved', receivedAt: NOW });
    expect([...h.objects.keys()].some(k => k.includes('static-partner-a'))).toBe(false);
  });

  it('gives up after 3 redirects', async () => {
    const h = open(url => url.includes('A_bus') ? moved('https://content.njtransit.com/A_bus_data.zip') : new Response(zip(8).slice().buffer));
    h.requests.length = 0;
    expect((await h.run()).feeds['static-partner-a']).toMatchObject({ code: 'redirect-refused' });
    expect(h.requests.filter(r => r.url.includes('A_bus'))).toHaveLength(4);
  });

  it('never saves an answer that carries an NJ Transit credential', async () => {
    const leaked = new Uint8Array([0x50, 0x4b, 3, 4, ...new TextEncoder().encode(credentials.NJT_API_PASSWORD)]);
    const h = open(url => new Response((url.includes('A_bus') ? leaked : zip(6)).slice().buffer));
    expect((await h.run()).feeds['static-partner-a']).toMatchObject({ status: 'failed', code: 'invalid-response' });
    expect([...h.objects.keys()].some(k => k.includes('static-partner-a'))).toBe(false);
  });

  it('needs no NJ Transit account: it runs and saves with no credentials at all', async () => {
    const result = await archivePublicGtfs({ credentials: {}, fetchImpl: vi.fn(async () => new Response(zip(7).slice().buffer)),
      clock: () => NOW, bucket: { get: async () => null, put: async () => {} }, feeds: two });
    expect(result.exitCode).toBe(1); // readback of a bucket that keeps nothing fails, proving it got that far
    expect(Object.values(result.feeds).every(f => (f as { operation: string }).operation === 'readback')).toBe(true);
  });
});
