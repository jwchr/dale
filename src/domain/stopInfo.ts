import type { Dataset, Stop } from './types';
export const STOP_CITY_SOURCE = 'https://services6.arcgis.com/M0t0HPE53pFK525U/arcgis/rest/services/NJ_Transit_Bus_Stops_by_Line/FeatureServer/11';
/** Only patterns where the rider can actually board; direction0/1 has no universal compass meaning. */
export function boardingInfo(ds: Dataset, stopId: string) {
  const patterns = ds.patterns.filter(p => { const i = p.stopIds.indexOf(stopId); return i >= 0 && i < p.stopIds.length - 1 && !p.noPickup?.includes(i); });
  const routes = [...new Set(patterns.map(p => ds.routes.find(r => r.id === p.routeId)?.shortName).filter((s): s is string => !!s))];
  const destinations = [...new Set(patterns.map(p => {
    const index = p.stopIds.indexOf(stopId), later = p.stopIds.slice(index + 1);
    if (later.some((id, i) => ds.stops.find(s => s.id === id)?.terminal === 'PABT' && !p.noDropOff?.includes(index + 1 + i))) return 'PABT';
    return ds.stops.find(s => s.id === p.stopIds[p.stopIds.length - 1])?.city || p.headsign;
  }).filter(Boolean))];
  return { routes, destinations, headsigns: [...new Set(patterns.map(p => p.headsign).filter(Boolean))] };
}
export function destinationGroups(ds: Dataset, origin: string, stops: Stop[]) {
  const terminal = stops.filter(s => s.terminal === 'PABT');
  const final = (id: string) => ds.patterns.some(p => p.stopIds[p.stopIds.length - 1] === id && p.stopIds.indexOf(origin) >= 0 && p.stopIds.indexOf(origin) < p.stopIds.length - 1);
  terminal.sort((a, b) => Number(final(b.id)) - Number(final(a.id)));
  const groups = new Map<string, Stop[]>();
  for (const s of stops.filter(s => s.terminal !== 'PABT')) {
    const printedTown = ds.meta.transcribed && /^(.+?)(?: \([^()]+\))? - /.exec(s.name)?.[1];
    const city = s.city?.trim() || printedTown || '';
    if (!groups.has(city)) groups.set(city, []); groups.get(city)!.push(s);
  }
  return { terminal, cities: [...groups].sort(([a], [b]) => !a ? 1 : !b ? -1 : a.localeCompare(b)).map(([city, stops]) => ({ city, stops })) };
}
