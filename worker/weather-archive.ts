import { NjtError, safeNjtFailure } from './njt-client';
import type { RawFeed, RawResponse } from './raw-archive';
import { ARCHIVE_START_MS, ARCHIVE_TURN_MS } from './pool';
import { boundedGet, withoutBom } from './traffic-archive';

/** D84 and Jeff, Nov 26, 2026 ("P0 recording all data sources!! ... weather.. everything!!"):
 *  National Weather Service data for New Jersey and New York City, saved privately whether or not
 *  anyone looks. api.weather.gov is the primary government source, free, no account; it asks only
 *  for a User-Agent that identifies the app (checked Nov 26, 2026). NWS keeps no history of its
 *  active alerts or latest observations, so a reading not saved is gone. */
const MINUTE = 60_000, NWS = 'https://api.weather.gov';
export const WEATHER_TIMEOUT_MS = 10_000;
/** Rotating requests per minute, after the alerts. 3 keeps NWS calls at 4 a minute. */
export const ROTATION_PER_MINUTE = 3;
const HEADERS = { 'user-agent': 'Dale transit app (github.com/jwchr/dale)', accept: 'application/geo+json' };

/** Every NJ airport weather station (ASOS) NWS lists for the state, plus the three in New York City. */
export const STATIONS = ['KACY', 'KBLM', 'KCDW', 'KEWR', 'KFWN', 'KLDJ', 'KMIV', 'KMJX', 'KMMU', 'KN40', 'KOBI', 'KSMQ', 'KTEB',
  'KTTN', 'KVAY', 'KWRI', 'KWWD', 'K12N', 'KNYC', 'KLGA', 'KJFK'];
/** NWS forecast grid cells across the state and Midtown, looked up from /points on Nov 26, 2026. */
export const GRIDPOINTS: Record<string, string> = {
  midtown: 'OKX/33,44', hackensack: 'OKX/31,50', paterson: 'OKX/26,50', newark: 'OKX/27,42', jerseyCity: 'OKX/31,42',
  morristown: 'PHI/67,120', newBrunswick: 'PHI/71,106', trenton: 'PHI/62,93', tomsRiver: 'PHI/83,84',
  atlanticCity: 'PHI/79,56', camden: 'PHI/51,78', newton: 'PHI/56,131',
};
type Kind = 'alerts' | 'observation' | 'forecastHourly' | 'gridData';
interface Item { kind: Kind; id: string; feed: RawFeed; url: string }
export const ALERTS: Item = { kind: 'alerts', id: 'NJ,NY', feed: 'nws-alerts', url: `${NWS}/alerts/active?area=NJ,NY` };
export const ROTATION: Item[] = [
  ...STATIONS.map(id => ({ kind: 'observation' as const, id, feed: 'nws-observation' as const, url: `${NWS}/stations/${id}/observations/latest` })),
  ...Object.entries(GRIDPOINTS).flatMap(([id, cell]) => [
    { kind: 'forecastHourly' as const, id, feed: 'nws-forecast' as const, url: `${NWS}/gridpoints/${cell}/forecast/hourly` },
    { kind: 'gridData' as const, id, feed: 'nws-forecast' as const, url: `${NWS}/gridpoints/${cell}` },
  ]),
];

export interface WeatherState { slot?: number; cursor?: number }
interface Entry { kind: Kind; id: string; url: string; receivedAt: number; status: 'ok' | string; text?: string }

/** Exact text of a GeoJSON answer, or a fixed failure code. Error pages are never saved as data. */
function accept(bytes: Uint8Array): string {
  let text: string, value: unknown;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); value = JSON.parse(withoutBom(text)); }
  catch { throw new NjtError('invalid-response'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('features' in value || 'properties' in value)) throw new NjtError('invalid-response');
  return text;
}

export class WeatherArchive {
  constructor(private state: WeatherState, private fetchImpl: typeof fetch = fetch, private clock = Date.now, private timeoutMs = WEATHER_TIMEOUT_MS) {}

  /** One reading per UTC minute slot, never twice; the caller persists the state before any I/O.
   *  Returns the requests for this slot: the alerts, then the next stations and forecasts in turn.
   *  The turn advances only when a slot is taken, so a skipped minute never skips a station. */
  prepare(now: number): { slot: number; items: Item[] } | undefined {
    const slot = Math.floor(now / MINUTE) * MINUTE;
    if (this.state.slot !== undefined && this.state.slot >= slot) return;
    const start = (this.state.cursor ?? 0) % ROTATION.length;
    const items = [ALERTS, ...Array.from({ length: ROTATION_PER_MINUTE }, (_, i) => ROTATION[(start + i) % ROTATION.length]!)];
    this.state.slot = slot;
    this.state.cursor = (start + ROTATION_PER_MINUTE) % ROTATION.length;
    return { slot, items };
  }

  /** One request at a time, after the crossings, so it never adds a connection beside them. `started` is
   *  the crossings' own start, so both together keep the shared turn budget (Neon on #307). */
  async collect(plan: { slot: number; items: Item[] }, started = this.clock()): Promise<{ responses: RawResponse[]; failures: { feed: RawFeed; code: string; at: number }[]; secrets: string[] }> {
    const entries: Entry[] = [], failures: { feed: RawFeed; code: string; at: number }[] = [];
    for (const { kind, id, feed, url } of plan.items) {
      try {
        const elapsed = this.clock() - started;
        if (elapsed >= ARCHIVE_START_MS) throw new NjtError('timed-out');
        const text = accept(await boundedGet(url, this.fetchImpl, Math.min(this.timeoutMs, ARCHIVE_TURN_MS - elapsed), HEADERS));
        entries.push({ kind, id, url, receivedAt: this.clock(), status: 'ok', text });
      } catch (error) {
        const code = safeNjtFailure(error), at = this.clock();
        failures.push({ feed, code, at });
        entries.push({ kind, id, url, receivedAt: at, status: code });
      }
    }
    if (!entries.some(e => e.status === 'ok')) return { responses: [], failures, secrets: [] };
    const bundle = { v: 1, source: 'api.weather.gov', slot: new Date(plan.slot).toISOString().slice(0, 16) + 'Z', responses: entries };
    const receivedAt = Math.max(...entries.map(e => e.receivedAt));
    return { responses: [{ feed: 'weather-poll', receivedAt, bytes: new TextEncoder().encode(JSON.stringify(bundle)) as Uint8Array<ArrayBuffer> }], failures, secrets: [] };
  }
}
