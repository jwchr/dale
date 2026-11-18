import { describe, expect, it } from 'vitest';
import { normalizeRailBoard, parseRailTime, railText, RailBoards, RAIL_BOARD_MS, RAIL_MINTS_PER_DAY } from '../../worker/rail';
import { createRouter } from '../../worker/service';
import { parseDataset } from '../../src/domain/dataset';
import raw from '../../public/data/corridor.json';

// Synthetic rows only: shaped like the production RailData schema, no recorded agency responses.
const row = (over: Record<string, unknown> = {}) => ({
  SCHED_DEP_DATE: '18-Nov-2026 09:15:00 PM', DESTINATION: 'Hoboken', TRACK: ' ', LINE: 'Pascack Valley Line', TRAIN_ID: '1620',
  STATUS: ' ', SEC_LATE: '120', LAST_MODIFIED: '18-Nov-2026 09:10:30 PM', LINECODE: 'PV', GPSLATITUDE: '40.9', GPSLONGITUDE: '-74.0',
  CAPACITY: [{ VEHICLE_NO: '1' }], STOPS: null, ...over,
});
const board = (items: unknown, code = 'EX', name = 'Essex Street') => ({ STATION_2CHAR: code, STATIONNAME: name, STATIONMSGS: [], ITEMS: items });

describe('parseRailTime', () => {
  it('reads New York wall time, before and after the clock change', () => {
    expect(new Date(parseRailTime('18-Nov-2026 09:15:00 PM')!).toISOString()).toBe('2026-11-19T02:15:00.000Z');
    expect(new Date(parseRailTime('01-Jul-2026 12:05:09 AM')!).toISOString()).toBe('2026-07-01T04:05:09.000Z');
    expect(new Date(parseRailTime('01-Jul-2026 12:00:00 PM')!).toISOString()).toBe('2026-07-01T16:00:00.000Z');
  });
  it('never guesses a time skipped in spring or repeated in fall', () => {
    expect(parseRailTime('08-Mar-2026 02:30:00 AM')).toBeUndefined();
    expect(parseRailTime('01-Nov-2026 01:30:00 AM')).toBeUndefined();
    expect(new Date(parseRailTime('01-Nov-2026 12:30:00 AM')!).toISOString()).toBe('2026-11-01T04:30:00.000Z');
    expect(new Date(parseRailTime('01-Nov-2026 02:30:00 AM')!).toISOString()).toBe('2026-11-01T07:30:00.000Z');
    expect(new Date(parseRailTime('08-Mar-2026 03:30:00 AM')!).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
  it('rejects anything that is not exactly the documented shape and a real date', () => {
    for (const bad of [undefined, 1, '', '2026-11-18 21:15', '31-Feb-2026 01:00:00 AM', '18-Foo-2026 01:00:00 AM', '18-Nov-2026 13:00:00 PM', '18-Nov-2026 00:10:00 AM', '18-Nov-2026 09:60:00 PM'])
      expect(parseRailTime(bad)).toBeUndefined();
  });
});

describe('railText', () => {
  it('decodes entities, strips tags and control characters, and bounds length', () => {
    expect(railText('Newark Airport &#9992')).toBe('Newark Airport &#9992');
    expect(railText('Newark Airport &#9992;')).toBe('Newark Airport ✈');
    expect(railText('  <b>New&nbsp;York</b>\u0007 ')).toBe('New York');
    expect(railText(' ')).toBeNull();
    expect(railText('x'.repeat(65))).toBeNull();
    expect(railText(5)).toBeNull();
    expect(railText('<'.repeat(100_000))).toBeNull();
  });
});

describe('normalizeRailBoard', () => {
  it('accepts the short station name echo and keeps only display fields', () => {
    const out = normalizeRailBoard(board([row()], 'NY', 'New York'), 'NY', 1000);
    expect(out).toEqual({ v: 1, source: 'NJ Transit RailData', station: 'NY', state: 'ok', receivedAt: 1000, skippedRows: 0, departures: [{
      trainId: '1620', line: 'Pascack Valley Line', lineCode: 'PV', destination: 'Hoboken', scheduledAt: Date.parse('2026-11-19T02:15:00Z'),
      track: null, status: null, secondsLate: 120, updatedAt: Date.parse('2026-11-19T02:10:30Z') }] });
    expect(JSON.stringify(out)).not.toMatch(/40\.9|VEHICLE|GPS/);
  });
  it('treats null ITEMS as no trains, and refuses a wrong station or a missing list', () => {
    expect(normalizeRailBoard(board(null), 'EX', 1).departures).toEqual([]);
    expect(() => normalizeRailBoard(board([]), 'AS', 1)).toThrow('unexpected-schema');
    expect(() => normalizeRailBoard({ STATION_2CHAR: 'EX' }, 'EX', 1)).toThrow('unexpected-schema');
    expect(() => normalizeRailBoard(board({}), 'EX', 1)).toThrow('unexpected-schema');
    expect(() => normalizeRailBoard([], 'EX', 1)).toThrow('unexpected-schema');
  });
  it('drops and counts rows without a train number or a parseable time, and sorts by time', () => {
    const out = normalizeRailBoard(board([row({ TRAIN_ID: '1622', SCHED_DEP_DATE: '18-Nov-2026 10:15:00 PM', SEC_LATE: 'late', TRACK: '3', STATUS: 'BOARDING ' }),
      row(), row({ TRAIN_ID: 1624 }), row({ SCHED_DEP_DATE: 'soon' }), 'junk', row({ TRAIN_ID: 'bad id!' })]), 'EX', 1);
    expect(out.skippedRows).toBe(4);
    expect(out.departures.map((d) => [d.trainId, d.track, d.status, d.secondsLate])).toEqual([['1620', null, null, 120], ['1622', '3', 'BOARDING', null]]);
  });
  it('reads at most 40 rows', () => {
    const out = normalizeRailBoard(board(Array.from({ length: 45 }, (_, i) => row({ TRAIN_ID: String(i) }))), 'EX', 1);
    expect([out.departures.length, out.skippedRows]).toEqual([40, 5]);
  });
});

function harness(respond: (method: string, fields: FormData) => Response | Promise<Response>) {
  let now = Date.parse('2026-11-18T22:00:00Z');
  const store = new Map<string, unknown>(), calls: string[] = [];
  const storage = { get: async <T,>(k: string) => structuredClone(store.get(k)) as T | undefined, put: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); } };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = url.split('/').pop()!; calls.push(method);
    expect(url.startsWith('https://raildata.njtransit.com/api/TrainData/')).toBe(true);
    return respond(method, init.body as FormData);
  }) as unknown as typeof fetch;
  const env = { NJT_API_USERNAME: 'user', NJT_API_PASSWORD: 'pass' };
  const make = () => new RailBoards(storage, env, fetchImpl, () => now);
  return { make, calls, store, advance: (ms: number) => { now += ms; } };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const tokenOk = (n = 1) => json({ Authenticated: 'True', UserToken: `tok-${n}` });

describe('RailBoards', () => {
  it('reuses one token and asks NJ Transit at most once a minute per station', async () => {
    const h = harness((m, f) => m === 'getToken' ? tokenOk() : json(board([row()], String(f.get('station')))));
    const rail = h.make();
    const [a, b] = await Promise.all([rail.board('EX'), rail.board('EX')]);
    expect(a).toBe(b);
    expect(a.state).toBe('ok');
    await rail.board('EX');
    expect(h.calls).toEqual(['getToken', 'getTrainSchedule19Rec']);
    await rail.board('AS');
    h.advance(RAIL_BOARD_MS);
    await rail.board('EX');
    expect(h.calls).toEqual(['getToken', 'getTrainSchedule19Rec', 'getTrainSchedule19Rec', 'getTrainSchedule19Rec']);
    expect(JSON.stringify(await rail.board('EX'))).not.toContain('tok-');
    // A restarted object reuses the stored token instead of asking for another.
    const again = h.make(); h.advance(RAIL_BOARD_MS);
    await again.board('EX');
    expect(h.calls.filter((c) => c === 'getToken')).toHaveLength(1);
  });

  it('sends the station and its line filter', async () => {
    const seen: string[] = [];
    const h = harness((m, f) => { if (m !== 'getToken') seen.push(`${f.get('token')}:${f.get('station')}:${f.get('line')}`); return m === 'getToken' ? tokenOk() : json(board([], String(f.get('station')))); });
    const rail = h.make();
    await rail.board('AS'); await rail.board('NY');
    expect(seen).toEqual(['tok-1:AS:PV', 'tok-1:NY:']);
  });

  it('counts a token request before sending it and never exceeds the daily allowance or the hourly gap', async () => {
    let minted = 0;
    const h = harness((m, f) => { if (m === 'getToken') { minted++; return tokenOk(minted); } return json({}, 401); });
    const rail = h.make();
    const first = await rail.board('EX');
    expect(first).toMatchObject({ state: 'unavailable', reason: 'access-denied', departures: [], receivedAt: null });
    expect((h.store.get('rail-v1') as { mints: number[] }).mints).toHaveLength(1);
    h.advance(RAIL_BOARD_MS);
    // Within the hour a refused token is dropped but not replaced.
    expect(await rail.board('EX')).toMatchObject({ reason: 'token-limit' });
    for (let i = 0; i < 6; i++) { h.advance(3600_000); await rail.board('EX'); }
    expect(minted).toBe(RAIL_MINTS_PER_DAY);
    expect((await rail.health()).tokenRequests24h).toBe(RAIL_MINTS_PER_DAY);
    h.advance(24 * 3600_000);
    await rail.board('EX');
    expect(minted).toBe(RAIL_MINTS_PER_DAY + 1);
  });

  it('replaces a refused token once when the allowance allows, and keeps a failed answer for the minute', async () => {
    let tokens = 0, refuse = false, down = false;
    const h = harness((m, f) => {
      if (m === 'getToken') return tokenOk(++tokens);
      if (down) return json({}, 503);
      if (refuse && f.get('token') === 'tok-1') return json({}, 403);
      return json(board([row()], String(f.get('station'))));
    });
    const rail = h.make();
    expect((await rail.board('EX')).state).toBe('ok');
    // A refused token costs that minute: one schedule request, the token dropped, no second request.
    refuse = true; h.advance(2 * 3600_000);
    const before = h.calls.length;
    expect(await rail.board('EX')).toMatchObject({ state: 'unavailable', reason: 'access-denied' });
    expect(h.calls.slice(before)).toEqual(['getTrainSchedule19Rec']);
    expect((h.store.get('rail-v1') as { token?: unknown }).token).toBeUndefined();
    h.advance(RAIL_BOARD_MS);
    expect((await rail.board('EX')).state).toBe('ok');
    expect(tokens).toBe(2);
    h.advance(RAIL_BOARD_MS); down = true;
    expect(await rail.board('EX')).toMatchObject({ state: 'unavailable', reason: 'http-error' });
    const cached = h.calls.length; down = false;
    expect((await rail.board('EX')).state).toBe('unavailable');
    expect(h.calls.length).toBe(cached);
  });

  it('reports agency errors by safe code only', async () => {
    const cases: [Response, string][] = [[json({ errorMessage: 'Daily usage limit reached for user x' }), 'rate-limited'], [json({ errorMessage: 'secret detail' }), 'api-error'],
      [new Response('<html>', { status: 200 }), 'unexpected-response'], [json({}, 500), 'http-error'], [json({}, 429), 'rate-limited'], [json(board([], 'AS')), 'unexpected-schema']];
    for (const [response, reason] of cases) {
      const h = harness((m) => m === 'getToken' ? tokenOk() : response.clone());
      const out = await h.make().board('EX');
      expect(out).toMatchObject({ state: 'unavailable', reason });
      expect(JSON.stringify(out)).not.toMatch(/secret|user x|html/);
    }
    for (const status of [200, 500]) {
      const h = harness((m) => m === 'getToken' ? tokenOk() : json({ errorMessage: 'Invalid token.' }, status));
      expect(await h.make().board('EX')).toMatchObject({ reason: 'access-denied' });
      expect((h.store.get('rail-v1') as { token?: unknown }).token).toBeUndefined();
    }
    const denied = harness((m) => m === 'getToken' ? json({ Authenticated: 'False' }) : json({}));
    expect(await denied.make().board('EX')).toMatchObject({ reason: 'access-denied' });
  });

  it('refuses unknown stations and needs credentials', async () => {
    const h = harness(() => tokenOk());
    await expect(h.make().board('toString')).rejects.toThrow();
    const none = new RailBoards({ get: async () => undefined, put: async () => {} }, { NJT_API_USERNAME: '', NJT_API_PASSWORD: '' }, (() => { throw new Error('no'); }) as unknown as typeof fetch);
    expect(await none.board('EX')).toMatchObject({ reason: 'configuration-missing' });
  });
});

describe('/v1/rail route', () => {
  const router = createRouter(parseDataset(raw));
  const forwarded: string[] = [];
  const env = { FEED: { idFromName: () => 'id', get: () => ({ fetch: async (r: Request) => { forwarded.push(r.url); return new Response('{"v":1}'); } }) } };
  const get = (q: string) => router.fetch(new Request(`https://w.example/v1/rail${q}`), env as never);
  it('forwards only a known station with no other parameters', async () => {
    expect((await get('?station=EX')).status).toBe(200);
    for (const q of ['', '?station=XX', '?station=toString', '?station=EX&x=1', '?station=EX&station=AS']) expect((await get(q)).status).toBe(400);
    expect(forwarded).toEqual(['https://w.example/v1/rail?station=EX']);
  });
});
