// Exact-bus lock (owner decision D25). The lock is keyed to a trip instance (trip + service date).
// It never silently switches to a different bus: a new vehicle on our trip, or our vehicle on another
// trip, is held for the rider to confirm. Missing data is shown as missing, never as a cancellation.

import type { TripInstanceId } from './types';

export interface VehicleObservation {
  tripInstanceId: TripInstanceId;
  vehicleId: string;
  /** When the vehicle reported this position (not when we received it). */
  observedAt: number;
  lat: number;
  lon: number;
  /** Explicit official stop status, only when the stop selector is unambiguous. */
  stopCall?: { stopId: string; stopIndex: number; status: 'stopped_at' };
}

export type LockStatus =
  | 'scheduled_only' // no live vehicle has ever been linked to this trip
  | 'tracked' // fresh observation of the locked vehicle on the locked trip
  | 'stale' // locked vehicle seen before, but not recently
  | 'vanished' // locked vehicle not seen for a long time; NOT a cancellation
  | 'needs_confirmation' // feed now links a different vehicle, or our vehicle moved to another trip
  | 'cancelled' // only from an explicit official cancellation
  | 'ended';

export interface TripLock {
  tripInstanceId: TripInstanceId;
  status: LockStatus;
  vehicleId?: string;
  last?: VehicleObservation;
  /** The conflicting evidence awaiting the rider's decision. */
  pending?: VehicleObservation;
  lockedAt: number;
}

export interface LockTiming {
  staleAfterMs: number;
  vanishAfterMs: number;
}

export const DEFAULT_TIMING: LockTiming = { staleAfterMs: 2 * 60_000, vanishAfterMs: 10 * 60_000 };

export function createLock(id: TripInstanceId, now: number): TripLock {
  return { tripInstanceId: id, status: 'scheduled_only', lockedAt: now };
}

export type LockEvent =
  | { type: 'observation'; obs: VehicleObservation }
  | { type: 'tick'; now: number }
  | { type: 'official_cancellation'; tripInstanceId: TripInstanceId }
  | { type: 'confirm_pending' }
  | { type: 'reject_pending' }
  | { type: 'end' };

export function reduceLock(lock: TripLock, ev: LockEvent, timing: LockTiming = DEFAULT_TIMING): TripLock {
  if (lock.status === 'ended' || lock.status === 'cancelled') return lock;
  switch (ev.type) {
    case 'observation': {
      const o = ev.obs;
      const ours = o.tripInstanceId === lock.tripInstanceId;
      // Ignore out-of-order or duplicate reports.
      if (lock.last && o.vehicleId === lock.vehicleId && o.observedAt <= lock.last.observedAt) return lock;
      if (!lock.vehicleId) {
        return ours ? { ...lock, vehicleId: o.vehicleId, last: o, status: 'tracked', pending: undefined } : lock;
      }
      if (ours && o.vehicleId === lock.vehicleId) {
        return { ...lock, last: o, status: lock.status === 'needs_confirmation' ? lock.status : 'tracked' };
      }
      if (ours && o.vehicleId !== lock.vehicleId) return { ...lock, pending: o, status: 'needs_confirmation' };
      if (!ours && o.vehicleId === lock.vehicleId) return { ...lock, pending: o, status: 'needs_confirmation' };
      return lock;
    }
    case 'tick': {
      if (!lock.last || lock.status === 'needs_confirmation') return lock;
      const age = ev.now - lock.last.observedAt;
      const status: LockStatus = age > timing.vanishAfterMs ? 'vanished' : age > timing.staleAfterMs ? 'stale' : 'tracked';
      return status === lock.status ? lock : { ...lock, status };
    }
    case 'official_cancellation':
      return ev.tripInstanceId === lock.tripInstanceId ? { ...lock, status: 'cancelled' } : lock;
    case 'confirm_pending': {
      const p = lock.pending;
      if (!p) return lock;
      // Following the bus onto another trip means the rider chose that trip; the lock moves with it, visibly.
      return { ...lock, tripInstanceId: p.tripInstanceId, vehicleId: p.vehicleId, last: p, pending: undefined, status: 'tracked' };
    }
    case 'reject_pending':
      return { ...lock, pending: undefined, status: lock.last ? 'stale' : 'scheduled_only' };
    case 'end':
      return { ...lock, status: 'ended' };
  }
}
