import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain ESM operational script without type declarations
import { checkRailApi, runRailConnectionCheck } from '../../scripts/check-rail-api.mjs';
// @ts-expect-error plain ESM operational script without type declarations
import { runConnectionCheck } from '../../scripts/check-bus-api.mjs';

const credentials = { username: 'synthetic-rail-user', password: 'synthetic-rail-password' };
const token = 'synthetic-rail-token-never-log';
const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'jwchr/dale',
  NJT_API_CHECK_SCOPE: 'rail', NJT_RAIL_TOKEN_WINDOW_CONFIRMED: 'true', NJT_API_USERNAME: credentials.username, NJT_API_PASSWORD: credentials.password };
const stations = [
  ['AS', 'Anderson Street'], ['EX', 'Essex Street'], ['TS', 'Secaucus Lower Lvl'],
  ['SE', 'Secaucus Upper Lvl'], ['NY', 'New York Penn Station'],
];
const listed = () => stations.map(([STATION_2CHAR, STATIONNAME]) => ({ STATION_2CHAR, STATIONNAME }));
const json = (value: unknown) => new Response(JSON.stringify(value));
const row = { TRAIN_ID: 'synthetic-train', SCHED_DEP_DATE: 'unqualified local clock', LAST_MODIFIED: 'unqualified local clock', GPSTIME: 'unqualified local clock', LINECODE: 'PV' };
function fixture() {
  return vi.fn(async (url: string, init: RequestInit) => {
    const fields = init.body as FormData;
    if (url.endsWith('/getToken')) return json({ Authenticated: 'True', UserToken: token });
    if (url.endsWith('/getStationList')) return json(listed());
    const [code, name] = stations.find(([code]) => code === fields.get('station'))!;
    return json({ STATION_2CHAR: code, STATIONNAME: name, ITEMS: [row] });
  });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded reviewed-main rail verification', () => {
  it('uses exactly two auth requests and six bounded station requests, only at the documented host', async () => {
    const fetchImpl = fixture(); const output: string[] = [];
    expect(await runConnectionCheck(env, fetchImpl, (s: string) => output.push(s))).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    const calls = fetchImpl.mock.calls;
    expect(calls.slice(0, 2).map(([url]) => url)).toEqual([
      'https://raildata.njtransit.com/api/TrainData/getToken', 'https://raildata.njtransit.com/api/GTFSRT/getToken',
    ]);
    expect(calls.slice(3).map(([, init]) => (init.body as FormData).get('station'))).toEqual(['AS', 'EX', 'TS', 'SE', 'NY']);
    expect(calls.slice(3).map(([, init]) => (init.body as FormData).get('line'))).toEqual(['PV', 'PV', 'PV', '', '']);
    for (const [url, init] of calls) {
      expect(new URL(url).origin).toBe('https://raildata.njtransit.com');
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' } });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect([...((init.body as FormData).keys())]).toEqual(url.endsWith('/getToken') ? ['username', 'password'] : url.endsWith('/getStationList') ? ['token'] : ['token', 'station', 'line']);
    }
    const result = JSON.parse(output[0]!);
    expect(result.stations['secaucus-lower']).toMatchObject({ status: 'schema-confirmed', rows: 1, pvlRows: 1, sourceTime: 'timezone-and-freshness-unverified' });
    expect(result.gtfsFeed).toBe('not-requested-coverage-unknown');
    expect(result.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const secret of [...Object.values(credentials), token, row.TRAIN_ID, row.GPSTIME]) expect(output.join('\n')).not.toContain(secret);
  });

  it.each([
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_REPOSITORY: 'other/repo' }, { NJT_API_CHECK_SCOPE: 'bus' }, { NJT_RAIL_TOKEN_WINDOW_CONFIRMED: 'false' },
    { NJT_RAIL_TOKEN_WINDOW_CONFIRMED: undefined },
  ])('refuses any rail request without all dispatch gates: %j', async patch => {
    const fetchImpl = fixture(); expect(await runRailConnectionCheck({ ...env, ...patch }, fetchImpl, vi.fn())).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('preserves the bus default and rejects an unknown scope without requests', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => json({ Authenticated: 'True', UserToken: token }));
    expect(await runConnectionCheck({ ...env, NJT_API_CHECK_SCOPE: undefined }, fetchImpl, vi.fn())).toBe(0);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://pcsdata.njtransit.com/api/BUSDV2/authenticateUser', 'https://pcsdata.njtransit.com/api/GTFSG2/authenticateUser',
    ]);
    fetchImpl.mockClear();
    expect(await runConnectionCheck({ ...env, NJT_API_CHECK_SCOPE: 'guessed-product' }, fetchImpl, vi.fn())).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([undefined, {}, { username: 'u', password: '' }, { username: ' ', password: 'p' }])('does not request with missing credentials: %j', async creds => {
    const fetchImpl = fixture(); expect(await checkRailApi(creds, fetchImpl)).toEqual({ status: 'configuration-missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([false, 'False', ' false '])('never treats denial as truthy or uses an accompanying token: %j', async flag => {
    const fetchImpl = vi.fn(async () => json({ Authenticated: flag, UserToken: token }));
    const result = await checkRailApi(credentials, fetchImpl);
    expect(result.products).toEqual({ TrainData: 'access-denied', GTFSRT: 'access-denied' });
    expect(result.stationCoverage).toBe('not-requested-authentication-unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(JSON.stringify(result)).not.toContain(token);
  });
  it.each([null, [], {}, { UserToken: token }, { Authenticated: 'True', UserToken: '' }, { Authenticated: 'True', UserToken: 5 }])('requires the documented success schema: %j', async value => {
    const fetchImpl = vi.fn(async () => json(value)); const result = await checkRailApi(credentials, fetchImpl);
    expect(result.products).toEqual({ TrainData: 'unexpected-response', GTFSRT: 'unexpected-response' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each([429, 'body-quota'])('halts immediately on quota evidence, without another token or feed: %s', async status => {
    const fetchImpl = vi.fn(async () => status === 429 ? new Response('secret', { status: 429 }) : json({ errorMessage: 'Daily usage limit:10. secret' }));
    expect((await checkRailApi(credentials, fetchImpl)).status).toBe('rate-limited'); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('halts station queries on rate limit without retrying or fetching later stations', async () => {
    const normal = fixture(); const fetchImpl = vi.fn(async (url: string, init: RequestInit) => url.endsWith('19Rec') ? new Response('secret', { status: 429 }) : normal(url, init));
    expect((await checkRailApi(credentials, fetchImpl)).status).toBe('rate-limited'); expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it.each([401, 403, 500, 302])('sanitizes HTTP errors and refuses redirects %s', async status => {
    const fetchImpl = vi.fn(async () => new Response(credentials.password + token, { status })); const output: string[] = [];
    expect(await runRailConnectionCheck(env, fetchImpl, (s: string) => output.push(s))).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(output.join('\n')).not.toContain(token); expect(output.join('\n')).not.toContain(credentials.password);
  });
  it('reports duplicate/mismatched/absent station identities without querying guessed codes', async () => {
    const normal = fixture(); const fetchImpl = vi.fn(async (url: string, init: RequestInit) => url.endsWith('getStationList')
      ? json([{ STATION_2CHAR: 'AS', STATIONNAME: 'WRONG' }, ...listed().filter(s => s.STATION_2CHAR !== 'AS' && s.STATION_2CHAR !== 'EX'), listed()[2]]) : normal(url, init));
    const result = await checkRailApi(credentials, fetchImpl);
    expect(result.stations.anderson.status).toBe('station-identity-unconfirmed'); expect(result.stations.essex.status).toBe('station-not-listed');
    expect(result.stations['secaucus-lower'].status).toBe('station-identity-unconfirmed'); expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
  it('keeps empty-at-check distinct from actual observed departures', async () => {
    const normal = fixture(); const fetchImpl = vi.fn(async (url: string, init: RequestInit) => url.endsWith('19Rec')
      ? json({ STATION_2CHAR: (init.body as FormData).get('station'), STATIONNAME: stations.find(([code]) => code === (init.body as FormData).get('station'))![1], ITEMS: [] }) : normal(url, init));
    const result = await checkRailApi(credentials, fetchImpl); expect(result.stations.anderson).toMatchObject({ status: 'empty-at-check', rows: 0, gpsTimeFields: 0 });
  });
  it.each([{}, { STATION_2CHAR: 'AS', STATIONNAME: 'Anderson Street', ITEMS: [{}] }, { STATION_2CHAR: 'AS', STATIONNAME: 'Anderson Street', ITEMS: Array(20).fill(row) }])('does not qualify malformed/mismatched station schema: %j', async value => {
    const normal = fixture(); const fetchImpl = vi.fn(async (url: string, init: RequestInit) => url.endsWith('19Rec') ? json(value) : normal(url, init));
    expect((await checkRailApi(credentials, fetchImpl)).stations.anderson.status).toBe('unexpected-schema');
  });
  it('bounds malformed/oversized authentication and station bodies without logging echoes', async () => {
    for (const body of [credentials.password + token, JSON.stringify({ Authenticated: 'True', UserToken: 'x'.repeat(17000) })]) {
      const fetchImpl = vi.fn(async () => new Response(body)); const result = await checkRailApi(credentials, fetchImpl);
      expect(['unexpected-response', 'response-too-large']).toContain(result.products.TrainData); expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain(credentials.password);
    }
    const normal = fixture(); const fetchImpl = vi.fn(async (url: string, init: RequestInit) => url.endsWith('getStationList') ? new Response('x'.repeat(262145)) : normal(url, init));
    expect((await checkRailApi(credentials, fetchImpl)).stationCoverage).toBe('response-too-large'); expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('bounds station sample bodies and rejects non-array station lists before querying stops', async () => {
    for (const oversized of [false, true]) {
      const normal = fixture();
      const fetchImpl = vi.fn(async (url: string, init: RequestInit) => oversized && url.endsWith('19Rec')
        ? new Response('x'.repeat(524289)) : !oversized && url.endsWith('getStationList') ? json({ ITEMS: listed() }) : normal(url, init));
      const result = await checkRailApi(credentials, fetchImpl);
      if (oversized) { expect(result.stations.anderson.status).toBe('response-too-large'); expect(fetchImpl).toHaveBeenCalledTimes(8); }
      else { expect(result.stationCoverage).toBe('unexpected-schema'); expect(fetchImpl).toHaveBeenCalledTimes(3); }
    }
  });
  it('never logs thrown network errors containing credentials or tokens', async () => {
    const output: string[] = []; const fetchImpl = vi.fn(async () => { throw new Error(Object.values(credentials).join(' ') + token); });
    expect(await runRailConnectionCheck(env, fetchImpl, (s: string) => output.push(s))).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const secret of [...Object.values(credentials), token]) expect(output.join('\n')).not.toContain(secret);
    expect(output.join('\n')).toContain('network-error');
  });
  it('bounds stalled HTTP requests and stalled successful bodies, sanitizing thrown secrets', async () => {
    vi.useFakeTimers();
    for (const bodyStall of [false, true]) {
      const fetchImpl = vi.fn((_url: string, init: RequestInit) => bodyStall ? Promise.resolve(new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode('{"Authenticated":')); init.signal!.addEventListener('abort', () => c.error(new Error(token)), { once: true });
      } }))) : new Promise((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(new Error(token)), { once: true }); }));
      const pending = checkRailApi(credentials, fetchImpl); await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending; expect(result.products).toEqual({ TrainData: 'timed-out', GTFSRT: 'timed-out' });
      expect(fetchImpl).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0); expect(JSON.stringify(result)).not.toContain(token);
    }
  });
  it('keeps the secret workflow pinned, manual, main-only, no installs/artifacts/collection', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/bus-api-check.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('options: [bus, rail]'); expect(workflow).toContain('default: bus'); expect(workflow).toContain('default: false');
    expect(workflow).toContain("github.ref == 'refs/heads/main'"); expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('contents: read'); expect(workflow).toContain('persist-credentials: false'); expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).toContain('NJT_API_PASSWORD: ${{ secrets.NJT_API_PASSWORD }}');
    expect(workflow).not.toMatch(/pull_request:|push:|schedule:|upload-artifact|npm (ci|run build)|VITE_|secrets.GITHUB_TOKEN/);
    for (const action of workflow.matchAll(/uses: ([^\n]+)/g)) expect(action[1]).toMatch(/@[a-f0-9]{40} /);
  });
});
