import { describe, expect, it } from 'vitest';
import { TrafficArchive, easternDate, type TrafficState } from '../../worker/traffic-archive';

const SLOT = Date.UTC(2026, 10, 26, 22, 15);
const RSS = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>synthetic</title></channel></rss>';
const ok = (url: string) => url.includes('511nj.org') ? new Response(RSS)
  : url.includes('alert') ? Response.json([{ messageid: 1, Subject: 'synthetic', SentBy: 'Synthetic Staff' }]) : Response.json([{ routeTravelTime: 7 }]);
const archive = (fetchImpl: (url: string) => Response | Promise<Response>, state: TrafficState = {}, timeoutMs = 10_000) =>
  new TrafficArchive(state, (async (url: RequestInfo | URL) => fetchImpl(String(url))) as typeof fetch, () => SLOT + 1_000, timeoutMs);
const bundle = async (a: TrafficArchive) => {
  const result = await a.collect(SLOT);
  return { ...result, saved: result.responses[0] && JSON.parse(new TextDecoder().decode(result.responses[0].bytes)) };
};

describe('Port Authority crossings and 511NJ incidents, saved raw once a minute', () => {
  it('takes one reading per UTC minute slot, from the slot start', () => {
    const state: TrafficState = {}, a = archive(ok, state);
    expect(a.prepare(SLOT + 59_999)).toBe(SLOT);
    expect(a.prepare(SLOT + 30_000)).toBeUndefined();
    expect(a.prepare(SLOT + 60_000)).toBe(SLOT + 60_000);
    // A clock that steps back never refetches an earlier slot.
    expect(a.prepare(SLOT)).toBeUndefined();
    expect(state.slot).toBe(SLOT + 60_000);
  });
  it('keeps crossing times and incidents exactly as sent, and drops only the staff name from alerts', async () => {
    const { saved, failures } = await bundle(archive(ok));
    expect(failures).toEqual([]);
    expect(saved.slot).toBe('2026-11-26T22:15Z');
    expect(saved.responses[0]).toMatchObject({ source: 'crossingTimes', status: 'ok', text: '[{"routeTravelTime":7}]', url: 'https://www.panynj.gov/bin/portauthority/crossingtimesapi.json' });
    expect(saved.responses[1]).toMatchObject({ source: 'crossingAlerts', status: 'ok', dropped: ['SentBy'] });
    expect(saved.responses[1].url).toContain('start_date=11%2F26%2F2026');
    expect(JSON.parse(saved.responses[1].text)).toEqual([{ messageid: 1, Subject: 'synthetic' }]);
    expect(saved.responses[2]).toMatchObject({ source: 'incidents', status: 'ok', text: RSS });
    expect(JSON.stringify(saved)).not.toContain('Synthetic Staff');
  });
  it('uses the Eastern date for alerts, not the UTC date', () => {
    expect(easternDate(Date.UTC(2026, 10, 27, 3, 0))).toBe('11/26/2026');
    expect(easternDate(Date.UTC(2026, 10, 27, 5, 0))).toBe('11/27/2026');
  });
  it('records a failed source by fixed code and still saves the others', async () => {
    const { saved, failures } = await bundle(archive(url => url.includes('511nj') ? new Response('', { status: 503 }) : ok(url)));
    expect(failures).toEqual([{ feed: '511nj-events', code: 'http-error', at: SLOT + 1_000 }]);
    expect(saved.responses.map((r: { status: string }) => r.status)).toEqual(['ok', 'ok', 'http-error']);
  });
  it.each([
    ['an error page in place of the RSS', (url: string) => url.includes('511nj') ? new Response('<html>Page not found</html>') : ok(url), '511nj-events', 'invalid-response'],
    ['alerts that are not a list of records', (url: string) => url.includes('alert') ? Response.json([{ SentBy: 'x' }, 'Synthetic Staff']) : ok(url), 'panynj-crossingAlerts', 'invalid-response'],
    ['crossing times that are not JSON', (url: string) => url.includes('crossingtimesapi') ? new Response('<html></html>') : ok(url), 'panynj-crossingTimes', 'invalid-response'],
    ['a redirect', (url: string) => url.includes('crossingtimesapi') ? new Response(null, { status: 302, headers: { location: 'https://example.invalid/' } }) : ok(url), 'panynj-crossingTimes', 'redirect-refused'],
    ['an empty answer', (url: string) => url.includes('crossingtimesapi') ? new Response('') : ok(url), 'panynj-crossingTimes', 'empty-response'],
  ])('refuses %s without saving its text', async (_, fetchImpl, feed, code) => {
    const { saved, failures } = await bundle(archive(fetchImpl));
    expect(failures).toEqual([{ feed, code, at: SLOT + 1_000 }]);
    const entry = saved.responses.find((r: { status: string }) => r.status === code);
    expect(entry.text).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('Synthetic Staff');
  });
  it('stops reading an oversized answer at 4 MB', async () => {
    let sent = 0;
    const big = () => new Response(new ReadableStream({ pull(c) { if (sent++ < 8) c.enqueue(new Uint8Array(1024 * 1024)); else c.close(); } }));
    const { failures } = await bundle(archive(url => url.includes('511nj') ? big() : ok(url)));
    expect(failures).toEqual([{ feed: '511nj-events', code: 'response-too-large', at: SLOT + 1_000 }]);
    expect(sent).toBeLessThanOrEqual(6);
  });
  it('times out a hung source and moves on', async () => {
    const { saved, failures } = await bundle(archive(url => url.includes('crossingtimesapi') ? new Promise<Response>(() => {}) : ok(url), {}, 20));
    expect(failures).toEqual([{ feed: 'panynj-crossingTimes', code: 'timed-out', at: SLOT + 1_000 }]);
    expect(saved.responses.map((r: { status: string }) => r.status)).toEqual(['timed-out', 'ok', 'ok']);
  });
  it('saves nothing when every source fails, and fetches one at a time', async () => {
    let open = 0, most = 0;
    const { responses, failures } = await bundle(archive(async () => {
      most = Math.max(most, ++open); await new Promise(r => setTimeout(r, 1)); open--; throw new TypeError('offline');
    }));
    expect(responses).toEqual([]);
    expect(failures.map(f => f.code)).toEqual(['network-error', 'network-error', 'network-error']);
    expect(most).toBe(1);
  });
});
