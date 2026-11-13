import { LiveIndicator } from './LiveIndicator';
// Ride progress (owner request 2026-11-04): an LED status bar ("Next stop … · 3 min behind") and a
// horizontal strip map of the line, like the maps over subway car doors, with passed stops dimmed,
// the current reported stop lit, the rider's stop marked and a progress bar. Evidence: the matched bus's GPS,
// the rider's own phone GPS (opt-in, on this phone only while ride mode is open, never saved or
// sent), and the rider's taps on a stop. Without evidence it shows the timetable's position, labeled.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BusSession } from '../domain/busLock';
import { DEFAULT_TIMING } from '../domain/lock';
import { tripStopTimes } from '../domain/schedule';
import { formatTime12 } from '../domain/time';
import { fixPosition, hasLocations, stopReached, tripProgress, type Fix, type Milestone } from '../domain/tripProgress';
import type { Dataset } from '../domain/types';
import type { Lang, Strings } from './i18n';
import { SignalWarning } from './SignalWarning';
import { StreetMap } from './StreetMap';
import type { MapStop } from './RouteMap';

/** Per ride session, so leaving or entering full screen keeps the taps and the GPS choice. */
const kept = new Map<string, { milestones: Milestone[]; follow: boolean; hideMap?: boolean }>();

/** "Hackensack - Main St. at Anderson St. (to New York)" → town and detail, without the direction hint. */
export function stopLabel(name: string): { town: string; detail: string } {
  // The strip is narrow: the terminal goes by the name riders use, as on the commute signs.
  const plain = name.replace(/\s+\(to [^)]+\)$/i, '').replace(/Port Authority Bus Terminal/g, 'Port Authority');
  const i = plain.indexOf(' - ');
  return i > 0 ? { town: plain.slice(0, i), detail: plain.slice(i + 3) } : { town: plain, detail: '' };
}

type GpsState = 'off' | 'asking' | 'on' | 'denied' | 'unsupported' | 'failed';

export function StripMap({ ds, session, alightIndex, now, t, lang }: { ds: Dataset; session: BusSession; alightIndex: number; now: number; t: Strings; lang: Lang }) {
  const p = t.progress;
  const dep = session.departure;
  const ids = dep.pattern.stopIds;
  const stops = useMemo(() => ids.map((id) => ds.stops.find((s) => s.id === id)), [ds, ids]);
  const stopTimes = useMemo(() => tripStopTimes(ds, dep), [ds, dep]);
  const times = stopTimes.map((x) => x.at);
  const located = hasLocations(stops);
  const clock = (at: number, estimated = false) => `${estimated ? '~' : ''}${formatTime12(at, ds.meta.timezone, lang)}`;
  const name = (i: number) => stops[i]?.name ?? ids[i] ?? '';

  const [state, setState] = useState(() => kept.get(session.id) ?? { milestones: [], follow: false });
  const update = (next: typeof state) => { kept.set(session.id, next); setState(next); };
  const [undo, setUndo] = useState<Milestone[] | undefined>();
  const [phone, setPhone] = useState<Fix | undefined>();
  const [gps, setGps] = useState<GpsState>(state.follow ? 'asking' : 'off');
  // A fix is stamped with Dale's own clock when it arrives (the same clock the timetable is read with).
  const nowRef = useRef(now);
  nowRef.current = now;

  // The rider's phone position, only while they ask for it and ride mode is open. It stays in memory
  // on this screen; nothing is stored, logged or sent.
  useEffect(() => {
    if (!state.follow || !located) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setGps('unsupported'); return; }
    setGps('asking');
    const id = navigator.geolocation.watchPosition(
      // The fix's own age is kept (a cached or delayed fix is not "now"), on Dale's clock.
      (pos) => { setGps('on'); setPhone({ lat: pos.coords.latitude, lon: pos.coords.longitude, at: nowRef.current - Math.max(0, Date.now() - (pos.timestamp || Date.now())), accuracyM: pos.coords.accuracy }); },
      (e) => setGps(e.code === e.PERMISSION_DENIED ? 'denied' : 'failed'),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    return () => { navigator.geolocation.clearWatch(id); setPhone(undefined); };
  }, [state.follow, located]);

  // The matched bus's own GPS, when Bus Lock has a fresh fix for it.
  const last = session.lock.last;
  const bus: Fix | undefined = last && session.lock.status === 'tracked' && now - last.observedAt <= DEFAULT_TIMING.staleAfterMs
    ? { lat: last.lat, lon: last.lon, at: last.observedAt, accuracyM: 0 } : undefined;
  const busIsDemo = session.history.at(-1)?.source === 'demo';

  const progress = tripProgress({ stops, times, boardIndex: dep.stopIndex, alightIndex, now, milestones: state.milestones.filter((m) => m.source !== 'bus_gps' || !session.officialFeed || session.officialFeed.state === 'ok'), ...(phone ? { phone } : {}), ...(bus ? { bus } : {}) });

  // A GPS fix at a stop counts as reaching it, once.
  useEffect(() => {
    const fixes: [Fix | undefined, Milestone['source']][] = [[bus, 'bus_gps'], [phone, 'phone_gps']];
    for (const [fix, source] of fixes) {
      if (!fix) continue;
      const i = stopReached(stops, progress.reachedIndex, fix, fixPosition(stops, dep.stopIndex, fix, now));
      if (i !== undefined && i <= ids.length - 1) update({ ...state, milestones: [...state.milestones, { index: i, at: fix.at, source }] });
    }
  }, [phone?.at, bus?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  function tap(i: number) {
    setUndo(state.milestones);
    update({ ...state, milestones: [...state.milestones.filter((m) => m.index < i), { index: i, at: now, source: 'tap' }] });
  }

  const currentFix = progress.basis === 'bus_gps' ? bus : progress.basis === 'phone_gps' ? phone : undefined;
  const currentIndex = currentFix ? stopReached(stops, -1, currentFix, fixPosition(stops, dep.stopIndex, currentFix, now))
    : progress.basis === 'tap' && !progress.projected ? Math.round(progress.position) : undefined;
  // Keep current position in view; the upcoming stop has its own label.
  const strip = useRef<HTMLOListElement>(null);
  const lastIndex = ids.length - 1;
  const atEnd = progress.reachedIndex >= lastIndex;
  const nextIndex = Math.min(lastIndex, (currentIndex ?? Math.floor(progress.position)) + 1);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(`[data-i="${currentIndex ?? nextIndex}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [currentIndex, nextIndex]);

  const delay = progress.delayMin;
  const pace = delay === undefined ? p.byTimetable : delay === 0 ? p.onTime : delay > 0 ? p.behind(delay) : p.ahead(-delay);
  const source = progress.basis === 'timetable' ? p.noEvidence
    : progress.basis === 'tap' ? p.fromTap(((l) => (l.detail ? `${l.town}, ${l.detail}` : l.town))(stopLabel(name([...state.milestones].sort((a, b) => a.at - b.at).at(-1)?.index ?? dep.stopIndex))), clock(progress.observedAt!))
      : progress.basis === 'bus_gps' ? (busIsDemo ? p.fromDemoBus : p.fromBus(Math.max(0, Math.round((now - progress.observedAt!) / 1000))))
        : p.fromPhone(Math.max(0, Math.round((now - progress.observedAt!) / 1000)));
  const first = dep.stopIndex;
  const span = Math.max(1, ids.length - 1 - first);
  const fill = Math.max(0, Math.min(1, (progress.position - first) / span));
  const nextLabel = stopLabel(name(nextIndex));

  return (
    <div className="progress" data-basis={progress.basis}>
      <SignalWarning session={session} now={now} t={t} estimated={progress.basis === 'timetable' || progress.projected} />
      {/* The LED bar: next stop and pace, like the sign over the car doors. */}
      <div className="led-bar" role="status" aria-live="polite">
        <p className="led-line led-next"><span className="led-key">{currentIndex === lastIndex ? p.at : p.next}</span> <span className="led-name">{nextLabel.town}{nextLabel.detail ? ` · ${nextLabel.detail}` : ''}</span></p>
        <p className="led-line led-pace" data-pace={delay === undefined ? 'unknown' : delay > 0 ? 'behind' : delay < 0 ? 'ahead' : 'on'}>{pace}</p>
      </div>
      <p className="small progress-source">{progress.basis !== 'tap' && progress.basis !== 'phone_gps' && !busIsDemo && <LiveIndicator live={progress.basis === 'bus_gps' && !progress.projected} />}{progress.projected ? `${p.estimated} ` : ''}{source}</p>
      {progress.alight.projected !== undefined && delay !== 0
        ? <p className="small">{p.yourStop(clock(progress.alight.projected), clock(progress.alight.scheduled))}</p>
        : <p className="small">{p.yourStopScheduled(clock(progress.alight.scheduled))}</p>}

      <div className="strip-wrap">
        <ol className="strip" ref={strip} aria-label={p.stripLabel} style={{ ['--fill-n' as string]: fill.toFixed(4) }}>
          {ids.slice(first).map((id, k) => {
            const i = first + k;
            const label = stopLabel(name(i));
            // Dimmed only when reached by a tap or GPS, or passed by a live GPS position; never by the
            // timetable or an estimate.
            const live = (progress.basis === 'phone_gps' || progress.basis === 'bus_gps') && !progress.projected;
            const passed = i <= progress.reachedIndex || (live && i < progress.position - 0.05);
            const stopState = i === alightIndex ? 'alight' : i === nextIndex && !atEnd ? 'next' : passed ? 'passed' : 'ahead';
            const reached = state.milestones.find((m) => m.index === i);
            return (
              <li key={`${id}-${i}`} data-i={i} data-state={stopState} data-reached={passed || undefined} data-current={i === currentIndex || undefined}>
                {/* The visible words are the button's name; the hidden ones only join them into a sentence. */}
                <button className="strip-stop" onClick={() => tap(i)}>
                  <span className="strip-name">{i === currentIndex && <span>{p.at} · </span>}{label.town}{label.detail && <small><span className="sr-only">, </span>{label.detail}</small>}</span>
                  <span className="sr-only">{reached ? p.srReached : p.srScheduled}</span>
                  <span className="strip-dot" aria-hidden="true" />
                  <span className="strip-time">{reached ? clock(reached.at) : clock(stopTimes[i]!.at, stopTimes[i]!.estimated)}</span>
                  <span className="sr-only">{i === alightIndex ? p.srYours : ''}{p.srTap}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="muted small">{p.tapHelp}</p>
      {located && <>
        <button className="ghost" aria-expanded={!state.hideMap} onClick={() => update({ ...state, hideMap: !state.hideMap })}>{state.hideMap ? p.showMap : p.hideMap}</button>
        {!state.hideMap && (() => {
          // From the boarding stop on, like the strip.
          const mapStops: MapStop[] = ids.slice(first).map((_, k) => {
            const i = first + k;
            const s = stops[i] as { lat: number; lon: number };
            const passed = i <= progress.reachedIndex;
            return { id: ids[i]!, city: stops[i]?.city, lat: s.lat, lon: s.lon, name: stopLabel(name(i)).town, current: i === currentIndex, state: i === alightIndex ? 'alight' : i === nextIndex && !atEnd ? 'next' : passed ? 'passed' : 'ahead' };
          });
          // The bus dot: the GPS fix itself when that is the evidence, otherwise a point on the line.
          const fix = progress.basis === 'bus_gps' ? bus : progress.basis === 'phone_gps' ? phone : undefined;
          const at = (q: number) => {
            const r = q - first;
            const i = Math.max(0, Math.min(mapStops.length - 2, Math.floor(r)));
            const f = Math.max(0, Math.min(1, r - i));
            return { lat: mapStops[i]!.lat + f * (mapStops[i + 1]!.lat - mapStops[i]!.lat), lon: mapStops[i]!.lon + f * (mapStops[i + 1]!.lon - mapStops[i]!.lon) };
          };
          const dot = fix && !progress.projected ? { lat: fix.lat, lon: fix.lon } : at(progress.position);
          const dark = document.documentElement.dataset.skin !== 'clean'
            || document.documentElement.dataset.theme === 'dark'
            || (document.documentElement.dataset.theme !== 'light' && matchMedia?.('(prefers-color-scheme: dark)').matches);
          return <>
            <StreetMap text={t.maps} stops={mapStops} bus={dot} dark={!!dark} label={p.mapLabel(nextLabel.town, stopLabel(name(alightIndex)).town)} failedText={p.mapFailed} loadingText={p.mapLoading} />
            <p className="muted small">{progress.basis === 'timetable' || progress.projected ? p.mapDotEstimate : p.mapDotSeen}</p>
            <p className="muted small">{p.mapNote}</p>
          </>;
        })()}
      </>}
      {undo && <button className="ghost" onClick={() => { update({ ...state, milestones: undo }); setUndo(undefined); }}>{p.undo}</button>}

      {located ? <>
        <label className="lock-toggle"><input type="checkbox" checked={state.follow} onChange={(e) => { update({ ...state, follow: e.target.checked }); if (!e.target.checked) setGps('off'); }} />{p.follow}</label>
        <p className="muted small">{p.followPrivacy}</p>
        {/* Not a live region: the accuracy changes with every fix, which would be read out each time. */}
        {state.follow && <p className="small">{gps === 'on' && phone ? p.gpsOn(Math.round(phone.accuracyM)) : p.gps[gps]}</p>}
        {/* Only the state is announced (asking, on, off, errors), once each, never the accuracy. */}
        <span className="sr-only" role="status">{state.follow ? p.gps[gps] : ''}</span>
      </> : <p className="muted small" role="note">{p.noLocations}</p>}
    </div>
  );
}
