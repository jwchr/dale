import { useEffect, useRef, useState } from 'react';
import { parseLiveSnapshot, LIVE_MAX_AGE_MS, type LiveBusSnapshot } from '../domain/liveBus';
import type { Dataset } from '../domain/types';
import type { BusSession, BusSessionEvent } from '../domain/busLock';
export type LiveRequestState = 'checking' | 'available' | 'missing' | 'ambiguous';

export function useLiveBus(ds: Dataset, session: BusSession | undefined, api: string | undefined, now: number, onEvent: (event: BusSessionEvent) => void) {
  const callback = useRef(onEvent), current = useRef(session), clock = useRef(now);
  callback.current = onEvent; current.current = session; clock.current = now;
  const [result, setResult] = useState<{ id: string; state: LiveRequestState; snapshot?: LiveBusSnapshot }>();
  const isVisible = () => document.visibilityState !== 'hidden';
  const enabled = !!session && !ds.meta.demo && ds.meta.realtime?.provider === 'njt-bus-g2' && !!api && !['left', 'ended'].includes(session.phase);
  useEffect(() => {
    if (!enabled || !session || !api) return;
    let stopped = false, running = false, ctl: AbortController | undefined, next: ReturnType<typeof setTimeout> | undefined;
    const id = session.id, trip = session.departure.tripId, date = session.departure.serviceDate, instance = session.departure.tripInstanceId;
    setResult({ id, state: 'checking' });
    async function poll() {
      if (stopped || running || !isVisible()) return;
      running = true; ctl = new AbortController();
      const timeout = setTimeout(() => ctl?.abort(), 12_000);
      try {
        const url = new URL('/v1/live', api);
        url.searchParams.set('trip', trip); url.searchParams.set('date', date);
        if (current.current?.lock.vehicleId) url.searchParams.set('vehicle', current.current.lock.vehicleId);
        const response = await fetch(url, { signal: ctl.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
        if (!response.ok) throw new Error('Live feed unavailable');
        const payload: unknown = await response.json(), renderedAt = clock.current;
        const snapshot = parseLiveSnapshot(payload, ds, trip, date, renderedAt);
        // The response can arrive between displayed clock ticks. After protocol validation,
        // use its receipt as the same conservative age bound as home departure evidence.
        // Keep the original source timestamps and the validator's future-time limit intact.
        const now = Math.max(renderedAt, snapshot.receivedAt);
        if (stopped || current.current?.id !== id) return;
        const fresh = snapshot.vehicles.state === 'ok' && now - snapshot.receivedAt <= LIVE_MAX_AGE_MS;
        const points = fresh ? snapshot.observations.filter((p) => now - p.observedAt <= LIVE_MAX_AGE_MS && p.observedAt <= now) : [];
        const exact = points.filter((p) => p.tripInstanceId === instance);
        const unique = new Set(exact.map((p) => p.vehicleId)).size <= 1;
        const state: LiveRequestState = !unique ? 'ambiguous' : exact.length ? 'available' : 'missing';
        callback.current({ type: 'feed_status', tripInstanceId: instance, state: state === 'available' ? 'ok' : state, now });
        if (unique) {
          // Existing lock logic handles an explicit replacement or our vehicle moving onto another trip.
          const ordered = points.filter((p) => p.tripInstanceId === instance || p.vehicleId === current.current?.lock.vehicleId).sort((a, b) => a.observedAt - b.observedAt);
          for (const obs of ordered) callback.current({ type: 'observation', obs, source: 'official', receivedAt: now });
        }
        if (snapshot.updates.state === 'ok' && snapshot.updatedAt && snapshot.updatedAt <= now && now - snapshot.updatedAt <= LIVE_MAX_AGE_MS
          && now - snapshot.receivedAt <= LIVE_MAX_AGE_MS && snapshot.skippedStops.length) {
          callback.current({ type: 'official_skips', tripInstanceId: instance, indices: snapshot.skippedStops, observedAt: snapshot.updatedAt, now });
        }
        if (snapshot.updates.state === 'ok' && snapshot.cancelledAt && snapshot.cancelledAt <= now && now - snapshot.cancelledAt <= LIVE_MAX_AGE_MS && now - snapshot.receivedAt <= LIVE_MAX_AGE_MS) {
          callback.current({ type: 'official_cancellation', tripInstanceId: instance, now });
        }
        setResult({ id, state, snapshot });
      } catch {
        if (!stopped && current.current?.id === id && isVisible()) {
          callback.current({ type: 'feed_status', tripInstanceId: instance, state: 'missing', now: clock.current });
          setResult({ id, state: 'missing' });
        }
      } finally {
        clearTimeout(timeout); running = false;
        if (!stopped && isVisible()) next = setTimeout(() => void poll(), 30_000);
      }
    }
    const visible = () => { clearTimeout(next); if (!isVisible()) ctl?.abort(); else void poll(); };
    document.addEventListener('visibilitychange', visible);
    void poll();
    return () => { stopped = true; clearTimeout(next); ctl?.abort(); document.removeEventListener('visibilitychange', visible); };
  }, [enabled, session?.id, ds, api]);
  return enabled && result?.id === session?.id ? result : undefined;
}
