import { useEffect, useState } from 'react';
import { loadRescueSchedule, type WiderState } from '../data/rescueSchedule';
import { liveApiUrl } from '../domain/liveBus';
import type { Dataset } from '../domain/types';

const API = liveApiUrl(import.meta.env.VITE_LIVE_API_URL);
// One request per server and feed version per opening of Dale; a failed connection is tried again
// the next time Rescue opens. Nothing here polls.
const cache = new Map<string, Promise<WiderState>>();

/** The wider official schedule for Rescue (#32), loaded only when Rescue opens. */
export function useRescueSchedule(ds: Dataset, api: string | undefined = API): WiderState {
  const official = !ds.meta.demo && !ds.meta.transcribed && ds.meta.realtime?.provider === 'njt-bus-g2';
  const key = official && api ? JSON.stringify([api, ds.meta.feedVersion]) : undefined;
  const [result, setResult] = useState<{ key: string; state: WiderState }>();
  useEffect(() => {
    if (!key) return;
    let active = true;
    let pending = cache.get(key);
    if (!pending) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
      pending = loadRescueSchedule(api, ds, controller.signal)
        .catch((): WiderState => ({ state: 'missing', reason: 'offline' }))
        .finally(() => clearTimeout(timer));
      cache.set(key, pending);
      if (cache.size > 2) cache.delete(cache.keys().next().value!);
    }
    void pending.then((state) => {
      if (state.state === 'missing' && state.reason === 'offline') cache.delete(key);
      if (active) setResult({ key, state });
    });
    return () => { active = false; };
  }, [ds, api, key]);
  if (!official) return { state: 'missing', reason: 'not_official' };
  if (!api) return { state: 'missing', reason: 'not_configured' };
  return result && result.key === key ? result.state : { state: 'loading' };
}
