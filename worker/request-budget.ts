import { localYmd } from '../src/domain/time';
/** A conservative rolling 24-hour ceiling per API, including failed/ambiguous requests.
 * Keep the entire oldest UTC hour, so neither midnight nor DST resets the allowance. */
export const NJT_REQUEST_LIMIT = 40_000;
export interface RequestBudget { hours: Record<string, number>; lastAt?: number; easternDay?: { date: string; requests: number } }
export function reserveRequests(state: RequestBudget, count: number, now: number, limit = NJT_REQUEST_LIMIT): boolean {
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(now) || now < (state.lastAt ?? 0)) return false;
  const current = Math.floor(now / 3600_000), oldest = Math.floor((now - 86400_000) / 3600_000);
  for (const key of Object.keys(state.hours)) if (Number(key) < oldest) delete state.hours[key];
  const values = Object.values(state.hours);
  if (values.some(n => !Number.isSafeInteger(n) || n < 0) || values.reduce((a, b) => a + b, 0) + count > limit) return false;
  const date = localYmd(now, 'America/New_York');
  state.easternDay = { date, requests: (state.easternDay?.date === date ? state.easternDay.requests : 0) + count };
  state.hours[current] = (state.hours[current] ?? 0) + count; state.lastAt = now;
  return true;
}
