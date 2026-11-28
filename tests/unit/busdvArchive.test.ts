import { describe, expect, it, vi } from 'vitest';
import { BusDvArchive, BUSDV_FEEDS, BUSDV_REQUEST_LIMIT, STATEWIDE_RADIUS, VEHICLE_MODES,
  TRIP_STOPS_PER_HOUR, busDvCoverage, busDvCoverageStatus, busDvLocationCodes, busDvTripRefs, newBusDvState,
  type BusDvPlan, type BusDvState } from '../../worker/busdv-archive';
import { HISTORY_INTERVAL_MS } from '../../worker/history-journal';

// Acceptance evidence: the day simulations check every mode, board gap (including the start/end
// boundaries), daily mode labels, rolling reservations and renewal across private JSON checkpoints.
// Other tests exercise exact byte reconstruction, safe partial output, cooldown/retry/ceiling paths,
// stream limits, hostile responses and stale plans. No UI or calibrated spatial claim is produced.
const NOW = Date.UTC(2026, 10, 26, 17), HOUR = 3_600_000, DAY = 24 * HOUR;
const TOKEN = 'synthetic-busdv-token', USER = 'synthetic-api-user', PASSWORD = 'synthetic-api-password';
const locations = (count: number) => Array.from({ length: count }, (_, n) => `S${String(n).padStart(3, '0')}`);
const encode = (text: string) => new TextEncoder().encode(text);
interface Call { method: string; fields: Record<string, string>; at: number }
type Answer = (call: Call) => Response | Promise<Response>;

function harness(count = 300, timeoutMs = 20_000) {
  let now = NOW, state = newBusDvState(), checkpoint: BusDvState;
  const calls: Call[] = [], answers: Record<string, Answer> = {};
  const credentials = { NJT_API_USERNAME: USER, NJT_API_PASSWORD: PASSWORD };
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (!String(url).startsWith('https://pcsdata.njtransit.com/api/BUSDV2/')) throw new Error('unexpected host');
    if (init?.redirect !== 'manual' || init?.method !== 'POST' || !(init.body instanceof FormData)) throw new Error('unsafe request');
    const call: Call = { method: String(url).split('/').at(-1)!, fields: Object.fromEntries(init.body.entries()) as Record<string, string>, at: now };
    calls.push(call);
    if (answers[call.method]) return answers[call.method]!(call);
    if (call.method === 'authenticateUser') return Response.json({ Authenticated: 'True', UserToken: TOKEN });
    if (call.fields.token !== TOKEN) throw new Error('wrong token');
    if (call.method === 'getLocations') return Response.json(locations(count).map(code => ({ bus_terminal_code: code })));
    return Response.json({ synthetic: call.method });
  }) as typeof fetch;
  const archive = () => new BusDvArchive(state, credentials, fetchImpl, () => now, timeoutMs);
  return { calls, answers, credentials, fetchImpl, archive, get state() { return state; },
    time: (at: number) => { now = at; },
    /** accept: whether the raw archive takes this poll's answers (service.ts calls onAccepted from capture). */
    async run(accept = true) {
      const a = archive(), plan = a.prepare(now);
      checkpoint = JSON.parse(JSON.stringify(state)) as BusDvState;
      if (!plan || typeof plan === 'string') return plan;
      // A cold collector with the pre-I/O checkpoint must still honor the same reservation.
      state = checkpoint;
      const result = await archive().collect(plan);
      if (accept) for (const response of result.responses) response.onAccepted?.();
      return result;
    } };
}
type Result = Awaited<ReturnType<BusDvArchive['collect']>>;
function result(value: Result | string | undefined): Result {
  if (!value || typeof value === 'string') throw new Error(`poll refused: ${value}`);
  return value;
}
interface Entry { method: string; mode?: string; stop?: string; status: string; text?: string; base64?: string }
function entries(r: Result): Entry[] {
  const poll = r.responses.find(v => String(v.feed) === 'busdv-poll');
  return poll ? JSON.parse(new TextDecoder().decode(poll.bytes)).responses as Entry[] : [];
}

describe('BUSDV2 private raw archive', () => {
  it.each([{ count: 300, gap: 30 * 60_000 }, { count: 100, gap: 15 * 60_000 + 42_000 }])(
    'paces a day of 42 s polls for $count boards within $gap ms, with all four vehicles every poll', async ({ count, gap }) => {
      const h = harness(count), boardAt = new Map<string, number[]>();
      let polls = 0, dailyResponses = 0;
      for (let offset = 0; offset < DAY; offset += 42_000) {
        const at = NOW + offset; h.time(at);
        const start = h.calls.length, r = result(await h.run());
        expect(r.failures).toEqual([]);
        const current = h.calls.slice(start);
        expect(current.filter(c => c.method === 'getVehicleLocations').map(c => c.fields.mode).sort()).toEqual([...VEHICLE_MODES].sort());
        for (const c of current.filter(c => c.method === 'getBusDV')) {
          const times = boardAt.get(c.fields.stop!) ?? [];
          times.push(at); boardAt.set(c.fields.stop!, times);
        }
        expect(entries(r).filter(e => e.method === 'getVehicleLocations' && e.status === 'ok')).toHaveLength(4);
        dailyResponses += r.responses.filter(v => String(v.feed) !== 'busdv-poll').length;
        polls++;
      }
      const select = (method: string) => h.calls.filter(c => c.method === method);
      expect(select('getVehicleLocations')).toHaveLength(polls * 4);
      expect(select('authenticateUser')).toHaveLength(2);
      expect(dailyResponses).toBe(8);
      for (const method of ['getLocations', 'getBusRoutes']) for (const mode of VEHICLE_MODES) {
        expect(select(method).filter(c => c.fields.mode === mode)).toHaveLength(1);
      }
      expect(h.calls.length).toBeLessThan(BUSDV_REQUEST_LIMIT);
      expect(Object.values(h.state.budget.hours).reduce((a, b) => a + b, 0)).toBe(h.calls.length);
      expect([...boardAt.keys()].filter(code => code !== 'PABT').sort()).toEqual(locations(count));
      for (const code of locations(count)) {
        const times = [NOW, ...boardAt.get(code)!, NOW + DAY];
        for (let n = 1; n < times.length; n++) expect(times[n]! - times[n - 1]!, `board ${code}`).toBeLessThanOrEqual(gap);
      }
      expect(select('getBusDV')[0]!.fields).toEqual({ token: TOKEN, stop: 'PABT', direction: '', route: '', IP: '', minutesRequested: '', maxVariants: '', sortMode: '' });
      expect(select('getVehicleLocations')[0]!.fields).toEqual({ token: TOKEN, mode: 'BUS', lat: '40.2', lon: '-74.6', radius: STATEWIDE_RADIUS });
      // 100 miles in feet: a radius of 200 returned no vehicles live (Nov 26, 2026), so the unit is likely feet.
      expect(STATEWIDE_RADIUS).toBe('528000');
    }, 60_000);

  it('preserves UTF-8 including BOM, whitespace, non-UTF-8 bytes, and exact labeled daily bytes', async () => {
    const h = harness(), text = '\ufeff {"value":"café \\u00e9"}\r\n', odd = new Uint8Array([0x7b, 0xff, 0]);
    const daily = encode(' [ {"bus_terminal_code":"S001"} ] \r\n');
    h.answers.getVehicleLocations = c => new Response(c.fields.mode === 'BUS' ? encode(text) : odd);
    h.answers.getLocations = () => new Response(daily);
    const r = result(await h.run());
    expect(r.secrets).toContain(TOKEN);
    expect(entries(r).find(e => e.mode === 'BUS' && e.method === 'getVehicleLocations')!.text).toBe(text);
    expect(encode(entries(r).find(e => e.mode === 'BUS' && e.method === 'getVehicleLocations')!.text!)).toEqual(encode(text));
    for (const e of entries(r).filter(e => e.method === 'getVehicleLocations' && e.mode !== 'BUS')) {
      expect(new Uint8Array(Buffer.from(e.base64!, 'base64'))).toEqual(odd);
    }
    const lists = r.responses.filter(v => String(v.feed) === 'busdv-getLocations');
    expect(lists.map(v => v.label).sort()).toEqual([...VEHICLE_MODES].sort());
    for (const v of lists) expect(v.bytes).toEqual(daily);
    for (const v of r.responses) for (const secret of [TOKEN, USER, PASSWORD]) expect(new TextDecoder().decode(v.bytes)).not.toContain(secret);
    expect(BUSDV_FEEDS).toEqual(['busdv-poll', 'busdv-getLocations', 'busdv-getBusRoutes']);
  });

  it('records a 503 board in the bundle and failures while retaining siblings', async () => {
    const h = harness(); h.answers.getBusDV = () => new Response('upstream details', { status: 503 });
    const r = result(await h.run());
    expect(r.failures).toContainEqual(expect.objectContaining({ feed: 'busdv-getBusDV', stop: 'PABT', code: 'http-error' }));
    expect(entries(r)).toContainEqual(expect.objectContaining({ method: 'getBusDV', stop: 'PABT', status: 'http-error' }));
    expect(entries(r).filter(e => e.method === 'getVehicleLocations' && e.status === 'ok')).toHaveLength(4);
    expect(JSON.stringify(entries(r))).not.toContain('upstream details');
  });

  it('retains failure-only bundles when every data request fails', async () => {
    const h = harness();
    for (const method of ['getVehicleLocations', 'getBusDV', 'getLocations', 'getBusRoutes']) h.answers[method] = () => new Response('', { status: 503 });
    const r = result(await h.run());
    expect(entries(r)).toHaveLength(13);
    expect(r.failures).toHaveLength(13);
    expect(entries(r).every(e => e.status === 'http-error')).toBe(true);
  });

  it('drops an invalid token error body, remints once next poll, and preserves healthy modes', async () => {
    const h = harness();
    h.answers.getVehicleLocations = c => c.fields.mode === 'NLR'
      ? Response.json({ errorMessage: 'Invalid token.' }) : Response.json({ synthetic: true });
    let r = result(await h.run());
    expect(r.failures).toContainEqual(expect.objectContaining({ code: 'access-denied', mode: 'NLR' }));
    expect(h.state.token).toBeUndefined();
    expect(JSON.stringify(entries(r))).not.toContain('Invalid token');
    expect(entries(r).filter(e => e.status === 'ok' && e.method === 'getVehicleLocations')).toHaveLength(3);
    delete h.answers.getVehicleLocations; h.time(NOW + 42_000); r = result(await h.run());
    expect(r.failures).toEqual([]);
    expect(h.calls.filter(c => c.method === 'authenticateUser')).toHaveLength(2);
  });

  it.each(['json', 'http'])('pauses every call for a full hour after a %s rate limit', async kind => {
    const h = harness();
    h.answers.getBusDV = () => kind === 'json' ? Response.json({ errorMessage: 'Daily usage limit:40000.' }) : new Response('', { status: 429 });
    expect(result(await h.run()).failures.map(f => f.code)).toContain('rate-limited');
    const before = h.calls.length, reservation = structuredClone(h.state.budget);
    for (const offset of [42_000, HOUR - 1]) {
      h.time(NOW + offset); const r = result(await h.run());
      expect(r.failures.map(f => f.code)).toEqual(['rate-limited']);
      expect(r.responses).toEqual([]);
      expect(h.calls).toHaveLength(before);
      expect(h.state.budget).toEqual(reservation);
    }
    delete h.answers.getBusDV; h.time(NOW + HOUR);
    expect(result(await h.run()).failures).toEqual([]);
    expect(h.calls.length).toBeGreaterThan(before);
  });

  it('enforces a streamed cap without trusting Content-Length or saving a prefix', async () => {
    const h = harness(); let cancelled = false;
    h.answers.getBusDV = () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(2 * 1024 * 1024)); c.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Length': '1' } });
    const r = result(await h.run());
    expect(r.failures.map(f => f.code)).toEqual(['response-too-large']);
    expect(entries(r).find(e => e.method === 'getBusDV')).toEqual(expect.objectContaining({ status: 'response-too-large' }));
    expect(entries(r).find(e => e.method === 'getBusDV')!.base64).toBeUndefined();
    expect(cancelled).toBe(true);
  });

  it('returns request-ceiling before all I/O when mandatory calls cannot fit', async () => {
    const h = harness(); h.state.budget.hours[Math.floor(NOW / HOUR)] = BUSDV_REQUEST_LIMIT - 2;
    expect(await h.run()).toBe('request-ceiling');
    expect(h.calls).toEqual([]);
    expect(h.state.mints).toEqual([]);
    expect(h.state.lastPollAt).toBeUndefined();
  });

  it('reduces board work to protect vehicles near the ceiling', async () => {
    const h = harness(); h.state.budget.hours[Math.floor(NOW / HOUR)] = BUSDV_REQUEST_LIMIT - 13;
    const r = result(await h.run());
    expect(r.failures).toEqual([]);
    expect(h.calls).toHaveLength(13); // Authentication, four vehicles and eight daily calls.
    expect(h.calls.some(c => c.method === 'getBusDV')).toBe(false);
  });

  // it.for passes each row whole; it.each would spread an array row into separate arguments (CodeRabbit, #324).
  it.for<unknown>([{}, [], [{ bus_terminal_code: 'S001' }, {}], [{ bus_terminal_code: 42 }], [{ bus_terminal_code: ' ' }]])(
    'keeps the previous location list on a malformed daily answer %j', async bad => {
      expect(bad).toBeDefined();
      const h = harness(); h.state.locations = ['S100', 'S200'];
      h.answers.getLocations = () => Response.json(bad);
      const r = result(await h.run());
      expect(h.state.locations).toEqual(['S100', 'S200']);
      expect(r.failures).toContainEqual(expect.objectContaining({ feed: 'busdv-getLocations', mode: 'BUS', code: 'invalid-response' }));
      expect(r.responses.filter(v => String(v.feed) === 'busdv-getLocations')).toHaveLength(4);
    });

  it('parses only the documented code field, trims and deduplicates, and refuses malformed text', () => {
    expect(busDvLocationCodes(encode('[{"bus_terminal_code":" S002 "},{"bus_terminal_code":"S001"},{"bus_terminal_code":"S002"}]'))).toEqual(['S001', 'S002']);
    expect(busDvLocationCodes(encode('[{"code":"PABT"}]'))).toBeUndefined();
    expect(busDvLocationCodes(encode('bad JSON'))).toBeUndefined();
    expect(busDvLocationCodes(new Uint8Array([0xff]))).toBeUndefined();
    expect(busDvLocationCodes(encode('[{"bus_terminal_code":"synthetic / code"}]'))).toEqual(['synthetic / code']);
  });

  it('retries malformed location discovery after one hour, without discarding the raw answer', async () => {
    const h = harness(); h.state.locations = ['S001'];
    h.answers.getLocations = c => c.fields.mode === 'BUS' ? Response.json({ unexpected: true }) : Response.json([]);
    result(await h.run());
    expect(h.state.ok['getLocations:BUS']).toBeUndefined();
    h.time(NOW + HOUR); const r = result(await h.run());
    expect(h.calls.filter(c => c.method === 'getLocations' && c.fields.mode === 'BUS')).toHaveLength(2);
    expect(h.state.locations).toEqual(['S001']);
    // An empty light rail list is malformed too, so those lines are asked again in an hour as well.
    expect(r.responses.filter(v => String(v.feed) === 'busdv-getLocations').map(v => v.label)).toEqual(['BUS', 'NLR', 'HBLR', 'RL']);
  });

  // Jeff, Nov 28, 2026: "do the light rail boards". Synthetic station codes only.
  it('adds each light rail line\'s stations to the boards, after the bus boards', async () => {
    const h = harness();
    h.answers.getLocations = c => Response.json(({ BUS: ['B2', 'B1'], NLR: ['N1', 'B1'], HBLR: ['H1'], RL: ['R1'] } as Record<string, string[]>)[String(c.fields.mode)]!
      .map((code: string) => ({ bus_terminal_code: code })));
    result(await h.run());
    expect(h.state.locations).toEqual(['B1', 'B2']);
    expect(h.state.railLocations).toEqual({ NLR: ['B1', 'N1'], HBLR: ['H1'], RL: ['R1'] });
    // The first poll had only the default PABT board; from then on the lists drive the boards.
    for (let n = 1; n <= 40; n++) { h.time(NOW + n * HISTORY_INTERVAL_MS); result(await h.run()); }
    const asked = h.calls.filter(c => c.method === 'getBusDV' && c.at > NOW).map(c => c.fields.stop!);
    expect(asked.slice(0, 5)).toEqual(['B1', 'B2', 'N1', 'H1', 'R1']);
  });

  it('keeps a light rail line\'s last good station list when its daily answer is bad', async () => {
    const h = harness(); h.state.railLocations = { HBLR: ['H1', 'H2'] };
    h.answers.getLocations = c => c.fields.mode === 'HBLR' ? Response.json([{ bus_terminal_code: 7 }]) : Response.json([{ bus_terminal_code: 'X1' }]);
    const r = result(await h.run());
    expect(h.state.railLocations).toEqual({ HBLR: ['H1', 'H2'], NLR: ['X1'], RL: ['X1'] });
    expect(r.failures).toContainEqual(expect.objectContaining({ feed: 'busdv-getLocations', mode: 'HBLR', code: 'invalid-response' }));
    expect(h.state.ok['getLocations:HBLR']).toBeUndefined();
    expect(h.state.ok['getLocations:NLR']).toBe(NOW);
  });

  it.each([{ errorMessage: 'Authentication failed' }, { error: 'Invalid token' }, 'Invalid token'])('refuses a small JSON error envelope %j', async envelope => {
    const h = harness(); h.answers.getBusDV = () => Response.json(envelope);
    const r = result(await h.run());
    expect(r.failures.map(f => f.code)).toEqual(['access-denied']);
    expect(h.state.token).toBeUndefined();
    expect(entries(r).find(e => e.method === 'getBusDV')!.text).toBeUndefined();
  });

  it('checks the inclusive 16 KiB error boundary and preserves ordinary departure messages', async () => {
    const h = harness(), body = JSON.stringify({ errorMessage: 'Invalid token' }).padEnd(16 * 1024, ' ');
    h.answers.getBusDV = () => new Response(body);
    expect(result(await h.run()).failures.map(f => f.code)).toEqual(['access-denied']);
    h.answers.getBusDV = () => Response.json({ message: { message: 'No synthetic departures' }, DVTrip: [] });
    h.time(NOW + 42_000);
    const r = result(await h.run());
    expect(r.failures).toEqual([]);
    expect(entries(r).filter(e => e.method === 'getBusDV').every(e => e.status === 'ok')).toBe(true);
  });

  it.each(['not JSON', '{}', '{"Authenticated":"True","UserToken":""}'])('refuses malformed authentication without issuing data calls (%s)', async body => {
    const h = harness(); h.answers.authenticateUser = () => new Response(body);
    const r = result(await h.run());
    expect(r.failures.length).toBeGreaterThan(0);
    expect(r.failures.every(f => ['access-denied', 'invalid-response'].includes(f.code))).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.state.token).toBeUndefined();
  });

  it('retries only failed daily calls after one hour and keeps their mode labels', async () => {
    const h = harness();
    h.answers.getBusRoutes = c => c.fields.mode === 'RL' ? new Response('', { status: 503 }) : Response.json([]);
    result(await h.run());
    h.time(NOW + HOUR - 1); result(await h.run());
    expect(h.calls.filter(c => c.method === 'getBusRoutes')).toHaveLength(4);
    delete h.answers.getBusRoutes; h.time(NOW + HOUR + 42_000);
    const r = result(await h.run());
    expect(h.calls.filter(c => c.method === 'getBusRoutes')).toHaveLength(5);
    expect(r.responses.filter(v => String(v.feed) === 'busdv-getBusRoutes').map(v => v.label)).toEqual(['RL']);
  });

  it('asks a daily call again in an hour when the raw archive could not take its answer (CodeRabbit, #324)', async () => {
    const h = harness();
    result(await h.run(false));
    h.time(NOW + HOUR - 1); result(await h.run());
    expect(h.calls.filter(c => c.method === 'getBusRoutes')).toHaveLength(4);
    h.time(NOW + HOUR + 42_000); result(await h.run());
    expect(h.calls.filter(c => c.method === 'getBusRoutes')).toHaveLength(8);
    h.time(NOW + 2 * HOUR + 84_000); result(await h.run());
    expect(h.calls.filter(c => c.method === 'getBusRoutes')).toHaveLength(8);
  });

  it.each([TOKEN, USER, PASSWORD, encodeURIComponent(PASSWORD)])('refuses an echoed secret without redacting the evidence (%s)', async secret => {
    const h = harness(); h.answers.getBusDV = () => Response.json({ synthetic: secret });
    const r = result(await h.run());
    expect(r.failures.map(f => f.code)).toEqual(['invalid-response']);
    for (const response of r.responses) expect(new TextDecoder().decode(response.bytes)).not.toContain(secret);
  });

  it('refuses configuration without spending requests or mint attempts', async () => {
    const h = harness(); h.credentials.NJT_API_PASSWORD = '';
    const r = result(await h.run());
    expect(r.failures.map(f => f.code)).toEqual(['configuration-missing']);
    expect(h.calls).toEqual([]);
    expect(h.state.budget.hours).toEqual({});
    expect(h.state.mints).toEqual([]);
  });

  it('counts failed mints, stops after three in a rolling day, and does not reset at midnight', async () => {
    const h = harness(); h.answers.authenticateUser = () => new Response('', { status: 401 });
    for (const offset of [0, HOUR, 2 * HOUR]) {
      h.time(NOW + offset);
      expect(result(await h.run()).failures.every(f => f.code === 'access-denied')).toBe(true);
    }
    expect(h.calls).toHaveLength(3);
    h.time(NOW + 12 * HOUR);
    expect(result(await h.run()).failures.map(f => f.code)).toEqual(['token-limit']);
    expect(h.calls).toHaveLength(3);
    h.time(NOW + DAY);
    expect(result(await h.run()).failures.every(f => f.code === 'access-denied')).toBe(true);
    expect(h.calls).toHaveLength(4);
  });

  it('a short login outage spends two logins and keeps the third for an hour later (Neon DEEP Nov 26)', async () => {
    const h = harness(); h.answers.authenticateUser = () => new Response('', { status: 401 });
    for (const offset of [0, 42_000, 84_000]) { h.time(NOW + offset); await h.run(); }
    expect(h.calls.filter(c => c.method === 'authenticateUser')).toHaveLength(2);
    expect(h.state.mints).toEqual([NOW, NOW + 42_000]);
    h.time(NOW + 42_000 + HOUR); await h.run();
    expect(h.calls.filter(c => c.method === 'authenticateUser')).toHaveLength(3);
  });

  it('keeps conservative hourly requests across the rolling boundary', async () => {
    const h = harness();
    h.state.budget.hours[Math.floor((NOW - DAY) / HOUR)] = BUSDV_REQUEST_LIMIT;
    expect(await h.run()).toBe('request-ceiling');
    h.time(NOW + HOUR);
    expect(result(await h.run()).failures).toEqual([]);
  });

  it('spaces polls, checkpoints all requests before I/O, and refuses duplicate or superseded plans', async () => {
    const h = harness(), a = h.archive(), p = a.prepare(NOW) as BusDvPlan;
    expect(h.calls).toEqual([]);
    expect(Object.values(h.state.budget.hours).reduce((x, y) => x + y, 0)).toBe(p.requests.length + 1);
    expect(h.state.mints).toEqual([NOW]);
    expect(a.prepare(NOW + HISTORY_INTERVAL_MS - 1)).toBeUndefined();
    result(await a.collect(p)); const count = h.calls.length;
    expect((await a.collect(p)).failures.map(f => f.code)).toEqual(['invalid-response']);
    expect(h.calls).toHaveLength(count);
    h.time(NOW + 42_000); const p2 = a.prepare(NOW + 42_000) as BusDvPlan;
    h.time(NOW + 84_000); a.prepare(NOW + 84_000);
    expect((await a.collect(p2)).failures.map(f => f.code)).toEqual(['invalid-response']);
    expect(h.calls).toHaveLength(count);
  });

  it.each([{ status: 302, code: 'http-error' }, { status: 401, code: 'access-denied' },
    { status: 403, code: 'access-denied' }, { status: 500, code: 'http-error' }])('refuses HTTP $status as $code without saving error bodies', async ({ status, code }) => {
    const h = harness(); h.answers.getBusDV = () => new Response('unsafe diagnostic body', { status, headers: { Location: 'https://example.invalid' } });
    const r = result(await h.run());
    expect(r.failures.map(f => f.code)).toEqual([code]);
    expect(JSON.stringify(entries(r))).not.toContain('unsafe diagnostic body');
  });

  it('uses fixed network failure codes instead of exception messages', async () => {
    const h = harness(); h.answers.getBusDV = () => { throw new Error(PASSWORD); };
    const r = result(await h.run());
    expect(r.failures.map(f => f.code)).toEqual(['network-error']);
    expect(JSON.stringify(r.failures)).not.toContain(PASSWORD);
  });

  it.each(['fetch', 'stream'])('bounds a stalled %s even when it ignores AbortSignal', async kind => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.answers.getBusDV = () => kind === 'fetch' ? new Promise<Response>(() => {})
        : new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encode('partial')); } }));
      const pending = h.run();
      await vi.advanceTimersByTimeAsync(19_999);
      let done = false; void pending.then(() => { done = true; });
      await Promise.resolve(); expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const r = result(await pending);
      expect(r.failures.map(f => f.code)).toEqual(['timed-out']);
      expect(entries(r).some(e => e.text === 'partial')).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  // Neon review of #304, Nov 26, 2026.
  it.each([{ errorMessage: null, DVTrip: [] }, { errorMessage: '', DVTrip: [] }, { Error: false }])('keeps a board whose error field is empty (%j) and keeps the token', async body => {
    const h = harness(); h.answers.getBusDV = () => Response.json(body);
    const r = result(await h.run());
    expect(r.failures).toEqual([]);
    expect(entries(r).find(e => e.method === 'getBusDV')).toMatchObject({ status: 'ok', text: JSON.stringify(body) });
    expect(h.state.token?.value).toBe(TOKEN);
  });

  it('refuses any other error text without dropping the token, so no daily mint is spent', async () => {
    const h = harness(); h.answers.getBusDV = () => Response.json({ errorMessage: 'Synthetic server problem' });
    const r = result(await h.run());
    expect(r.failures.map(f => f.code)).toEqual(['invalid-response']);
    expect(entries(r).find(e => e.method === 'getBusDV')!.text).toBeUndefined();
    expect(h.state.token?.value).toBe(TOKEN);
    h.time(NOW + 42_000); await h.run();
    expect(h.calls.filter(c => c.method === 'authenticateUser')).toHaveLength(1);
  });

  it.each(['<html><body>Service unavailable</body></html>', '﻿  <?xml version="1.0"?><error/>', 'Service Unavailable'])('never saves a markup page as data, and retries a daily call an hour later (%s)', async page => {
    const h = harness(); h.answers.getBusRoutes = () => new Response(page);
    const r = result(await h.run());
    expect(r.failures.filter(f => f.feed === 'busdv-getBusRoutes').map(f => f.code)).toEqual(VEHICLE_MODES.map(() => 'invalid-response'));
    expect(r.responses.some(v => String(v.feed) === 'busdv-getBusRoutes')).toBe(false);
    delete h.answers.getBusRoutes; h.time(NOW + HOUR);
    result(await h.run());
    expect(h.calls.filter(c => c.method === 'getBusRoutes')).toHaveLength(2 * VEHICLE_MODES.length);
  });

  it('sends nothing more in a poll once a sibling is rate limited', async () => {
    const h = harness(); h.answers.getVehicleLocations = c => c.fields.mode === 'BUS' ? new Response('', { status: 429 }) : Response.json({ synthetic: true });
    const r = result(await h.run());
    // BUS and NLR start together on the two connections; nothing after them is sent.
    expect(h.calls.map(c => c.method)).toEqual(['authenticateUser', 'getVehicleLocations', 'getVehicleLocations']);
    expect(r.failures.filter(f => f.code === 'rate-limited').length).toBe(entries(r).length - 1);
  });

  it('starts nothing 12 seconds into its turn, so a slow NJ Transit cannot hold the live bus poll', async () => {
    const h = harness();
    h.answers.getVehicleLocations = c => { if (c.fields.mode === 'BUS') h.time(NOW + 12_000); return Response.json({ synthetic: true }); };
    const r = result(await h.run());
    // The clock reached 12 s as the first call was sent, so the second lane sends nothing either.
    expect(h.calls.filter(c => c.method !== 'authenticateUser')).toHaveLength(1);
    expect(entries(r).filter(e => e.status === 'ok')).toHaveLength(1);
    expect(r.failures.length).toBe(entries(r).length - 1);
    expect(r.failures.every(f => f.code === 'timed-out')).toBe(true);
  });

  it('ends a hung call by 20 seconds into the turn even when its own limit is longer', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(300, 60_000);
      h.answers.getVehicleLocations = () => new Promise<Response>(() => {});
      const pending = h.run();
      let done = false; void pending.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(19_999); expect(done).toBe(false);
      // The archive's clock moves with the timers, so the queued calls see the spent turn.
      h.time(NOW + 20_000);
      await vi.advanceTimersByTimeAsync(1);
      const r = result(await pending);
      expect(h.calls.filter(c => c.method !== 'authenticateUser')).toHaveLength(2);
      expect(r.failures.length).toBe(entries(r).length);
      expect(r.failures.every(f => f.code === 'timed-out')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  describe('vehicle coverage on the status page (statewide radius check)', () => {
    const rows = (...r: unknown[]) => encode(JSON.stringify(r));
    it('counts vehicles and rounds the extents outward, from string or number fields', () => {
      expect(busDvCoverage(rows(
        { VehicleID: 'SYN1', VehicleLat: '40.7581', VehicleLong: '-73.9912', VehicleDistanceMiles: '30.2' },
        { VehicleID: 'SYN2', VehicleLat: 39.3611, VehicleLong: -74.4417, VehicleDistanceMiles: 75 },
        { VehicleID: 'SYN3', VehicleLat: 'x', VehicleLong: '-74.1', VehicleDistanceMiles: '' },
        'not a row', null, { errorMessage: 'synthetic note' },
      ))).toEqual({ vehicles: 3, maxMiles: 75, lat: [39.3, 40.8], lon: [-74.5, -73.9] });
    });
    it('counts a vehicle with no GPS fix (0,0) but never widens the reach to it (Neon Nov27 a)', () => {
      expect(busDvCoverage(rows({ VehicleLat: 0, VehicleLong: '0' }, { VehicleLat: '40.9', VehicleLong: '-74.1' })))
        .toEqual({ vehicles: 2, maxMiles: null, lat: [40.9, 40.9], lon: [-74.1, -74.1] });
    });
    it('reports an empty list as zero vehicles, and refuses anything that is not a JSON array', () => {
      expect(busDvCoverage(encode('\ufeff[]'))).toEqual({ vehicles: 0, maxMiles: null, lat: null, lon: null });
      for (const text of ['{"synthetic":1}', '<html></html>', '', '[1,']) expect(busDvCoverage(encode(text))).toBeUndefined();
      expect(busDvCoverage(new Uint8Array([0xff, 0x5b, 0x5d]))).toBeUndefined();
    });
    it('rejects out-of-range coordinates instead of widening the extents', () => {
      expect(busDvCoverage(rows({ VehicleLat: 400, VehicleLong: -74, VehicleDistanceMiles: -3 }, { VehicleLat: '40.0', VehicleLong: '-74.0' })))
        .toEqual({ vehicles: 2, maxMiles: null, lat: [40, 40], lon: [-74, -74] });
    });
    it('keeps each mode\'s last good answer, and the public copy has no token, IDs or exact positions', async () => {
      const h = harness();
      h.answers.getVehicleLocations = c => c.fields.mode === 'BUS'
        ? Response.json([{ VehicleID: 'SYN-BUS-7', VehicleLat: '40.8912', VehicleLong: '-74.0431', VehicleDistanceMiles: '52.4' }])
        : c.fields.mode === 'RL' ? new Response('<html>maintenance</html>') : Response.json([]);
      result(await h.run());
      const first = busDvCoverageStatus(h.state)!;
      // A mode stored without coverage is left out instead of breaking the status page (Neon Nov27 b).
      expect(busDvCoverageStatus({ ...h.state, coverage: { ...h.state.coverage, RL: undefined } })!.RL).toBeUndefined();
      // Totals only in public (CodeRabbit, #324): the map box stays in the private state.
      expect(first.BUS).toEqual({ at: NOW, vehicles: 1, maxMiles: 53 });
      expect(first.NLR).toEqual({ at: NOW, vehicles: 0, maxMiles: null });
      expect(h.state.coverage!.BUS).toMatchObject({ lat: [40.8, 40.9], lon: [-74.1, -74] });
      expect(first.RL).toBeUndefined();
      const published = JSON.stringify(first);
      for (const secret of [TOKEN, 'SYN-BUS-7', '40.8912', '-74.0431']) expect(published).not.toContain(secret);
      // A later failed answer keeps the last good coverage and its time.
      h.time(NOW + HISTORY_INTERVAL_MS);
      h.answers.getVehicleLocations = () => new Response('busy', { status: 500 });
      result(await h.run());
      expect(busDvCoverageStatus(h.state)!.BUS).toEqual(first.BUS);
      // The copy is detached from the private state.
      busDvCoverageStatus(h.state)!.BUS!.vehicles = 99;
      expect(h.state.coverage!.BUS!.vehicles).toBe(1);
      expect(busDvCoverageStatus(newBusDvState())).toBeNull();
    });
  });

  // Jeff, Nov 28, 2026: "just the 165 to the port authority route". Synthetic board rows only.
  describe('route 165 trip stop lists', () => {
    const trip = (n: number, route = '165') => ({ public_route: route, header: 'SYNTHETIC', lanegate: '1',
      timing_point_id: 'TPSYN', sched_dep_time: `11/26/2026 12:${String(n).padStart(2, '0')}:00 PM`, internal_trip_number: `9${n}` });
    function board(rows: unknown[]) {
      const h = harness();
      h.answers.getLocations = () => Response.json([{ bus_terminal_code: 'PABT' }]);
      h.answers.getBusDV = () => Response.json({ message: [], DVTrip: rows });
      h.answers.getTripStops = call => Response.json([{ synthetic: call.fields.internal_trip_number, SchedLaneGate: '1', ManLaneGate: '' }]);
      return h;
    }
    const asked = (h: ReturnType<typeof harness>) => h.calls.filter(c => c.method === 'getTripStops');

    it('reads only route 165 rows with all three fields, exactly as sent', () => {
      const bytes = encode(JSON.stringify({ DVTrip: [trip(1), trip(2, '166'), trip(3, '165T'), { ...trip(4), internal_trip_number: '' },
        { ...trip(5), sched_dep_time: 'x'.repeat(65) }, { ...trip(6), timing_point_id: 'TP\u0000' }, { ...trip(7), public_route: ' 165 ' }] }));
      expect(busDvTripRefs(bytes).map(r => r.internal_trip_number)).toEqual(['91', '97']);
      expect(busDvTripRefs(bytes)[0]).toEqual({ timing_point_id: 'TPSYN', sched_dep_time: '11/26/2026 12:01:00 PM', internal_trip_number: '91' });
      expect(busDvTripRefs(encode(JSON.stringify([{ DVTrip: [trip(8)] }])))).toHaveLength(1);
      for (const bad of ['not json', '{}', '{"DVTrip":{}}', '[1,null]']) expect(busDvTripRefs(encode(bad))).toEqual([]);
    });

    it('asks the next poll for a board trip\'s stop list with the token and saves the answer in the private bundle', async () => {
      const h = board([trip(1), trip(2, '166')]);
      result(await h.run());
      expect(asked(h)).toEqual([]);
      h.time(NOW + HISTORY_INTERVAL_MS);
      const r = result(await h.run());
      expect(asked(h).map(c => c.fields)).toEqual([{ token: TOKEN, timing_point_id: 'TPSYN', sched_dep_time: '11/26/2026 12:01:00 PM', internal_trip_number: '91' }]);
      const saved = entries(r).find(e => e.method === 'getTripStops')!;
      expect(saved.status).toBe('ok');
      expect(JSON.parse(saved.text!)).toEqual([{ synthetic: '91', SchedLaneGate: '1', ManLaneGate: '' }]);
      expect(JSON.stringify(entries(r))).not.toContain(PASSWORD);
    });

    it(`asks at most ${TRIP_STOPS_PER_HOUR} an hour, each trip once a day, and never takes a vehicle call`, async () => {
      const h = board(Array.from({ length: 30 }, (_, n) => trip(n)));
      for (let n = 0; n < 2 * 120; n++) { h.time(NOW + n * HISTORY_INTERVAL_MS); result(await h.run()); }
      const byHour = new Map<number, number>();
      for (const c of asked(h)) byHour.set(Math.floor(c.at / HOUR), (byHour.get(Math.floor(c.at / HOUR)) ?? 0) + 1);
      expect([...byHour.values()]).toEqual([TRIP_STOPS_PER_HOUR, TRIP_STOPS_PER_HOUR]);
      const keys = asked(h).map(c => c.fields.internal_trip_number);
      expect(new Set(keys).size).toBe(keys.length);
      const polls = h.calls.filter(c => c.method === 'getVehicleLocations').length;
      expect(polls).toBe(4 * 2 * 120);
    });

    it('counts a failed ask, saves the failure, and does not ask that trip again', async () => {
      const h = board([trip(1)]);
      h.answers.getTripStops = () => new Response('upstream details', { status: 503 });
      result(await h.run());
      h.time(NOW + HISTORY_INTERVAL_MS);
      const r = result(await h.run());
      expect(r.failures).toContainEqual(expect.objectContaining({ feed: 'busdv-getTripStops', code: 'http-error' }));
      for (let n = 2; n < 10; n++) { h.time(NOW + n * HISTORY_INTERVAL_MS); result(await h.run()); }
      expect(asked(h)).toHaveLength(1);
    });

    it('sends no stop list ask when only the required calls fit', async () => {
      const h = board([trip(1)]);
      result(await h.run());
      h.time(NOW + HISTORY_INTERVAL_MS);
      h.state.budget.hours[Math.floor(NOW / HOUR)] = BUSDV_REQUEST_LIMIT - 4 - (h.state.token ? 0 : 1);
      result(await h.run());
      expect(asked(h)).toEqual([]);
      expect(h.state.trips!.queue).toHaveLength(1);
    });
  });
});
