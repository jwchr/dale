import { useEffect, useState } from 'react';
import { departureKey, type DepartureBatch, type DepartureRequest } from '../domain/liveDepartures';
import { LIVE_MAX_AGE_MS } from '../domain/liveBus';
import type { VehicleObservation } from '../domain/lock';
import { reportedRouteDistance } from '../domain/routeDistance';
import type { Dataset } from '../domain/types';
import { useRouteGeometry } from './useRouteGeometry';
interface Fix { gps: VehicleObservation; receivedAt: number }
/** Ephemeral exact-query evidence only; poll failures retain a frozen, aging fix. */
export function useDepartureDistances(ds: Dataset, api: string | undefined, queries: DepartureRequest[], batch: DepartureBatch | undefined, now: number) {
  const geometry = useRouteGeometry(ds, api), identity = JSON.stringify([api, ds.meta.feedVersion]);
  const queryKey = JSON.stringify(queries.map(departureKey));
  const [saved, setSaved] = useState<{ identity: string; fixes: Map<string, Fix> }>();
  useEffect(() => {
    const wanted = new Set(queries.map(departureKey));
    setSaved(previous => {
      const fixes = new Map(previous?.identity === identity ? previous.fixes : []);
      for (const key of fixes.keys()) if (!wanted.has(key)) fixes.delete(key);
      if (batch && batch.feedVersion === ds.meta.feedVersion) for (const item of batch.items) {
        const key = departureKey(item.query); if (!wanted.has(key)) continue;
        if (item.problem || item.cancelledAt || item.boardingSkipped || item.destinationSkipped) { fixes.delete(key); continue; }
        if (!item.gps) continue;
        // A fresh receipt/header must not freshen or replace an older vehicle sample.
        if (batch.vehicles.state !== 'ok' || batch.vehicles.timestamp === undefined
          || batch.receivedAt - batch.vehicles.timestamp > LIVE_MAX_AGE_MS
          || batch.receivedAt - item.gps.observedAt > LIVE_MAX_AGE_MS) continue;
        const old = fixes.get(key);
        if (!old || item.gps.observedAt > old.gps.observedAt) fixes.set(key, { gps: item.gps, receivedAt: batch.receivedAt });
        else if (item.gps.observedAt === old.gps.observedAt && JSON.stringify(item.gps) !== JSON.stringify(old.gps)) fixes.delete(key);
      }
      return { identity, fixes };
    });
  }, [identity, queryKey, batch, ds]);
  return (query: DepartureRequest) => {
    if (saved?.identity !== identity) return;
    const fix = saved.fixes.get(departureKey(query));
    const value = reportedRouteDistance(ds, geometry, query.tripId, query.serviceDate, query.stopIndex, fix?.gps, now, fix?.receivedAt ?? now);
    return value && (!batch || batch.vehicles.state !== 'ok') ? { ...value, stale: true } : value;
  };
}
