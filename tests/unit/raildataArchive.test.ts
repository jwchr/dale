import { describe, expect, it, vi } from 'vitest';
import { RailBoards, RAIL_STATIONS, type RailStorage } from '../../worker/rail';
import { RailDataArchive, RAILDATA_REQUEST_LIMIT, newRailDataState, stationCodes } from '../../worker/raildata-archive';
import { NJT_REQUEST_LIMIT } from '../../worker/request-budget';
import { NOW } from '../helpers/liveBus';

const STATIONS = Array.from({ length: 160 }, (_, n) => String.fromCharCode(65 + Math.floor(n / 26), 65 + (n % 26)));
const SECRET = 'synthetic-rail-token';

function harness() {
  let now = NOW, state = newRailDataState(), saved = structuredClone(state);
  const store = new Map<string, unknown>(), calls: { method: string; fields: Record<string, string> }[] = [];
  const answers: Record<string, () => Response | Promise<Response>> = {};
  const storage: RailStorage = { get: async <T,>(key: string) => structuredClone(store.get(key)) as T | undefined, put: async (key, value) => { store.set(key, structuredClone(value)); } };
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url).replace('https://raildata.njtransit.com/api/TrainData/', '');
    expect(init?.redirect).toBe('manual');
    const fields = Object.fromEntries((init!.body as FormData).entries()) as Record<string, string>;
    calls.push({ method, fields });
    if (method === 'getToken') return answers.getToken ? answers.getToken() : Response.json({ Authenticated: 'True', UserToken: SECRET });
    expect(fields.token).toBe(SECRET);
    if (answers[method]) {
      const signal = init?.signal;
      // Like real fetch, a call ends when its signal aborts.
      return Promise.race([answers[method]!(), new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))]);
    }
    if (method === 'getStationList') return Response.json(STATIONS.map(code => ({ STATION_2CHAR: code, STATIONNAME: 'Station ' + code })));
    if (method === 'getTrainSchedule') return Response.json({ STATION_2CHAR: fields.station, ITEMS: [] });
    return Response.json({ method });
  }) as typeof fetch;
  const rail = new RailBoards(storage, { NJT_API_USERNAME: 'synthetic-user', NJT_API_PASSWORD: 'synthetic-password' }, fetchImpl, () => now);
  return { calls, answers, get state() { return state; }, time: (at: number) => { now = at; }, restart: () => { state = structuredClone(saved); },
    async run() {
      const archive = new RailDataArchive(state, rail, () => now);
      const plan = archive.prepare(now);
      saved = structuredClone(state); // Same pre-I/O checkpoint as service.ts.
      if (typeof plan !== 'object') return plan;
      const result = await archive.collect(plan); saved = structuredClone(state); return result;
    } };
}
const bundle = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

describe('RailData raw archive (D84)', () => {
  it('over a day of 42-second polls saves positions every poll, every station board within 15 minutes, messages hourly and the daily answers once, inside its request share', async () => {
    const h = harness(), boardAt = new Map<string, number[]>();
    let bundles = 0, list = 0, schedule = 0;
    for (let i = 0; i * 42_000 < 86_400_000; i++) {
      const at = NOW + i * 42_000; h.time(at);
      if (i % 300 === 0) h.restart();
      const result = await h.run();
      if (typeof result !== 'object') throw new Error('poll refused: ' + result);
      expect(result.failures).toEqual([]);
      for (const response of result.responses) {
        if (response.feed === 'raildata-getStationList') list++;
        if (response.feed === 'raildata-getStationSchedule') schedule++;
        if (response.feed !== 'raildata-poll') continue;
        bundles++;
        for (const entry of bundle(response.bytes).responses) if (entry.method === 'getTrainSchedule') (boardAt.get(entry.station) ?? boardAt.set(entry.station, []).get(entry.station)!).push(at);
      }
    }
    const count = (method: string) => h.calls.filter(c => c.method === method).length;
    expect(count('getToken')).toBe(2); // Renewed once, after 23 hours.
    expect(count('getVehicleData')).toBe(bundles);
    expect(count('getStationMSG')).toBe(24);
    expect([list, schedule, count('getStationList'), count('getStationSchedule')]).toEqual([1, 1, 1, 1]);
    expect(h.calls.length).toBeLessThanOrEqual(RAILDATA_REQUEST_LIMIT);
    expect(RAILDATA_REQUEST_LIMIT).toBeLessThan(NJT_REQUEST_LIMIT);
    expect([...boardAt.keys()].sort()).toEqual(STATIONS);
    for (const times of boardAt.values()) for (let n = 1; n < times.length; n++) expect(times[n]! - times[n - 1]!).toBeLessThanOrEqual(15 * 60_000 + 42_000);
    expect(h.calls.find(c => c.method === 'getStationSchedule')!.fields).toEqual({ token: SECRET, station: '', NJTOnly: 'false' });
    expect(h.calls.find(c => c.method === 'getStationMSG')!.fields).toEqual({ token: SECRET, station: '', line: '' });
  });

  it('keeps every body exactly, never puts the token in a bundle, and returns it as a secret to refuse', async () => {
    const h = harness(), odd = new Uint8Array([0x7b, 0xff, 0x00]);
    h.answers.getVehicleData = () => new Response('{"A":"café \\u00e9"}');
    h.answers.getStationMSG = () => new Response(odd);
    const result = await h.run();
    if (typeof result !== 'object') throw new Error('refused');
    expect(result.secrets).toEqual([SECRET]);
    const poll = result.responses.find(r => r.feed === 'raildata-poll')!;
    expect(new TextDecoder().decode(poll.bytes)).not.toContain(SECRET);
    const entries = bundle(poll.bytes).responses;
    expect(entries.find((e: { method: string }) => e.method === 'getVehicleData').text).toBe('{"A":"café \\u00e9"}');
    expect(new Uint8Array(Buffer.from(entries.find((e: { method: string }) => e.method === 'getStationMSG').base64, 'base64'))).toEqual(odd);
    // The first poll starts on the Train screen's stations (spread over 15 minutes) until the full list arrives.
    expect(entries.filter((e: { method: string }) => e.method === 'getTrainSchedule').map((e: { station: string }) => e.station)).toEqual([Object.keys(RAIL_STATIONS)[0]]);
    expect(h.state.stations).toEqual(STATIONS);
  });

  it('records a failed board inside the bundle and as a failure, while the rest of the poll is still saved', async () => {
    const h = harness();
    h.answers.getTrainSchedule = () => new Response('', { status: 503 });
    const result = await h.run();
    if (typeof result !== 'object') throw new Error('refused');
    expect(result.failures.map(f => [f.feed, f.code])).toContainEqual(['raildata-getTrainSchedule', 'http-error']);
    const entries = bundle(result.responses.find(r => r.feed === 'raildata-poll')!.bytes).responses;
    expect(entries.filter((e: { status: string }) => e.status === 'http-error').length).toBe(1);
    expect(entries.some((e: { method: string; status: string }) => e.method === 'getVehicleData' && e.status === 'ok')).toBe(true);
  });

  it('never archives NJ Transit error bodies: an invalid token drops it, a daily limit pauses every RailData call', async () => {
    const h = harness();
    h.answers.getVehicleData = () => Response.json({ errorMessage: 'Invalid token.' });
    let result = await h.run();
    if (typeof result !== 'object') throw new Error('refused');
    expect(result.failures).toContainEqual(expect.objectContaining({ feed: 'raildata-getVehicleData', code: 'access-denied' }));
    expect(new TextDecoder().decode(result.responses.find(r => r.feed === 'raildata-poll')!.bytes)).not.toContain('Invalid token');
    delete h.answers.getVehicleData;
    h.answers.getTrainSchedule = () => Response.json({ errorMessage: 'Daily usage limit:40000.' });
    h.time(NOW + 2 * 3600_000); result = await h.run();
    if (typeof result !== 'object') throw new Error('refused');
    expect(result.failures.map(f => f.code)).toContain('rate-limited');
    const before = h.calls.length;
    h.time(NOW + 2 * 3600_000 + 60_000); result = await h.run();
    if (typeof result !== 'object') throw new Error('refused');
    expect(h.calls.length).toBe(before);
    expect(result.failures.every(f => f.code === 'rate-limited')).toBe(true);
    expect(result.responses).toEqual([]);
  });

  it('refuses a board larger than its limit instead of saving part of it', async () => {
    const h = harness();
    h.answers.getTrainSchedule = () => new Response(new Uint8Array(2 * 1024 * 1024 + 1));
    const result = await h.run();
    if (typeof result !== 'object') throw new Error('refused');
    expect(result.failures.map(f => [f.feed, f.code])).toEqual([['raildata-getTrainSchedule', 'response-too-large']]);
  });

  it('stops at its own daily request share and says so', async () => {
    const h = harness();
    h.state.budget.hours[Math.floor(NOW / 3600_000)] = RAILDATA_REQUEST_LIMIT - 2;
    expect(await h.run()).toBe('request-ceiling');
    expect(h.calls).toEqual([]);
  });

  it('reads station codes only from a sensible station list', () => {
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    expect(stationCodes(enc(STATIONS.map(c => ({ STATION_2CHAR: c }))))).toEqual(STATIONS);
    expect(stationCodes(enc([{ STATION_2CHAR: 'NY' }]))).toBeUndefined();
    expect(stationCodes(enc({ errorMessage: 'x' }))).toBeUndefined();
    expect(stationCodes(new Uint8Array([1, 2]))).toBeUndefined();
  });

  // Neon review of #303, Nov 26, 2026.
  it.each([{ status: 500, message: 'Invalid token.', code: 'access-denied' }, { status: 400, message: 'Daily usage limit:40000.', code: 'rate-limited' }])(
    'reads an error body before its HTTP status: a $status saying "$message" counts as $code', async ({ status, message, code }) => {
      const h = harness();
      h.answers.getVehicleData = () => Response.json({ errorMessage: message }, { status });
      const result = await h.run();
      if (typeof result !== 'object') throw new Error('refused');
      expect(result.failures).toContainEqual(expect.objectContaining({ feed: 'raildata-getVehicleData', code }));
      delete h.answers.getVehicleData;
      h.time(NOW + 2 * 3600_000); await h.run();
      const mints = h.calls.filter(c => c.method === 'getToken').length;
      // A dropped token is minted again on the next poll; a daily limit sends nothing for the pause.
      expect(mints).toBe(code === 'access-denied' ? 2 : 1);
    });

  it.each([['an HTML page', () => new Response('<html>Maintenance</html>')], ['an empty answer', () => new Response('')], ['a plain-text error', () => new Response('Service Unavailable')], ['an answer holding the token', () => Response.json({ echo: 'synthetic-rail-token' })]])('never saves %s as RailData', async (_, page) => {
    const h = harness();
    h.answers.getStationList = page;
    const result = await h.run();
    if (typeof result !== 'object') throw new Error('refused');
    expect(result.failures).toContainEqual(expect.objectContaining({ feed: 'raildata-getStationList', code: 'invalid-response' }));
    expect(result.responses.some(r => r.feed === 'raildata-getStationList')).toBe(false);
  });

  it('counts a slow token request against the 20-second turn, so the live bus poll is never held (Neon Nov26 g)', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.answers.getToken = () => new Promise<Response>(resolve => setTimeout(() => { h.time(NOW + 11_000); resolve(Response.json({ Authenticated: 'True', UserToken: SECRET })); }, 11_000));
      h.answers.getVehicleData = () => new Promise<Response>(() => {});
      const pending = h.run();
      let done = false; void pending.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(19_999); expect(done).toBe(false);
      h.time(NOW + 20_000);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      const result = await pending;
      if (typeof result !== 'object') throw new Error('refused');
      expect(result.failures.some(f => f.code === 'timed-out')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('starts nothing 12 seconds into its turn, so a slow NJ Transit cannot hold the live bus poll', async () => {
    const h = harness();
    h.answers.getVehicleData = () => { h.time(NOW + 12_000); return Response.json({ synthetic: true }); };
    const result = await h.run();
    if (typeof result !== 'object') throw new Error('refused');
    expect(h.calls.filter(c => c.method !== 'getToken')).toHaveLength(2);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.every(f => f.code === 'timed-out')).toBe(true);
    expect(result.responses.some(r => r.feed === 'raildata-poll')).toBe(true);
  });
});
