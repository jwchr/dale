import { LiveIndicator } from './LiveIndicator';
import { useMemo, useState } from 'react';
import type { Dataset } from '../domain/types';
import type { BusSession } from '../domain/busLock';
import { DEFAULT_TIMING } from '../domain/lock';
import { timetablePosition } from '../domain/tripProgress';
import { tripStopTimes } from '../domain/schedule';
import { StreetMap } from './StreetMap';
import type { MapStop } from './RouteMap';
import type { Strings } from './i18n';

/** Only official bus GPS or explicitly labeled timetable interpolation. Never requests phone GPS. */
export function WaitingMap({ ds, session, alightIndex, now, t, estimate }: { ds: Dataset; session: BusSession; alightIndex: number; now: number; t: Strings; estimate: boolean }) {
  const [open, setOpen] = useState(true);
  const stops = useMemo(() => session.departure.pattern.stopIds.map((id) => ds.stops.find((s) => s.id === id)), [ds, session.departure.pattern]);
  const mapStops: MapStop[] = useMemo(() => stops.flatMap((s, i) => s?.lat !== undefined && s.lon !== undefined ? [{ id: s.id, city: s.city, lat: s.lat, lon: s.lon, name: s.name, state: i === alightIndex ? 'alight' as const : i === session.departure.stopIndex ? 'next' as const : 'ahead' as const }] : []), [stops, alightIndex, session.departure.stopIndex]);
  if (!stops.every((s) => s?.lat !== undefined && s.lon !== undefined)) return null;
  const last = session.lock.last;
  const official = last && session.history.some((p) => p.source === 'official' && p.vehicleId === last.vehicleId && p.observedAt === last.observedAt);
  const actual = session.lock.status === 'tracked' && last && official && now - last.observedAt <= DEFAULT_TIMING.staleAfterMs;
  const position = timetablePosition(tripStopTimes(ds, session.departure).map((s) => s.at), now);
  const from = Math.min(stops.length - 2, Math.floor(position)), fraction = position - from;
  const a = stops[from]!, b = stops[from + 1]!;
  const dot = actual ? last : estimate ? { lat: a.lat! + fraction * (b.lat! - a.lat!), lon: a.lon! + fraction * (b.lon! - a.lon!) } : undefined;
  const dark = document.documentElement.dataset.skin !== 'clean' || document.documentElement.dataset.theme === 'dark'
    || (document.documentElement.dataset.theme !== 'light' && matchMedia?.('(prefers-color-scheme: dark)').matches);
  return <div className="waiting-map">
    <button className="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t.progress.hideMap : t.progress.showMap}</button>
    {open && <>
      <p><strong><LiveIndicator live={!!actual} />{actual ? t.progress.mapDotSeen : dot ? t.confidence.estimated : t.live.positionUnknown}</strong></p>
      <StreetMap text={t.maps} key={session.id} stops={mapStops} bus={dot} dark={!!dark} label={t.live.mapLabel} loadingText={t.progress.mapLoading} failedText={t.progress.mapFailed} />
      <p className="small">{t.progress.mapNote}</p>
    </>}
  </div>;
}
