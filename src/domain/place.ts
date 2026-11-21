// Port Authority is one place to a rider, but NJ Transit's schedule gives it several stop IDs (one per
// platform), and late-night trips leave from different ones than daytime trips (Diego, Nov 20, 2026:
// the 11:20 PM 163 was missing because it uses another Port Authority stop ID). Every lookup of a
// rider's stop on a trip goes through here, so any Port Authority stop matches any other.
// It never names or guesses a gate: the trip's own stop ID stays on the departure.
import type { Dataset, Pattern } from './types';

const terminals = new WeakMap<Dataset, Set<string>>();
function pabtIds(ds: Dataset): Set<string> {
  let ids = terminals.get(ds);
  if (!ids) terminals.set(ds, ids = new Set(ds.stops.filter((s) => s.terminal === 'PABT').map((s) => s.id)));
  return ids;
}

/** The same stop, or two Port Authority stops. */
export function samePlace(ds: Dataset, a: string, b: string): boolean {
  if (a === b) return true;
  const ids = pabtIds(ds);
  return ids.has(a) && ids.has(b);
}

/** First index at or after `from` where the pattern serves the rider's stop; -1 when it does not. */
export function placeIndex(ds: Dataset, pattern: Pattern, stopId: string, from = 0): number {
  for (let i = Math.max(0, from); i < pattern.stopIds.length; i++) if (samePlace(ds, pattern.stopIds[i]!, stopId)) return i;
  return -1;
}

/**
 * Where a rider can board at `stopId` on this pattern: the first matching stop that the bus
 * leaves for somewhere else. NY-bound trips pass "Port Authority drop off" just before their
 * last Port Authority stop, and that is an arrival, not a departure to New Jersey.
 */
export function boardIndex(ds: Dataset, pattern: Pattern, stopId: string): number {
  const i = placeIndex(ds, pattern, stopId);
  if (i < 0) return -1;
  for (let k = i + 1; k < pattern.stopIds.length; k++) if (!samePlace(ds, pattern.stopIds[k]!, stopId)) return i;
  return -1;
}
