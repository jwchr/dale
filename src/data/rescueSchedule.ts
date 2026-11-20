import { parseRescueSchedule, type RescueSchedule } from '../domain/rescueSchedule';
import type { Dataset } from '../domain/types';

/** Why the wider routes are not in this search. Each one is said to the rider; none means "no other bus". */
export type WiderMissing = 'not_official' | 'not_configured' | 'not_offered' | 'feed_mismatch' | 'offline' | 'invalid';
export type WiderState =
  | { state: 'loading' }
  | { state: 'ready'; schedule: RescueSchedule; savedAt?: number }
  | { state: 'missing'; reason: WiderMissing };

const CACHE = 'dale-rescue-schedule-v1';

/**
 * The wider official schedule (#32), fetched only when Rescue opens, checked against the corridor
 * schedule the app already has (same feed version) and saved for offline use under that version.
 * Saved copies for other feed versions are removed when a new one is saved, and never used.
 */
export async function loadRescueSchedule(api: string | undefined, ds: Dataset, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<WiderState> {
  if (ds.meta.demo || ds.meta.transcribed || ds.meta.realtime?.provider !== 'njt-bus-g2') return { state: 'missing', reason: 'not_official' };
  if (!api) return { state: 'missing', reason: 'not_configured' };
  const url = `${api}/v1/schedule?extra=rescue&feedVersion=${encodeURIComponent(ds.meta.feedVersion)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
  } catch {
    if (signal.aborted) throw new Error('aborted');
    return saved(url, ds);
  }
  if (response.status === 409) return { state: 'missing', reason: 'feed_mismatch' };
  if (response.status === 404) return { state: 'missing', reason: 'not_offered' };
  if (!response.ok) return saved(url, ds);
  let schedule: RescueSchedule;
  try {
    schedule = parseRescueSchedule(await response.json(), ds);
  } catch {
    // A Worker from before this change answers with the corridor schedule itself: not offered yet.
    return { state: 'missing', reason: 'not_offered' };
  }
  try {
    const cache = await caches.open(CACHE);
    for (const old of await cache.keys()) if (old.url !== url) await cache.delete(old);
    await cache.put(url, new Response(JSON.stringify(schedule), { headers: { 'content-type': 'application/json', 'x-arriba-saved-at': String(Date.now()) } }));
  } catch { /* Offline storage is optional. */ }
  return { state: 'ready', schedule };
}

async function saved(url: string, ds: Dataset): Promise<WiderState> {
  try {
    const cache = await caches.open(CACHE), copy = await cache.match(url);
    if (copy) {
      const schedule = parseRescueSchedule(await copy.json(), ds), at = Number(copy.headers.get('x-arriba-saved-at'));
      return { state: 'ready', schedule, ...(Number.isFinite(at) && at > 0 ? { savedAt: at } : {}) };
    }
  } catch { /* An unreadable saved copy is the same as none. */ }
  return { state: 'missing', reason: 'offline' };
}
