import { describe, expect, it } from 'vitest';
import { TRAFFIC_SOURCES, TrafficArchive, dueSources, easternDate, type TrafficState } from '../../worker/traffic-archive';

// 22:15 UTC is a quarter hour: the every-minute feeds plus the two five-minute feeds with offset 0 are due.
const SLOT = Date.UTC(2026, 10, 26, 22, 15);
const RSS = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>synthetic</title></channel></rss>';
const EVERBRIDGE = '{"status":"Success","data":[{"incidentMessage":{"subject":"synthetic"},"CreatedDate":1}]}';
const ok = (url: string): Response =>
  url.includes('511nj.org') || url.includes('njtransit.com/rss') ? new Response(RSS)
  : url.includes('everbridge') ? new Response(EVERBRIDGE)
  : url.includes('ridepath.json') ? new Response('{"results":[]}')
  : url.includes('alerts?agency=PATH') ? Response.json([{ messageid: 2, Subject: 'synthetic path', SentBy: 'Synthetic Staff' }])
  : url.includes('alert') ? Response.json([{ messageid: 1, Subject: 'synthetic', SentBy: 'Synthetic Staff' }])
  : Response.json([{ routeTravelTime: 7 }]);
const archive = (fetchImpl: (url: string) => Response | Promise<Response>, state: TrafficState = {}, timeoutMs = 10_000, clock = () => SLOT + 1_000) =>
  new TrafficArchive(state, (async (url: RequestInfo | URL) => fetchImpl(String(url))) as typeof fetch, clock, timeoutMs);
const bundle = async (a: TrafficArchive, slot = SLOT) => {
  const result = await a.collect(slot);
  return { ...result, saved: result.responses[0] && JSON.parse(new TextDecoder().decode(result.responses[0].bytes)) };
};
const DUE = dueSources(SLOT), EVERY_MINUTE = 7;
const status = (saved: { responses: { source: string; status: string }[] }, source: string) => saved.responses.find(r => r.source === source)?.status;

describe('Port Authority, PATH, NJ Transit advisories and 511NJ, saved raw once a minute', () => {
  it('takes one reading per UTC minute slot, from the slot start', () => {
    const state: TrafficState = {}, a = archive(ok, state);
    expect(a.prepare(SLOT + 59_999)).toBe(SLOT);
    expect(a.prepare(SLOT + 30_000)).toBeUndefined();
    expect(a.prepare(SLOT + 60_000)).toBe(SLOT + 60_000);
    // A clock that steps back never refetches an earlier slot.
    expect(a.prepare(SLOT)).toBeUndefined();
    expect(state.slot).toBe(SLOT + 60_000);
  });
  it('asks for the live feeds every minute and spreads the slower ones, each on its own cadence', () => {
    expect(DUE).toEqual(['crossingTimes', 'crossingAlerts', 'incidents', 'crossingIncidents', 'terminalIncidents', 'pathArrivals', 'pathAlerts', 'njtBusAdvisories', 'activeCongestion']);
    const seen = new Map<string, number>();
    for (let m = 0; m < 15; m++) {
      const due = dueSources(SLOT + m * 60_000);
      expect(due.length).toBeLessThanOrEqual(EVERY_MINUTE + 3);
      expect(due.slice(0, EVERY_MINUTE)).toEqual(DUE.slice(0, EVERY_MINUTE));
      for (const name of due) seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    for (const name of Object.keys(TRAFFIC_SOURCES) as (keyof typeof TRAFFIC_SOURCES)[]) {
      const { every = 1 } = TRAFFIC_SOURCES[name] as { every?: number };
      expect([name, seen.get(name)]).toEqual([name, 15 / every]);
    }
    expect(new Set(Object.values(TRAFFIC_SOURCES).map(s => s.url(SLOT))).size).toBe(Object.keys(TRAFFIC_SOURCES).length);
  });
  it('keeps every answer exactly as sent, and drops only the staff name from both alert feeds', async () => {
    const { saved, failures } = await bundle(archive(ok));
    expect(failures).toEqual([]);
    expect(saved.slot).toBe('2026-11-26T22:15Z');
    expect(saved.responses.map((r: { source: string }) => r.source)).toEqual(DUE);
    expect(saved.responses[0]).toMatchObject({ source: 'crossingTimes', status: 'ok', text: '[{"routeTravelTime":7}]', url: 'https://www.panynj.gov/bin/portauthority/crossingtimesapi.json' });
    expect(saved.responses[1]).toMatchObject({ source: 'crossingAlerts', status: 'ok', dropped: ['SentBy'] });
    expect(saved.responses[1].url).toContain('start_date=11%2F26%2F2026');
    expect(JSON.parse(saved.responses[1].text)).toEqual([{ messageid: 1, Subject: 'synthetic' }]);
    expect(saved.responses[2]).toMatchObject({ source: 'incidents', status: 'ok', text: RSS });
    expect(saved.responses[3]).toMatchObject({ source: 'crossingIncidents', status: 'ok', text: EVERBRIDGE });
    expect(saved.responses[3].dropped).toBeUndefined();
    expect(saved.responses[6]).toMatchObject({ source: 'pathAlerts', status: 'ok', dropped: ['SentBy'] });
    expect(JSON.parse(saved.responses[6].text)).toEqual([{ messageid: 2, Subject: 'synthetic path' }]);
    expect(saved.responses[7]).toMatchObject({ source: 'njtBusAdvisories', status: 'ok', text: RSS, url: 'https://www.njtransit.com/rss/BusAdvisories_feed.xml' });
    expect(JSON.stringify(saved)).not.toContain('Synthetic Staff');
  });
  it('drops the staff name at any depth and in any letter case', async () => {
    const nested = [{ messageid: 1, sentby: 'Synthetic Staff', detail: { SENTBY: 'Synthetic Staff', notes: [{ SentBy: 'Synthetic Staff', note: 'kept' }] } }];
    const { saved } = await bundle(archive(url => url.includes('crossingtimesalert') ? Response.json(nested) : ok(url)));
    expect(JSON.parse(saved.responses[1].text)).toEqual([{ messageid: 1, detail: { notes: [{ note: 'kept' }] } }]);
    expect(JSON.stringify(saved)).not.toContain('Synthetic Staff');
  });
  it('reads JSON that starts with a byte-order mark and saves it exactly as sent', async () => {
    const withBom = '\uFEFF[{"routeTravelTime":7}]', everbridge = '\uFEFF' + EVERBRIDGE;
    const { saved, failures } = await bundle(archive(url => url.includes('crossingtimesapi') ? new Response(withBom)
      : url.includes('everbridge') ? new Response(everbridge) : ok(url)));
    expect(failures).toEqual([]);
    expect(saved.responses[0].text).toBe(withBom); expect(saved.responses[3].text).toBe(everbridge);
  });
  it('uses the Eastern date for alerts, not the UTC date', () => {
    expect(easternDate(Date.UTC(2026, 10, 27, 3, 0))).toBe('11/26/2026');
    expect(easternDate(Date.UTC(2026, 10, 27, 5, 0))).toBe('11/27/2026');
  });
  it('records a failed source by fixed code and still saves the others', async () => {
    const { saved, failures } = await bundle(archive(url => url.includes('RSSAllNJ') ? new Response('', { status: 503 }) : ok(url)));
    expect(failures).toEqual([{ feed: '511nj-events', code: 'http-error', at: SLOT + 1_000 }]);
    expect(saved.responses.filter((r: { status: string }) => r.status !== 'ok')).toHaveLength(1);
  });
  it.each([
    ['an error page in place of the 511NJ RSS', 'RSSAllNJ', () => new Response('<html>Page not found</html>'), 'incidents', 'invalid-response'],
    ['an error page in place of NJ Transit RSS', 'BusAdvisories', () => new Response('<!DOCTYPE html><html></html>'), 'njtBusAdvisories', 'invalid-response'],
    ['alerts that are not a list of records', 'crossingtimesalert', () => Response.json([{ SentBy: 'x' }, 'Synthetic Staff']), 'crossingAlerts', 'invalid-response'],
    ['PATH alerts that are not a list', 'agency=PATH', () => Response.json({ SentBy: 'Synthetic Staff' }), 'pathAlerts', 'invalid-response'],
    ['crossing times that are not JSON', 'crossingtimesapi', () => new Response('<html></html>'), 'crossingTimes', 'invalid-response'],
    ['incidents without their list', 'department=BTT', () => Response.json({ status: 'Error' }), 'crossingIncidents', 'invalid-response'],
    ['PATH arrivals as a bare list', 'ridepath', () => Response.json([]), 'pathArrivals', 'invalid-response'],
    ['a redirect', 'crossingtimesapi', () => new Response(null, { status: 302, headers: { location: 'https://example.invalid/' } }), 'crossingTimes', 'redirect-refused'],
    ['an empty answer', 'crossingtimesapi', () => new Response(''), 'crossingTimes', 'empty-response'],
  ])('refuses %s without saving its text', async (_, match, bad, source, code) => {
    const { saved, failures } = await bundle(archive(url => url.includes(match) ? bad() : ok(url)));
    expect(failures).toEqual([{ feed: TRAFFIC_SOURCES[source as keyof typeof TRAFFIC_SOURCES].feed, code, at: SLOT + 1_000 }]);
    const entry = saved.responses.find((r: { source: string }) => r.source === source);
    expect(entry.status).toBe(code);
    expect(entry.text).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('Synthetic Staff');
  });
  it('stops reading an oversized answer at 4 MB', async () => {
    let sent = 0;
    const big = () => new Response(new ReadableStream({ pull(c) { if (sent++ < 8) c.enqueue(new Uint8Array(1024 * 1024)); else c.close(); } }));
    const { failures } = await bundle(archive(url => url.includes('RSSAllNJ') ? big() : ok(url)));
    expect(failures).toEqual([{ feed: '511nj-events', code: 'response-too-large', at: SLOT + 1_000 }]);
    expect(sent).toBeLessThanOrEqual(6);
  });
  it('times out a hung source and moves on', async () => {
    const { saved, failures } = await bundle(archive(url => url.includes('crossingtimesapi') ? new Promise<Response>(() => {}) : ok(url), {}, 20));
    expect(failures).toEqual([{ feed: 'panynj-crossingTimes', code: 'timed-out', at: SLOT + 1_000 }]);
    expect(status(saved, 'crossingTimes')).toBe('timed-out');
    expect(status(saved, 'crossingAlerts')).toBe('ok');
  });
  it('starts no new request once 25 seconds of the turn are spent, and keeps what it already has', async () => {
    let now = SLOT + 1_000;
    const urls: string[] = [];
    const a = archive(url => { urls.push(url); if (url.includes('RSSAllNJ')) now += 26_000; return ok(url); }, {}, 10_000, () => now);
    const { saved, failures } = await bundle(a);
    expect(urls).toHaveLength(3);
    expect(saved.responses.slice(0, 3).map((r: { status: string }) => r.status)).toEqual(['ok', 'ok', 'ok']);
    expect(saved.responses.slice(3).every((r: { status: string; text?: string }) => r.status === 'timed-out' && r.text === undefined)).toBe(true);
    expect(failures).toHaveLength(DUE.length - 3);
  });
  it('saves nothing when every source fails, and fetches one at a time', async () => {
    let open = 0, most = 0;
    const { responses, failures } = await bundle(archive(async () => {
      most = Math.max(most, ++open); await new Promise(r => setTimeout(r, 1)); open--; throw new TypeError('offline');
    }));
    expect(responses).toEqual([]);
    expect(failures.map(f => f.code)).toEqual(DUE.map(() => 'network-error'));
    expect(most).toBe(1);
  });
});
