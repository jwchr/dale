import { routeLabel } from '../domain/routeDisplay';
// "Your connection" on the home dashboard (#101): the schematic route map from the mock-up, with the next bus
// and, when the rider taps for it, their own phone moving along it. No new location sources: the bus dot is the
// official GPS from the home live check (only when fresh and on this trip's route) or the timetable's estimate,
// labeled with the same words as the waiting map; the phone dot is the opt-in watch ride mode uses (usePhoneFix).
import { useMemo, useState } from 'react';
import type { Dataset, Departure } from '../domain/types';
import type { VehicleObservation } from '../domain/lock';
import { tripStopTimes } from '../domain/schedule';
import { formatTime12 } from '../domain/time';
import { busOnTrip, FIX_MAX_AGE_MS, fixPosition, hasLocations } from '../domain/tripProgress';
import { townCounty } from '../data/townCounties';
import { ArrowRight, ConnectionMap, type MapPoint } from './Dashboard';
import { LiveIndicator } from './LiveIndicator';
import { StreetMap } from './StreetMap';
import { mapIsDark } from './SkinBackdrop';
import { stopLabel } from './StripMap';
import { usePhoneFix } from './usePhoneFix';
import type { MapStop } from './RouteMap';
import type { Lang, Strings } from './i18n';

export function HomeConnection({ ds, t, lang, now, dep, toStopId, gps, onDetails }: {
  ds: Dataset; t: Strings; lang: Lang; now: number; dep: Departure; toStopId: string;
  /** The next bus's official position, passed only when the live check has it fresh for this exact trip. */
  gps?: VehicleObservation; onDetails: () => void;
}) {
  const d = t.dash;
  const ids = dep.pattern.stopIds;
  const stops = useMemo(() => ids.map(id => ds.stops.find(s => s.id === id)), [ds, ids]);
  const times = useMemo(() => tripStopTimes(ds, dep).map(s => s.at), [ds, dep]);
  const board = dep.stopIndex;
  const found = ids.indexOf(toStopId, board + 1);
  const alight = found > board ? found : ids.length - 1;
  const last = ids.length - 1;
  const verified = ds.meta.stopCities?.state === 'verified';
  const town = (i: number) => {
    const s = stops[i];
    if (s?.terminal === 'PABT') return d.portAuthority;
    return verified && s?.city ? s.city : stopLabel(s?.name ?? ids[i] ?? '').town;
  };
  const point = (i: number, isBoard = false): MapPoint => ({ name: town(i), index: i, ...(isBoard ? { board: true } : {}) });
  const toNy = stops[alight]?.terminal === 'PABT', fromNy = stops[board]?.terminal === 'PABT';
  const nj = toNy ? [...(board > 0 ? [point(0)] : []), point(board, true)]
    : fromNy ? [...(alight < last ? [point(last)] : []), point(alight)]
    : [...(board > 0 ? [point(0)] : []), point(board, true), point(alight)];
  const ny = toNy ? point(alight) : fromNy ? point(board, true) : undefined;
  const njTown = town(toNy || !fromNy ? board : alight);
  const destination = toNy ? t.commuteNewYork : town(alight);

  const bus = busOnTrip(stops, times, now, gps);
  const located = hasLocations(stops);
  const [showMe, setShowMe] = useState(false);
  const [street, setStreet] = useState(false);
  const { phone, gps: phoneState } = usePhoneFix(showMe && located, now);
  // The same freshness limits as fixPosition: an old fix leaves both maps until the phone sends a new one.
  const fresh = phone && now - phone.at <= FIX_MAX_AGE_MS && phone.at <= now + 60_000 ? phone : undefined;
  const you = fresh ? fixPosition(stops, 0, fresh, now) : undefined;
  const route = routeLabel(dep.route.shortName, t.gateTurnpikeExpress);

  // The street map reuses the waiting map's pieces: official GPS, or the same straight-line timetable estimate.
  const mapStops: MapStop[] = useMemo(() => stops.flatMap((s, i) => s?.lat !== undefined && s.lon !== undefined
    ? [{ id: s.id, city: s.city, lat: s.lat, lon: s.lon, name: s.name, state: i === alight ? 'alight' as const : i === board ? 'next' as const : 'ahead' as const }] : []), [stops, alight, board]);
  const busPoint = (() => {
    if (!located) return undefined;
    if (bus.kind === 'gps') return { lat: gps!.lat, lon: gps!.lon };
    if (bus.kind !== 'estimate') return undefined;
    const from = Math.min(stops.length - 2, Math.floor(bus.position)), f = bus.position - from;
    const a = stops[from]!, b = stops[from + 1]!;
    return { lat: a.lat! + f * (b.lat! - a.lat!), lon: a.lon! + f * (b.lon! - a.lon!) };
  })();

  return <section className="dash-panel dash-connection" aria-labelledby="dash-connection-title" data-trip={dep.tripInstanceId}>
    <div className="dash-section-head">
      <div>
        <p className="dash-eyebrow">{d.yourConnection}</p>
        <h2 id="dash-connection-title" className="dash-title">{d.nextStop(destination)}</h2>
      </div>
      <button type="button" className="dash-outline" onClick={onDetails}>{d.tripDetails}<ArrowRight /></button>
    </div>
    <ConnectionMap t={t} nj={nj} ny={ny} eastbound={!fromNy} county={townCounty(njTown)}
      bus={bus.kind === 'gps' || bus.kind === 'estimate' ? { position: bus.position, live: bus.kind === 'gps' } : undefined}
      you={you} />
    <div className="map-status">
      <p className="small map-bus-status" data-bus={bus.kind}>
        {(bus.kind === 'gps' || bus.kind === 'estimate') && <span className="map-key map-key-bus" aria-hidden="true" />}
        <strong>{d.busKey(route)}: </strong>
        {bus.kind === 'gps' ? <><LiveIndicator live />{t.progress.mapDotSeen} {d.busSeen(Math.max(0, Math.floor((now - bus.observedAt) / 1000)))}</>
          : bus.kind === 'estimate' ? <><LiveIndicator live={false} />{t.confidence.estimated}</>
          : bus.kind === 'not-started' ? t.live.rows.notStarted(formatTime12(bus.startsAt, ds.meta.timezone, lang))
          : t.live.positionUnknown}
      </p>
      {/* Announces only a change in what the bus dot is (GPS, estimate, not started, unknown), never each new position or age. */}
      <span className="sr-only" role="status">{d.busKey(route)}: {bus.kind === 'gps' ? t.progress.mapDotSeen : bus.kind === 'estimate' ? t.confidence.estimated
        : bus.kind === 'not-started' ? t.live.rows.notStarted(formatTime12(bus.startsAt, ds.meta.timezone, lang)) : t.live.positionUnknown}</span>
      {located && <>
        <div className="choice-list map-actions">
          <button type="button" className="chip" aria-pressed={showMe} onClick={() => setShowMe(v => !v)}>{d.showMe}</button>
          <button type="button" className="chip" aria-expanded={street} onClick={() => setStreet(v => !v)}>{street ? t.progress.hideMap : t.progress.showMap}</button>
        </div>
        {!showMe && <p className="muted small">{d.showMePrivacy}</p>}
        {showMe && <p className="small map-you-status">
          {you !== undefined && <span className="map-key map-key-you" aria-hidden="true" />}
          {phoneState === 'on' && phone ? fresh ? <>{d.gpsOn(Math.round(fresh.accuracyM))}{you === undefined && <> {d.youOffMap}</>}</> : d.youWaiting : d.gps[phoneState]}
        </p>}
        <span className="sr-only" role="status">{showMe ? (phoneState === 'on' && phone && !fresh ? d.youWaiting : d.gps[phoneState]) : ''}</span>
        {street && <StreetMap text={t.maps} key={dep.tripInstanceId} stops={mapStops} bus={busPoint} you={fresh && { lat: fresh.lat, lon: fresh.lon }} dark={!!mapIsDark()} label={t.live.mapLabel} loadingText={t.progress.mapLoading} failedText={t.progress.mapFailed} />}
      </>}
    </div>
  </section>;
}
