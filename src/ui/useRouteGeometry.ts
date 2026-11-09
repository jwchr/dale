import { useEffect, useState } from 'react';
import type { Dataset } from '../domain/types';
import type { RouteGeometry } from '../domain/routeDistance';
import { loadRouteGeometry } from '../domain/loadRouteGeometry';
// One bounded request per endpoint/feed per opening, shared by home and the locked ride.
// Failure remains unavailable for this opening; no retries or new polling loop.
const cache = new Map<string, Promise<RouteGeometry | undefined>>();
export function useRouteGeometry(ds: Dataset, api: string | undefined) {
  const enabled = !ds.meta.demo && !ds.meta.transcribed && ds.meta.realtime?.provider === 'njt-bus-g2';
  const key = enabled && api ? JSON.stringify([api, ds.meta.feedVersion]) : undefined;
  const [result, setResult] = useState<{ key: string; geometry: RouteGeometry }>();
  useEffect(() => {
    if (!key || !api) return;
    let active = true;
    let pending = cache.get(key);
    if (!pending) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12_000);
      pending = loadRouteGeometry(ds, api, controller.signal).catch(() => undefined).finally(() => clearTimeout(timer));
      cache.set(key, pending);
      if (cache.size > 2) cache.delete(cache.keys().next().value!);
    }
    void pending.then(geometry => { if (active && geometry) setResult({ key, geometry }); });
    return () => { active = false; };
  }, [ds, api, key]);
  return result?.key === key ? result?.geometry : undefined;
}
