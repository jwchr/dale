import { checkDirection, destinationsFrom, reaches } from './direction';
import { favoriteLeg, isGeneratedFavoriteLabel, type Favorite } from './favorites';
import { samePlace } from './place';
import type { Dataset, Stop } from './types';

/** Only verified GIS cities, the authorized printed town prefix, or the confirmed PABT city. */
export function stopCity(ds: Dataset, stop: Stop): string {
  if (stop.terminal === 'PABT') return 'New York';
  if (ds.meta.stopCities?.state === 'verified' && stop.city?.trim()) return stop.city.trim();
  return ds.meta.transcribed ? /^(.+?)(?: \([^()]+\))? - /.exec(stop.name)?.[1] ?? '' : '';
}
export function cityStopGroups(ds: Dataset, stops: Stop[], lang: string) {
  const groups = new Map<string, Stop[]>();
  for (const stop of stops) {
    const city = stopCity(ds, stop);
    if (!groups.has(city)) groups.set(city, []);
    groups.get(city)!.push(stop);
  }
  return [...groups].sort(([a], [b]) => !a ? 1 : !b ? -1 : a.localeCompare(b, lang))
    .map(([city, stops]) => ({ city, stops: [...stops].sort((a, b) => Number(!!b.terminal) - Number(!!a.terminal) || a.name.localeCompare(b.name, lang) || a.id.localeCompare(b.id)) }));
}
/** Loaded, actually boardable stops on the saved commute's supported routes. */
export function cityBoardingStops(ds: Dataset, routeIds: string[]): Stop[] {
  const ids = new Set<string>();
  for (const pattern of ds.patterns) {
    if (routeIds.length && !routeIds.includes(pattern.routeId)) continue;
    pattern.stopIds.forEach((id, index) => {
      if (pattern.stopIds.indexOf(id) === index && !pattern.noPickup?.includes(index)
        && pattern.stopIds.slice(index + 1).some(later => !samePlace(ds, later, id))) ids.add(id);
    });
  }
  return ds.stops.filter(stop => ids.has(stop.id));
}
export function cityDestinationStops(ds: Dataset, from: string, routeIds: string[]): Stop[] {
  return destinationsFrom(ds, from).filter(stop => {
    const check = checkDirection(ds, from, stop.id, routeIds);
    return check.ok || check.reason === 'wrong-side';
  });
}
/** Explicit save preserves identity/order/custom names, route filters and directional walking plans. */
export function changeFavoriteStops(ds: Dataset, favorite: Favorite, from: string, to: string, reversed: boolean): Favorite | undefined {
  const origin = ds.stops.find(stop => stop.id === from), destination = ds.stops.find(stop => stop.id === to);
  if (!origin || !destination || !reaches(ds, from, to, favorite.routeIds)) return undefined;
  // Recover a missing return without replacing the forward trip or swapping its walking plans.
  if (reversed && (favorite.returnStops || !favoriteLeg(ds, favorite, true))) {
    return { ...favorite, returnStops: { fromStopId: from, toStopId: to } };
  }
  // A confirmed return belongs to the old commute pair; a new pair starts with its own inferred return.
  const { returnStops, ...base } = favorite;
  const samePair = from === favorite.fromStopId && to === favorite.toStopId;
  return { ...base, ...(samePair && returnStops ? { returnStops } : {}), fromStopId: from, toStopId: to,
    label: isGeneratedFavoriteLabel(ds, favorite) ? `${origin.name} → ${destination.name}` : favorite.label,
    ...(reversed && favorite.leave ? { leave: { ...(favorite.leave.back ? { out: favorite.leave.back } : {}), ...(favorite.leave.out ? { back: favorite.leave.out } : {}) } } : {}),
  };
}
