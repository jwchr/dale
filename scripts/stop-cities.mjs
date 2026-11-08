// Public NJ Transit GIS facts, joined only to the approved canonical corridor. No credentials or phone position.
import { distanceM } from '../src/domain/direction.ts';
import { STOP_CITY_SOURCE } from '../src/domain/stopInfo.ts';
export { STOP_CITY_SOURCE };
export function withStopCities(ds, records) {
  const routes = new Map(ds.routes.map(r => [r.id, Number(/^(163|164|165)/.exec(r.shortName)?.[1])]));
  const lines = new Map();
  for (const p of ds.patterns) for (const id of p.stopIds) {
    if (!lines.has(id)) lines.set(id, new Set()); lines.get(id).add(routes.get(p.routeId));
  }
  return { ...ds, stops: ds.stops.map(stop => {
    const cities = new Set(records.filter(a => typeof a.STOP_NUM === 'string' && a.STOP_NUM.trim() === stop.code && lines.get(stop.id)?.has(a.LINE)
      && typeof a.MUNICIPALITY === 'string' && a.MUNICIPALITY.trim().length > 0 && a.MUNICIPALITY.length <= 100
      && Number.isFinite(a.DLAT_GIS) && Number.isFinite(a.DLONG_GIS) && Math.abs(a.DLAT_GIS) <= 90 && Math.abs(a.DLONG_GIS) <= 180
      && typeof stop.lat === 'number' && typeof stop.lon === 'number' && distanceM(stop, { lat: a.DLAT_GIS, lon: a.DLONG_GIS }) <= 100).map(a => a.MUNICIPALITY.trim()));
    const { city: _old, ...clean } = stop;
    return cities.size === 1 ? { ...clean, city: [...cities][0] } : clean;
  }) };
}
async function json(url, net) {
  const response = await net(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body) throw new Error('City source unavailable');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2 * 1024 * 1024) { void reader.cancel().catch(() => {}); throw new Error('City response too large'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const all = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(all));
}
export async function addStopCities(ds, net = fetch, now = Date.now()) {
  const provenance = { source: 'NJ Transit GIS Department', url: STOP_CITY_SOURCE, retrievedAt: new Date(now).toISOString() };
  try {
    const records = []; let complete = false;
    for (let page = 0; page < 4; page++) {
      const url = new URL(STOP_CITY_SOURCE + '/query');
      for (const [key, value] of Object.entries({ f: 'json', where: 'LINE IN (163,164,165)', outFields: 'STOP_NUM,MUNICIPALITY,LINE,DLAT_GIS,DLONG_GIS', returnGeometry: 'false', orderByFields: 'OBJECTID', resultOffset: String(page * 1000), resultRecordCount: '1000' })) url.searchParams.set(key, value);
      const body = await json(url.href, net);
      if (!Array.isArray(body.features) || body.error || body.features.length > 1000) throw new Error('Invalid city response');
      records.push(...body.features.map(f => f.attributes));
      if (!body.exceededTransferLimit) { complete = true; break; }
    }
    if (!complete) throw new Error('Incomplete city source');
    return { ...withStopCities(ds, records.filter(a => a && typeof a === 'object')), meta: { ...ds.meta, stopCities: { ...provenance, state: 'verified' } } };
  } catch { return { ...ds, meta: { ...ds.meta, stopCities: { ...provenance, state: 'unavailable' } } }; }
}
