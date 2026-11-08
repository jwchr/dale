// Public, normalized corridor protocol. Raw NJ Transit responses and tokens stay on the server.
import type { Dataset } from './types';
import type { VehicleObservation } from './lock';

export const LIVE_SOURCE = 'NJ Transit GTFS-RT G2';
export const LIVE_MAX_AGE_MS = 120_000;
export type FeedState = 'ok' | 'stale' | 'unavailable' | 'invalid';
export interface LiveFeed { state: FeedState; timestamp?: number }
export interface LivePrediction { stopIndex: number; at: number; observedAt: number; kind: 'arrival' | 'departure' }
export interface LiveBusSnapshot {
  v: 1; source: typeof LIVE_SOURCE; feedVersion: string; tripInstanceId: string; receivedAt: number;
  vehicles: LiveFeed; updates: LiveFeed; observations: VehicleObservation[];
  updatedAt?: number; cancelledAt?: number; predictions: LivePrediction[]; skippedStops: number[];
}
export const validVehicleId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && Number.isFinite(new Date(v).getTime());

/** Reject incompatible, future or malformed packets rather than repairing them into live evidence. */
export function parseLiveSnapshot(value: unknown, ds: Dataset, tripId: string, serviceDate: string, now: number): LiveBusSnapshot {
  const fail = () => { throw new Error('Invalid live bus response'); };
  if (!object(value) || value.v !== 1 || value.source !== LIVE_SOURCE || value.feedVersion !== ds.meta.feedVersion
    || value.tripInstanceId !== `${tripId}@${serviceDate}` || !time(value.receivedAt) || value.receivedAt > now + 30_000) return fail();
  const receivedAt = value.receivedAt;
  const feed = (v: unknown) => object(v) && ['ok', 'stale', 'unavailable', 'invalid'].includes(String(v.state))
    && (v.timestamp === undefined || (time(v.timestamp) && v.timestamp <= receivedAt));
  const trip = ds.trips.find((t) => t.id === tripId), pattern = ds.patterns.find((p) => p.id === trip?.patternId);
  if (!pattern || !feed(value.vehicles) || !feed(value.updates)) return fail();
  const stopCall = (p: Record<string, unknown>) => {
    if (p.stopCall === undefined) return true;
    const parts = typeof p.tripInstanceId === 'string' ? p.tripInstanceId.split('@') : [];
    const ownTrip = ds.trips.find(t => t.id === parts[0]), ownPattern = ds.patterns.find(x => x.id === ownTrip?.patternId), call = p.stopCall;
    return parts.length === 2 && validServiceDate(parts[1]!) && ownPattern && object(call) && call.status === 'stopped_at'
      && typeof call.stopIndex === 'number' && Number.isInteger(call.stopIndex) && call.stopIndex >= 0 && ownPattern.stopIds[call.stopIndex] === call.stopId;
  };
  if (!Array.isArray(value.observations) || value.observations.length > 10 || !value.observations.every((p) => object(p)
    && typeof p.tripInstanceId === 'string' && p.tripInstanceId.includes('@') && validVehicleId(p.vehicleId)
    && time(p.observedAt) && p.observedAt <= receivedAt && typeof p.lat === 'number' && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90
    && typeof p.lon === 'number' && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180 && stopCall(p))) return fail();
  const index = (i: unknown): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < pattern.stopIds.length;
  if (!Array.isArray(value.predictions) || value.predictions.length > pattern.stopIds.length * 2 || !value.predictions.every((p) => object(p)
    && index(p.stopIndex) && time(p.at) && time(p.observedAt) && p.observedAt <= receivedAt && ['arrival', 'departure'].includes(String(p.kind)))) return fail();
  if (value.updatedAt !== undefined && (!time(value.updatedAt) || value.updatedAt > receivedAt)) return fail();
  if (!Array.isArray(value.skippedStops) || !value.skippedStops.every(index) || (value.cancelledAt !== undefined && (!time(value.cancelledAt) || value.cancelledAt > value.receivedAt))) return fail();
  return value as unknown as LiveBusSnapshot;
}

/** Public backend address only; credentials are never accepted as URL parameters or browser config. */
export function liveApiUrl(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^https:\/\/dale-live\.[a-z0-9-]+\.workers\.dev$/.test(raw) ? raw : undefined;
}

export function validServiceDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const date = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))));
  return date.toISOString().slice(0, 10).replaceAll('-', '') === value;
}
