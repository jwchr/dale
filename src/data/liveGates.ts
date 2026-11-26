import { parseLaneGate, type GatePosting } from '../domain/gate';
import { validServiceDate } from '../domain/liveBus';
import { isServiceActive } from '../domain/schedule';
import type { Dataset } from '../domain/types';

export interface LiveGateReceipt { postings: GatePosting[]; arrivedAt: number }
/** Narrow, bounded public contract. Reject the entire snapshot if any posting is malformed. */
export function parseLiveGates(value: unknown, ds: Dataset, requestMs: number, arrivedAt: number): LiveGateReceipt {
  if (!value || typeof value !== 'object' || !Number.isFinite(requestMs) || requestMs < 0 || !Number.isFinite(arrivedAt)) throw new Error('Invalid gate snapshot');
  const v = value as Record<string, unknown>;
  if (v.v === 1 && v.available === false) return { postings: [], arrivedAt };
  if (v.v !== 1 || v.schemaVersion !== 1 || v.feedVersion !== ds.meta.feedVersion || !Array.isArray(v.postings) || v.postings.length > 2000) throw new Error('Invalid gate snapshot');
  const seen = new Set<string>();
  const postings = v.postings.map((raw: unknown): GatePosting => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid gate posting');
    const p = raw as Record<string, unknown>;
    const date = typeof p.tripInstanceId === 'string' ? p.tripInstanceId.slice(p.tripInstanceId.lastIndexOf('@') + 1) : '';
    const trip = typeof p.tripInstanceId === 'string' && ds.trips.find(t => p.tripInstanceId === `${t.id}@${String(p.tripInstanceId).split('@').at(-1)}`);
    const pattern = trip && ds.patterns.find(pattern => pattern.id === trip.patternId);
    const i = p.boardingIndex;
    const validGate = typeof p.gate === 'string' && /^\d{1,3}$/.test(p.gate);
    const validDoor = p.door === undefined || typeof p.door === 'string' && /^\d{1,2}$/.test(p.door);
    const parsed = validGate && validDoor && parseLaneGate(`${p.gate}${p.door ? '-' + p.door : ''}`);
    const key = JSON.stringify([p.tripInstanceId, i]);
    if (!pattern || !trip || !validServiceDate(date) || !isServiceActive(ds.calendars[trip.serviceId], date) || trip.estimated?.includes(i as number) || typeof p.tripInstanceId !== 'string' || !/@\d{8}$/.test(p.tripInstanceId) || !Number.isSafeInteger(i) || (i as number) < 0 || (i as number) >= pattern.stopIds.length - 1 || pattern.noPickup?.includes(i as number) || !ds.stops.some(s => s.id === pattern.stopIds[i as number] && s.terminal === 'PABT') || !parsed || p.source !== 'njt-departurevision' || typeof p.ageMs !== 'number' || !Number.isFinite(p.ageMs) || p.ageMs < 0 || seen.has(key)) throw new Error('Invalid gate posting');
    seen.add(key);
    return { tripInstanceId: p.tripInstanceId, boardingIndex: i as number, ...parsed, source: 'njt-departurevision', observedAt: 0, ageMs: p.ageMs + requestMs };
  });
  return { postings, arrivedAt };
}
export function currentGatePostings(receipt: LiveGateReceipt | undefined, monoNow: number): GatePosting[] {
  if (!receipt || !Number.isFinite(monoNow) || monoNow < receipt.arrivedAt) return [];
  return receipt.postings.map(p => ({ ...p, ageMs: p.ageMs + monoNow - receipt.arrivedAt })).filter(p => p.ageMs < 120_000);
}
export async function loadLiveGates(api: string, ds: Dataset, signal: AbortSignal): Promise<LiveGateReceipt> {
  const start = performance.now();
  const response = await fetch(new URL('/v1/gates', api), { signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error('Gate service unavailable');
  const text = await response.text();
  if (text.length > 256 * 1024) throw new Error('Gate snapshot too large');
  const value: unknown = JSON.parse(text), arrivedAt = performance.now();
  const cacheAge = response.headers.get('age');
  const cacheMs = cacheAge === null ? 0 : /^\d+$/.test(cacheAge) ? Number(cacheAge) * 1000 : Infinity;
  return parseLiveGates(value, ds, arrivedAt - start + cacheMs, arrivedAt);
}
