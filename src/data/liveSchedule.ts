import { parseDataset } from '../domain/dataset';
import type { Dataset } from '../domain/types';

/** Keep only a validated static schedule offline. Live packets are never cached by this loader. */
export async function loadLiveSchedule(api: string | undefined, signal: AbortSignal): Promise<{ ds: Dataset; fromCache?: boolean; savedAt?: number; checkedAt?: number }> {
  if (!api) throw new Error('Live service not configured');
  const url = api + '/v1/schedule';
  const validate = (raw: unknown) => {
    const ds = parseDataset(raw);
    if (ds.meta.realtime?.provider !== 'njt-bus-g2') throw new Error('Incompatible live schedule');
    return ds;
  };
  try {
    const response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error('Schedule unavailable');
    const ds = validate(await response.json());
    const checkedAt = Date.now();
    try {
      const cache = await caches.open('dale-live-schedule-v1');
      await cache.put(url, new Response(JSON.stringify(ds), { headers: { 'content-type': 'application/json', 'x-arriba-saved-at': String(Date.now()) } }));
    } catch { /* Offline storage is optional; the current verified data remains usable. */ }
    return { ds, checkedAt };
  } catch {
    // The caller guards obsolete loads. A timed-out network still gets the saved static schedule.
    {
      try {
        const cache = await caches.open('dale-live-schedule-v1'), saved = await cache.match(url);
        if (saved) {
          const ds = validate(await saved.json()), at = Number(saved.headers.get('x-arriba-saved-at'));
          return { ds, fromCache: true, ...(Number.isFinite(at) && at > 0 ? { savedAt: at } : {}) };
        }
      } catch { /* Invalid or inaccessible saved data goes to the existing error/Retry flow. */ }
    }
    throw new Error('Live schedule unavailable');
  }
}
