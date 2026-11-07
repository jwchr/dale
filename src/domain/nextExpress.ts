import { departuresOn, type DepartureQuery } from './schedule';
import { addDays, localYmd } from './time';
import type { Dataset, Departure } from './types';

/** A secondary scheduled option, never a replacement for the rider's selected bus. */
export function nextExpress(ds: Dataset, query: Omit<DepartureQuery, 'date'>, shown: readonly Departure[], now: number, walkMin = 0): Departure | undefined {
  if (shown.length < 3 || shown.some((d) => d.route.shortName !== '165')) return;
  const routeIds = ds.routes.filter((r) => r.shortName === '165T'
    && (!query.routeIds?.length || query.routeIds.includes(r.id))).map((r) => r.id);
  if (!routeIds.length) return;
  const catchableAt = now + walkMin * 60_000, today = localYmd(catchableAt, ds.meta.timezone);
  // Same seven-day planning window as the timetable; never scan every intervening local bus.
  for (let day = 0; day < 7; day++) {
    const dep = departuresOn(ds, { ...query, routeIds, date: addDays(today, day) }).find((d) => d.departs >= catchableAt);
    if (dep) return dep;
  }
}
