import bindings from 'gtfs-realtime-bindings';
import type { RawResponse } from './raw-archive';

export const REGION_COUNTIES = ['Bergen', 'Essex', 'Hudson', 'Passaic'] as const;
export interface RegionFilter {
  v: 1; counties: readonly string[]; sourceSHA256: string; sourceBytes: number;
  entities: number; kept: number; noRoute: number;
}
/** Missing, empty, malformed or stale delivery assets fail closed without affecting live data. */
export function readRegionRoutes(value: unknown, feedVersion: string): ReadonlySet<string> | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (r.v !== 1 || r.feedVersion !== feedVersion || JSON.stringify(r.counties) !== JSON.stringify(REGION_COUNTIES)
    || !Array.isArray(r.routeIds) || !r.routeIds.length || r.routeIds.some(id => typeof id !== 'string' || !id.trim())) return null;
  return new Set(r.routeIds as string[]);
}

export async function filterRegionRaw(response: RawResponse, routeIds: ReadonlySet<string>): Promise<RawResponse> {
  const message = bindings.transit_realtime.FeedMessage.decode(response.bytes);
  const entities = message.entity.length;
  let noRoute = 0;
  message.entity = message.entity.filter(entity => {
    const routes = [entity.vehicle?.trip?.routeId, entity.tripUpdate?.trip?.routeId];
    if (!routes.some(Boolean)) noRoute++;
    return !entity.alert && routes.some(route => !!route && routeIds.has(route));
  });
  const sourceSHA256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', response.bytes))]
    .map(n => n.toString(16).padStart(2, '0')).join('');
  return { ...response, bytes: new Uint8Array(bindings.transit_realtime.FeedMessage.encode(message).finish()),
    sourceBytes: response.bytes, filtered: { v: 1, counties: REGION_COUNTIES, sourceSHA256,
      sourceBytes: response.bytes.byteLength, entities, kept: message.entity.length, noRoute } };
}
