import { NjtError, safeNjtFailure } from './njt-client';
import type { RawFeed, RawResponse } from './raw-archive';

/** D84 and Jeff, Nov 24, 2026 ("I want to start logging that data too, port authority crossings"):
 *  the Port Authority's crossing times and posted crossing alerts, and 511NJ's statewide incident
 *  feed (NJDOT), saved privately once a minute, the feeds' own refresh, whether or not anyone looks.
 *  All three are free public government feeds with no account (checked Nov 26, 2026). */
const MINUTE = 60_000, MAX_BYTES = 4 * 1024 * 1024;
export const TRAFFIC_TIMEOUT_MS = 10_000;
type Source = 'crossingTimes' | 'crossingAlerts' | 'incidents';
const PANYNJ = 'https://www.panynj.gov/bin/portauthority/';
/** Eastern calendar date as MM/DD/YYYY, the alerts feed's own date format. */
export const easternDate = (at: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric' }).format(at);
export const TRAFFIC_SOURCES: Record<Source, { feed: RawFeed; url: (at: number) => string }> = {
  crossingTimes: { feed: 'panynj-crossingTimes', url: () => `${PANYNJ}crossingtimesapi.json` },
  crossingAlerts: { feed: 'panynj-crossingAlerts', url: at => `${PANYNJ}crossingtimesalertapi.json?start_date=${encodeURIComponent(easternDate(at))}` },
  incidents: { feed: '511nj-events', url: () => 'https://511nj.org/client/rest/rss/RSSAllNJActiveEvents' },
};
/** The alerts feed names the staff member who posted each alert. Dale keeps no personal data, so that
 *  one field is removed before saving and the bundle says so; every other field is kept as sent. */
const DROPPED_ALERT_FIELDS = ['SentBy'];

export interface TrafficState { slot?: number }
interface Entry { source: Source; url: string; receivedAt: number; status: 'ok' | string; text?: string; dropped?: string[] }

async function boundedGet(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Uint8Array<ArrayBuffer>> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async () => {
    const response = await fetchImpl(url, { redirect: 'manual', cache: 'no-store', signal: ctl.signal });
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
function accept(source: Source, bytes: Uint8Array): Pick<Entry, 'text' | 'dropped'> {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new NjtError('invalid-response'); }
  if (source === 'incidents') {
    if (!/^\s*(<\?xml[^>]*>\s*)?<rss[\s>]/.test(text)) throw new NjtError('invalid-response');
    return { text };
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new NjtError('invalid-response'); }
  if (!Array.isArray(value)) throw new NjtError('invalid-response');
  if (source === 'crossingTimes') return { text };
  // Alerts: the same records, minus the staff name. Unparseable records are refused, never saved raw.
  if (value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new NjtError('invalid-response');
  const cleaned = value.map(row => Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([key]) => !DROPPED_ALERT_FIELDS.includes(key))));
  return { text: JSON.stringify(cleaned), dropped: DROPPED_ALERT_FIELDS };
}

export class TrafficArchive {
  constructor(private state: TrafficState, private fetchImpl: typeof fetch = fetch, private clock = Date.now, private timeoutMs = TRAFFIC_TIMEOUT_MS) {}

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
    for (const source of Object.keys(TRAFFIC_SOURCES) as Source[]) {
      const { feed, url: build } = TRAFFIC_SOURCES[source], url = build(slot);
      try {
        const bytes = await boundedGet(url, this.fetchImpl, this.timeoutMs);
        entries.push({ source, url, receivedAt: this.clock(), status: 'ok', ...accept(source, bytes) });
      } catch (error) {
        const code = safeNjtFailure(error), at = this.clock();
        failures.push({ feed, code, at });
        entries.push({ source, url, receivedAt: at, status: code });
      }
    }
    // One saved object per minute for all three keeps R2 operations low; failures stay inside as fixed codes.
    if (!entries.some(e => e.status === 'ok')) return { responses: [], failures, secrets: [] };
    const bundle = { v: 1, slot: new Date(slot).toISOString().slice(0, 16) + 'Z', responses: entries };
    const receivedAt = Math.max(...entries.map(e => e.receivedAt));
    return { responses: [{ feed: 'traffic-poll', receivedAt, bytes: new TextEncoder().encode(JSON.stringify(bundle)) as Uint8Array<ArrayBuffer> }], failures, secrets: [] };
  }
}
