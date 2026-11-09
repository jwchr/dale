import { RouteDistance } from './RouteDistance';
import type { ReportedRouteDistance } from '../domain/routeDistance';
import { DestinationArrival } from './DestinationArrival';
// Ride mode (issue #34): shown after the rider says "I boarded". Big get-off guidance when Dale can
// honestly count stops (every stop listed, fresh unambiguous bus GPS); otherwise a plain statement of
// what it cannot know, with scheduled times labeled as timetable. Foreground only: no background alerts.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { BusSession, BusSessionEvent } from '../domain/busLock';
import { distanceM } from '../domain/direction';
import { rideGuide, STAGE_RANK, type RideStage } from '../domain/rideGuide';
import { tripStopTimes } from '../domain/schedule';
import { formatTime12 } from '../domain/time';
import type { Dataset } from '../domain/types';
import type { Lang, Strings } from './i18n';
import type { RescueOption } from '../domain/rescue';
import { Recovery } from './Recovery';
import { ShareUpdate } from './ShareUpdate';
import { StripMap } from './StripMap';
import { useScreenWakeLock } from './useScreenWakeLock';

interface Props {
  routeDistance?: ReportedRouteDistance;
  ds: Dataset;
  session: BusSession;
  alightIndex: number;
  now: number;
  t: Strings;
  lang: Lang;
  onEvent: (event: BusSessionEvent) => void;
  /** Invented demo only: moves the demo clock, so each simulated position is newer than the last. */
  onAdvanceDemo: (minutes: number) => void;
  /** For missed-stop and wrong-bus recovery (issue #60). */
  gateText: (o: RescueOption) => string | undefined;
  badge: (routeId: string) => ReactNode;
  onOpenTrip: (o: RescueOption) => void;
}

// Per-viewer conveniences only; the page works the same when storage is unavailable.
const PREFS = 'arriba.ride.v1';
const readPrefs = (): { large: boolean; vibrate: boolean; awake: boolean } => {
  try {
    const p = JSON.parse(window.localStorage.getItem(PREFS) ?? '{}') as { large?: boolean; vibrate?: boolean; awake?: boolean };
    return { large: p.large !== false, vibrate: p.vibrate === true, awake: p.awake === true };
  } catch { return { large: true, vibrate: false, awake: false }; }
};
/** Whether a ride's guidance fills the screen; it does when first boarding, until the rider exits it. */
const fullBySession = new Map<string, boolean>();
/** Highest alert stage already given per Bus Lock session, so jitter or a remount never repeats one. */
const alerted = new Map<string, number>();
const URGENT: RideStage[] = ['one', 'request', 'last_next', 'arrived', 'passed'];

export function RideMode({ routeDistance, ds, session, alightIndex, now, t, lang, onEvent, onAdvanceDemo, gateText, badge, onOpenTrip }: Props) {
  const r = t.ride;
  const dep = session.departure;
  const stopName = (id: string) => ds.stops.find((s) => s.id === id)?.name ?? id;
  const clock = (at: number) => formatTime12(at, ds.meta.timezone, lang);
  const [prefs, setPrefs] = useState(readPrefs);
  const setPref = (p: Partial<typeof prefs>) => setPrefs((old) => {
    const next = { ...old, ...p };
    try { window.localStorage.setItem(PREFS, JSON.stringify(next)); } catch { /* not saved */ }
    return next;
  });
  const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  const hasDestination = alightIndex > dep.stopIndex;
  const [full, setFullState] = useState(() => fullBySession.get(session.id) ?? true);
  const setFull = (v: boolean) => { fullBySession.set(session.id, v); setFullState(v); };
  // Keep the screen on during the ride only if the rider asks, and only while ride mode is showing.
  const wake = useScreenWakeLock(prefs.awake && hasDestination);
  // Full screen steps aside while the rider must decide about a changed vehicle (the buttons are below).
  const showFull = full && hasDestination && session.lock.status !== 'needs_confirmation';
  const heading = useRef<HTMLHeadingElement>(null);
  // Focus follows the view: into the dialog when it opens, onto the in-page heading when it closes.
  const opened = useRef(false);
  useEffect(() => { if (showFull || opened.current) heading.current?.focus(); opened.current = true; }, [showFull]);
  // While full screen, the rest of the app is unreachable (inert) and does not scroll underneath.
  useEffect(() => {
    if (!showFull) return;
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { root?.removeAttribute('inert'); document.body.style.overflow = overflow; };
  }, [showFull]);
  useEffect(() => {
    if (!showFull) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showFull]); // eslint-disable-line react-hooks/exhaustive-deps
  const guide = hasDestination && session.stopChanges?.indices.length ? { basis: 'uncertain' as const, reason: 'service_change' as const } : hasDestination ? rideGuide(ds, dep.pattern.stopIds, dep.stopIndex, alightIndex, session.lock, now, session.history) : undefined;
  const times = tripStopTimes(ds, dep);
  const dest = hasDestination ? stopName(dep.pattern.stopIds[alightIndex]!) : '';
  const stage = guide?.basis === 'gps' ? guide.stage : undefined;

  // Vibrate only when the countdown moves forward to 3, 2, 1 or "ask now", once each, if turned on.
  // The stage showing when ride mode first opens is the baseline: opening the view does not buzz.
  useEffect(() => {
    const rank = stage ? STAGE_RANK[stage] : -1;
    const before = alerted.get(session.id);
    if (before === undefined) { alerted.set(session.id, rank); return; }
    if (rank <= before) return;
    alerted.set(session.id, rank);
    if (prefs.vibrate && canVibrate && rank >= 1 && rank <= 4) navigator.vibrate([200, 100, 200]);
  }, [stage, session.id, prefs.vibrate, canVibrate]);

  if (!hasDestination || !guide) return <p className="small">{r.noDestination}</p>;

  const message = guide.basis === 'gps'
    ? guide.stage === 'arrived' ? r.arrived(dest)
      : guide.stage === 'passed' ? r.passed(dest)
        : guide.stage === 'request' ? r.request(dest)
          : guide.stage === 'last_next' ? r.lastNext(dest)
            : guide.stage === 'one' ? r.one(dest)
              : r.stopsTo(guide.stopsAway, dest)
    : guide.basis === 'timetable_only' ? r.timetableOnly : r.uncertain[guide.reason];
  const after = guide.basis === 'gps' ? guide.reachedIndex : dep.stopIndex;
  const upcoming = times.map((x, i) => ({ ...x, i })).filter((x) => x.i > after && x.i <= alightIndex);

  // Invented demo only: the simulated bus reports from the next stop's coordinates after the time a bus
  // would take at about 10 m/s, so the ride guide's speed check sees a believable trip.
  function demoNextStop() {
    if (!ds.meta.demo) return;
    const from = guide && guide.basis === 'gps' ? guide.reachedIndex : dep.stopIndex;
    const next = Math.min(from + 1, alightIndex);
    const a = ds.stops.find((s) => s.id === dep.pattern.stopIds[from]);
    const stop = ds.stops.find((s) => s.id === dep.pattern.stopIds[next]);
    if (stop?.lat === undefined || stop.lon === undefined) return;
    const metres = a?.lat !== undefined && a.lon !== undefined ? distanceM({ lat: a.lat, lon: a.lon }, { lat: stop.lat, lon: stop.lon }) : 600;
    const minutes = Math.max(1, Math.ceil(metres / 10 / 60));
    const later = now + minutes * 60_000;
    onAdvanceDemo(minutes);
    onEvent({ type: 'observation', obs: { tripInstanceId: dep.tripInstanceId, vehicleId: session.lock.vehicleId ?? 'DEMO-BUS', observedAt: later, lat: stop.lat, lon: stop.lon }, source: 'demo', receivedAt: later });
  }

  const view = (
    <div className={showFull ? 'ride-mode ride-full' : 'ride-mode'} data-large={prefs.large ? 'true' : undefined} data-stage={stage ?? guide.basis}
      {...(showFull ? { role: 'dialog', 'aria-modal': true, 'aria-labelledby': `ride-title-${session.id}` } : {})}>
      {/* The page's DEMO notice is covered in full screen, so it repeats here. */}
      {showFull && ds.meta.demo && <div className="demo-banner" role="note">{t.demoBanner}</div>}

      <div className="row-between ride-top">
        <h3 id={`ride-title-${session.id}`} tabIndex={-1} ref={heading}>{r.title(dest)}</h3>
        <button className="ghost" onClick={() => setFull(!showFull)}>{showFull ? r.exitFull : r.fullScreen}</button>
      </div>
      <RouteDistance value={routeDistance} lang={lang} now={now} onboard />
      <DestinationArrival ds={ds} session={session} index={alightIndex} now={now} t={t} lang={lang} onEvent={onEvent} />
      {!session.stopChanges?.indices.length && <StripMap ds={ds} session={session} alightIndex={alightIndex} now={now} t={t} lang={lang} />}
      <p className="ride-message" aria-live={stage && URGENT.includes(stage) ? 'assertive' : 'polite'}>{message}</p>
      {guide.basis === 'gps' && <p className="small">{session.history.at(-1)?.source === 'demo' ? r.demoGps : r.fromGps(clock(guide.observedAt), Math.max(0, Math.floor((now - guide.observedAt) / 1000)))}</p>}
      {guide.basis !== 'gps' && times[alightIndex] && <p className="small">{r.scheduledAt(`${times[alightIndex]!.estimated ? '~' : ''}${clock(times[alightIndex]!.at)}`)}</p>}
      <div className="row-between ride-controls">
        <button className="ghost" onClick={() => setPref({ large: !prefs.large })}>{prefs.large ? r.smaller : r.larger}</button>
        <label className="lock-toggle"><input type="checkbox" checked={prefs.vibrate} disabled={!canVibrate} onChange={(e) => setPref({ vibrate: e.target.checked })} />{r.vibrate}</label>
        <label className="lock-toggle"><input type="checkbox" checked={prefs.awake} onChange={(e) => setPref({ awake: e.target.checked })} />{r.keepAwake}</label>
      </div>
      {prefs.awake && <p className="small" role="status" data-testid="ride-wake">{t.busLock.wake[wake.status]}</p>}
      {!canVibrate && <p className="muted small">{r.vibrateUnsupported}</p>}
      <h4>{guide.basis === 'timetable_only' ? r.upcomingListed : r.upcoming}</h4>
      <ol className="stop-list ride-stops">
        {upcoming.map((x) => (
          <li key={`${x.stopId}-${x.i}`} data-role={x.i === alightIndex ? 'alight' : undefined}>
            <span className="stop-time">{x.estimated ? '~' : ''}{clock(x.at)}</span>
            <span className="stop-name">{stopName(x.stopId)}</span>
            {x.i === alightIndex && <span className="tag tag-alight">{t.getOffHere}</span>}
          </li>
        ))}
      </ol>
      <p className="muted small">{r.ticket}</p>
      <p className="muted small">{r.foreground}</p>
      {ds.meta.demo && guide.basis !== 'timetable_only' && <button onClick={demoNextStop}>{r.demoNext}</button>}
      <Recovery sessionId={session.id} ds={ds} dep={dep} alightIndex={alightIndex} now={now} t={t} lang={lang} gateText={gateText} badge={badge} onOpen={onOpenTrip} />
      <ShareUpdate ds={ds} session={session} alightIndex={alightIndex} now={now} t={t} lang={lang} />
      <button className="primary wide ride-off" onClick={() => onEvent({ type: 'end', now })}>{r.gotOff}</button>
    </div>
  );
  // Outside the app root, so the root can be inert without taking the dialog with it.
  return showFull ? createPortal(view, document.body) : view;
}
