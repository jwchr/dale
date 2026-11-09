import { MAX_GEOMETRY_BYTES, parseRouteGeometry, type RouteGeometry } from './routeDistance';
import type { Dataset } from './types';
/** Version-bound optional static delivery; never calls a live feed or changes its cadence. */
export async function loadRouteGeometry(ds: Dataset, api: string, signal: AbortSignal, net: typeof fetch = fetch): Promise<RouteGeometry> {
  const url = new URL('/v1/geometry', api); url.searchParams.set('feedVersion', ds.meta.feedVersion);
  const response = await net(url, { signal, credentials: 'omit', redirect: 'error', priority: 'low' } as RequestInit);
  if (!response.ok || !response.body) throw new Error('Geometry unavailable');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_GEOMETRY_BYTES) throw new Error('Geometry oversized');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return parseRouteGeometry(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), ds);
}
