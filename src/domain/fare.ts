// Printed cash fare between two stops, from the zone bands in Dataset.publishedFares.
// The printed rule: the fare is the number of zones traveled through; each boundary crossed adds a zone.
// A stop drawn on a boundary has two bands, so the answer is a range; it is never narrowed by guessing.
import type { Dataset } from './types';

export interface FareQuote {
  /** Zones traveled; min < max only when an end stop sits on a printed boundary. */
  zones: { min: number; max: number };
  /** True when one end is in New York (the to/from New York table). */
  newYork: boolean;
  /** Cents for the min and max zone counts. */
  adult: { min: number; max: number };
  /** Children 5-11 and seniors 62 and older. */
  reduced: { min: number; max: number };
}

/**
 * Undefined when the dataset has no fare table, the trip's route is not one the printed table covers
 * (zones are per route: a 163 or 164 between the same stops is priced differently, #238), a stop has no zone,
 * or the table has no price for the count.
 */
export function fareBetween(ds: Dataset, routeId: string, fromStopId: string, toStopId: string): FareQuote | undefined {
  const f = ds.publishedFares;
  if (!f?.routeIds?.includes(routeId)) return undefined;
  const a = f.stopZones[fromStopId];
  const b = f.stopZones[toStopId];
  if (!a || !b) return undefined;
  const min = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[1], b[1])) + 1;
  const max = Math.max(a[1], b[1]) - Math.min(a[0], b[0]) + 1;
  const newYork = f.newYorkStopIds.includes(fromStopId) || f.newYorkStopIds.includes(toStopId);
  const table = newYork ? f.toFromNewYork : f.withinNewJersey;
  const price = (t: Record<string, number>) => {
    const lo = t[String(min)];
    const hi = t[String(max)];
    return lo === undefined || hi === undefined ? undefined : { min: lo, max: hi };
  };
  const adult = price(table.adult);
  const reduced = price(table.reduced);
  if (!adult || !reduced) return undefined;
  return { zones: { min, max }, newYork, adult, reduced };
}
