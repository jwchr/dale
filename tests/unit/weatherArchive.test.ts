import { describe, expect, it } from 'vitest';
import { ALERTS, ROTATION, ROTATION_PER_MINUTE, STATIONS, GRIDPOINTS, WeatherArchive, type WeatherState } from '../../worker/weather-archive';

const SLOT = Date.UTC(2026, 10, 26, 22, 15);
const ALERT_TEXT = '{"type":"FeatureCollection","features":[]}';
const ok = (url: string) => new Response(url.includes('/alerts/') ? ALERT_TEXT : `{"type":"Feature","properties":{"url":"${url}"}}`);
type Call = { url: string; headers?: Record<string, string> };
const archive = (fetchImpl: (url: string) => Response | Promise<Response>, state: WeatherState = {}, timeoutMs = 10_000, calls: Call[] = []) =>
  new WeatherArchive(state, (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string> }); return fetchImpl(String(url));
  }) as typeof fetch, () => SLOT + 1_000, timeoutMs);
const run = async (a: WeatherArchive, now = SLOT) => {
  const plan = a.prepare(now)!, result = await a.collect(plan);
  return { ...result, plan, saved: result.responses[0] && JSON.parse(new TextDecoder().decode(result.responses[0].bytes)) };
};

describe('National Weather Service data, saved raw once a minute', () => {
  it('covers every listed NJ airport station, the three NYC stations and both forecasts for each grid cell', () => {
    expect(STATIONS).toHaveLength(21);
    expect(STATIONS).toEqual(expect.arrayContaining(['KEWR', 'KTEB', 'KCDW', 'KMMU', 'KNYC', 'KLGA', 'KJFK']));
    expect(ROTATION).toHaveLength(STATIONS.length + 2 * Object.keys(GRIDPOINTS).length);
    expect(new Set(ROTATION.map(i => i.url)).size).toBe(ROTATION.length);
    expect(ALERTS.url).toBe('https://api.weather.gov/alerts/active?area=NJ,NY');
  });
  it('takes one reading per minute slot and never refetches an earlier slot', () => {
    const state: WeatherState = {}, a = archive(ok, state);
    expect(a.prepare(SLOT + 59_999)?.slot).toBe(SLOT);
    expect(a.prepare(SLOT + 30_000)).toBeUndefined();
    expect(a.prepare(SLOT + 60_000)?.slot).toBe(SLOT + 60_000);
    expect(a.prepare(SLOT)).toBeUndefined();
    expect(state.slot).toBe(SLOT + 60_000);
  });
  it('asks for the alerts every minute and walks the stations and forecasts in turn, every one within 15 minutes', () => {
    const state: WeatherState = {}, a = archive(ok, state), seen = new Set<string>();
    const minutes = Math.ceil(ROTATION.length / ROTATION_PER_MINUTE);
    expect(minutes).toBeLessThanOrEqual(15);
    for (let m = 0; m < minutes; m++) {
      const plan = a.prepare(SLOT + m * 60_000)!;
      expect(plan.items[0]).toBe(ALERTS);
      expect(plan.items).toHaveLength(1 + ROTATION_PER_MINUTE);
      plan.items.slice(1).forEach(i => seen.add(i.url));
    }
    expect(seen.size).toBe(ROTATION.length);
  });
  it('a skipped minute never skips a station: the turn moves only when a slot is taken', () => {
    const a = archive(ok);
    const first = a.prepare(SLOT)!, later = a.prepare(SLOT + 10 * 60_000)!;
    expect(later.items[1]).toBe(ROTATION[ROTATION_PER_MINUTE]);
    expect(first.items[1]).toBe(ROTATION[0]);
  });
  it('keeps each answer exactly as sent, and identifies Dale to NWS as it asks', async () => {
    const calls: Call[] = [];
    const { saved, failures } = await run(archive(ok, {}, 10_000, calls));
    expect(failures).toEqual([]);
    expect(saved).toMatchObject({ v: 1, source: 'api.weather.gov', slot: '2026-11-26T22:15Z' });
    expect(saved.responses[0]).toMatchObject({ kind: 'alerts', status: 'ok', text: ALERT_TEXT });
    expect(saved.responses[1]).toMatchObject({ kind: 'observation', id: 'KACY', status: 'ok' });
    expect(JSON.parse(saved.responses[1].text).properties.url).toBe('https://api.weather.gov/stations/KACY/observations/latest');
    expect(calls).toHaveLength(4);
    for (const c of calls) expect(c.headers?.['user-agent']).toMatch(/^Dale transit app/);
  });
  it('reads an answer that starts with a byte-order mark and saves it exactly as sent', async () => {
    const withBom = '\uFEFF' + ALERT_TEXT;
    const { saved, failures } = await run(archive(url => url.includes('/alerts/') ? new Response(withBom) : ok(url)));
    expect(failures).toEqual([]); expect(saved.responses[0].text).toBe(withBom);
  });
  it.each([
    ['an error page', () => new Response('<html>Service unavailable</html>'), 'invalid-response'],
    ['JSON that is not GeoJSON', () => Response.json({ hello: 1 }), 'invalid-response'],
    ['a list', () => Response.json([]), 'invalid-response'],
    ['a server error', () => new Response('{"status":500}', { status: 500 }), 'http-error'],
    ['a redirect', () => new Response(null, { status: 301, headers: { location: 'https://example.invalid/' } }), 'redirect-refused'],
    ['rate limiting', () => new Response('', { status: 429 }), 'rate-limited'],
  ])('refuses %s from one source without saving its text, and still saves the rest', async (_, bad, code) => {
    const { saved, failures } = await run(archive(url => url.includes('/alerts/') ? bad() : ok(url)));
    expect(failures).toEqual([{ feed: 'nws-alerts', code, at: SLOT + 1_000 }]);
    expect(saved.responses[0]).toEqual({ kind: 'alerts', id: 'NJ,NY', url: ALERTS.url, receivedAt: SLOT + 1_000, status: code });
    expect(saved.responses.slice(1).every((r: { status: string }) => r.status === 'ok')).toBe(true);
  });
  it('shares the crossings\' turn budget: nothing starts 12 seconds after the start it is given', async () => {
    const urls: string[] = [];
    const a = archive(url => { urls.push(url); return ok(url); });
    const plan = a.prepare(SLOT)!, result = await a.collect(plan, SLOT + 1_000 - 12_000);
    expect(urls).toHaveLength(0); expect(result.responses).toEqual([]);
    expect(result.failures.map(f => f.code)).toEqual(['timed-out', 'timed-out', 'timed-out', 'timed-out']);
  });
  it('times out a hung station and moves on', async () => {
    const { saved, failures } = await run(archive(url => url.includes('KACY') ? new Promise<Response>(() => {}) : ok(url), {}, 20));
    expect(failures).toEqual([{ feed: 'nws-observation', code: 'timed-out', at: SLOT + 1_000 }]);
    expect(saved.responses.map((r: { status: string }) => r.status)).toEqual(['ok', 'timed-out', 'ok', 'ok']);
  });
  it('saves nothing when every source fails, and fetches one at a time', async () => {
    let open = 0, most = 0;
    const { responses, failures } = await run(archive(async () => {
      most = Math.max(most, ++open); await new Promise(r => setTimeout(r, 1)); open--; throw new TypeError('offline');
    }));
    expect(responses).toEqual([]);
    expect(failures.map(f => f.code)).toEqual(['network-error', 'network-error', 'network-error', 'network-error']);
    expect(most).toBe(1);
  });
});
