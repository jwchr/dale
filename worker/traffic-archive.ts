import { NjtError, safeNjtFailure } from './njt-client';
import type { RawFeed, RawResponse } from './raw-archive';

/** D84 and Jeff, Nov 24 and 26, 2026 ("I want to start logging that data too, port authority crossings";
 *  "P0 recording all data sources!! ... 511 data, port authority ... everything!!"): the Port Authority's
 *  crossing times, posted crossing alerts, bridge/tunnel and bus terminal incidents and PATH arrivals and
 *  alerts, NJ Transit's advisory RSS and 511NJ's (NJDOT) event feeds, saved privately whether or not anyone
 *  looks. All are free public government feeds with no account (checked Nov 26, 2026); none keep history. */
const MINUTE = 60_000, MAX_BYTES = 4 * 1024 * 1024;
export const TRAFFIC_TIMEOUT_MS = 10_000;
/** A slow site must not hold the poll: no new request starts after this much of one minute's turn. */
export const TRAFFIC_LANE_MS = 25_000;
const PANYNJ = 'https://www.panynj.gov/bin/portauthority/', NJT = 'https://www.njtransit.com/rss/', NJ511 = 'https://511nj.org/client/rest/rss/';
/** Eastern calendar date as MM/DD/YYYY, the alerts feed's own date format. */
export const easternDate = (at: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric' }).format(at);
/** The Port Authority's alert feeds name the staff member who posted each alert. Dale keeps no personal
 *  data, so that one field is removed before saving and the bundle says so; the rest is kept as sent. */
const STAFF = ['SentBy'];
/** rss: an RSS document. array: a JSON list of records. object: a JSON object holding a list under `list`. */
type Shape = { kind: 'rss' } | { kind: 'array'; drop?: string[] } | { kind: 'object'; list: string };
interface Source { feed: RawFeed; url: (at: number) => string; shape: Shape; every?: number; offset?: number }
const rss: Shape = { kind: 'rss' };
/** In priority order. `every` is in minutes (default 1); `offset` spreads the slower feeds over the minutes,
 *  so a minute's turn is at most 7 every-minute requests plus 2 or 3 slower ones. */
export const TRAFFIC_SOURCES = {
  crossingTimes: { feed: 'panynj-crossingTimes', url: () => `${PANYNJ}crossingtimesapi.json`, shape: { kind: 'array' } },
  crossingAlerts: { feed: 'panynj-crossingAlerts', url: at => `${PANYNJ}crossingtimesalertapi.json?start_date=${encodeURIComponent(easternDate(at))}`, shape: { kind: 'array', drop: STAFF } },
  incidents: { feed: '511nj-events', url: () => `${NJ511}RSSAllNJActiveEvents`, shape: rss },
  crossingIncidents: { feed: 'panynj-incidents', url: () => `${PANYNJ}everbridge/incidents?status=All&department=BTT`, shape: { kind: 'object', list: 'data' } },
  terminalIncidents: { feed: 'panynj-incidents', url: () => `${PANYNJ}everbridge/incidents?status=All&department=PABT`, shape: { kind: 'object', list: 'data' } },
  pathArrivals: { feed: 'panynj-path', url: () => `${PANYNJ}ridepath.json`, shape: { kind: 'object', list: 'results' } },
  pathAlerts: { feed: 'panynj-path', url: () => `${PANYNJ}alerts?agency=PATH`, shape: { kind: 'array', drop: STAFF } },
  njtBusAdvisories: { feed: 'njt-rss', url: () => `${NJT}BusAdvisories_feed.xml`, shape: rss, every: 5, offset: 0 },
  njtRailAdvisories: { feed: 'njt-rss', url: () => `${NJT}RailAdvisories_feed.xml`, shape: rss, every: 5, offset: 1 },
  njtLightRailAdvisories: { feed: 'njt-rss', url: () => `${NJT}LightRailAdvisories_feed.xml`, shape: rss, every: 5, offset: 2 },
  njtCustomerNotices: { feed: 'njt-rss', url: () => `${NJT}CustomerNotices_feed.xml`, shape: rss, every: 5, offset: 3 },
  // 511NJ's narrower feeds repeat the All-NJ items, but add the New York, Connecticut and Madison Square Garden ones.
  activeIncidents: { feed: '511nj-events', url: () => `${NJ511}RSSActiveIncidents`, shape: rss, every: 5, offset: 4 },
  activeCongestion: { feed: '511nj-events', url: () => `${NJ511}RSSActiveCongestion`, shape: rss, every: 5, offset: 0 },
  activeConstruction: { feed: '511nj-events', url: () => `${NJ511}RSSActiveConstruction`, shape: rss, every: 5, offset: 1 },
  activeWeather: { feed: '511nj-events', url: () => `${NJ511}RSSActiveWeather`, shape: rss, every: 5, offset: 2 },
  activeSpecialEvents: { feed: '511nj-events', url: () => `${NJ511}RSSActiveSpecialEvents`, shape: rss, every: 5, offset: 3 },
  plannedEvents: { feed: '511nj-events', url: () => `${NJ511}RSSPlannedConstructionAndSpecialEvents`, shape: rss, every: 15, offset: 4 },
} satisfies Record<string, Source>;
type SourceName = keyof typeof TRAFFIC_SOURCES;
/** Sources due in a minute slot, in priority order. */
export const dueSources = (slot: number): SourceName[] => (Object.keys(TRAFFIC_SOURCES) as SourceName[]).filter(name => {
  const { every = 1, offset = 0 } = TRAFFIC_SOURCES[name] as Source, minute = Math.floor(slot / MINUTE);
  return ((minute - offset) % every + every) % every === 0;
});

export interface TrafficState { slot?: number }
interface Entry { source: SourceName; url: string; receivedAt: number; status: 'ok' | string; text?: string; dropped?: string[] }

export async function boundedGet(url: string, fetchImpl: typeof fetch, timeoutMs: number, headers?: Record<string, string>): Promise<Uint8Array<ArrayBuffer>> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async () => {
    const response = await fetchImpl(url, { redirect: 'manual', cache: 'no-store', signal: ctl.signal, ...(headers && { headers }) });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new NjtError(response.status >= 300 && response.status < 400 ? 'redirect-refused'
        : response.status === 401 || response.status === 403 ? 'access-denied' : response.status === 429 ? 'rate-limited' : 'http-error');
    }
    if (!response.body) throw new NjtError('empty-response');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { void reader.cancel().catch(() => {}); throw new NjtError('response-too-large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (!size) throw new NjtError('empty-response');
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return bytes;
  };
  try {
    // The race also bounds injected fetches or readers that ignore AbortSignal.
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { ctl.abort(); reject(new NjtError('timed-out')); }, timeoutMs);
    })]);
  } catch (error) {
    throw error instanceof NjtError ? error : new NjtError(ctl.signal.aborted ? 'timed-out' : 'network-error');
  } finally { clearTimeout(timer); ctl.abort(); }
}

/** Exact text for the expected shape, or a fixed failure code. Error pages are never saved as data. */
/** JSON.parse refuses a leading byte-order mark, which some servers send. The saved text keeps it as sent. */
export const withoutBom = (text: string) => text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
function accept(shape: Shape, bytes: Uint8Array): Pick<Entry, 'text' | 'dropped'> {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new NjtError('invalid-response'); }
  if (shape.kind === 'rss') {
    if (!/^\s*(<\?xml[^>]*>\s*)?<rss[\s>]/.test(text)) throw new NjtError('invalid-response');
    return { text };
  }
  let value: unknown;
  try { value = JSON.parse(withoutBom(text)); } catch { throw new NjtError('invalid-response'); }
  if (shape.kind === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>)[shape.list])) throw new NjtError('invalid-response');
    return { text };
  }
  if (!Array.isArray(value)) throw new NjtError('invalid-response');
  if (!shape.drop) return { text };
  // The same records, minus the staff name. Unparseable records are refused, never saved raw.
  // The name is removed at any depth and in any letter case, so a renamed or nested copy is never saved either.
  const drop = shape.drop, names = new Set(drop.map(key => key.toLowerCase()));
  if (value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new NjtError('invalid-response');
  const strip = (v: unknown): unknown => Array.isArray(v) ? v.map(strip)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([key]) => !names.has(key.toLowerCase())).map(([key, x]) => [key, strip(x)]))
    : v;
  return { text: JSON.stringify(value.map(strip)), dropped: drop };
}

export class TrafficArchive {
  constructor(private state: TrafficState, private fetchImpl: typeof fetch = fetch, private clock = Date.now, private timeoutMs = TRAFFIC_TIMEOUT_MS, private laneMs = TRAFFIC_LANE_MS) {}

  /** One reading per UTC minute slot, from the slot's start, never from when a poll happens to run.
   *  The caller persists the state before any I/O, so an eviction or retry never fetches a slot twice. */
  prepare(now: number): number | undefined {
    const slot = Math.floor(now / MINUTE) * MINUTE;
    if (this.state.slot !== undefined && this.state.slot >= slot) return;
    this.state.slot = slot;
    return slot;
  }

  /** One request at a time: it runs after the rail feeds, beside RailData and BUSDV2's two each,
   *  so a Worker's 6 connections never queue these behind other fetches. */
  async collect(slot: number): Promise<{ responses: RawResponse[]; failures: { feed: RawFeed; code: string; at: number }[]; secrets: string[] }> {
    const entries: Entry[] = [], failures: { feed: RawFeed; code: string; at: number }[] = [];
    const started = this.clock();
    for (const source of dueSources(slot)) {
      const { feed, url: build, shape } = TRAFFIC_SOURCES[source] as Source, url = build(slot);
      try {
        if (this.clock() - started >= this.laneMs) throw new NjtError('timed-out');
        const bytes = await boundedGet(url, this.fetchImpl, this.timeoutMs);
        entries.push({ source, url, receivedAt: this.clock(), status: 'ok', ...accept(shape, bytes) });
      } catch (error) {
        const code = safeNjtFailure(error), at = this.clock();
        failures.push({ feed, code, at });
        entries.push({ source, url, receivedAt: at, status: code });
      }
    }
    // One saved object per minute for all of them keeps R2 operations low; failures stay inside as fixed codes.
    if (!entries.some(e => e.status === 'ok')) return { responses: [], failures, secrets: [] };
    const bundle = { v: 1, slot: new Date(slot).toISOString().slice(0, 16) + 'Z', responses: entries };
    const receivedAt = Math.max(...entries.map(e => e.receivedAt));
    return { responses: [{ feed: 'traffic-poll', receivedAt, bytes: new TextEncoder().encode(JSON.stringify(bundle)) as Uint8Array<ArrayBuffer> }], failures, secrets: [] };
  }
}
