import { useRouteGeometry } from './useRouteGeometry';
import { RouteDistance } from './RouteDistance';
import { reportedRouteDistance } from '../domain/routeDistance';
import { liveApiUrl } from '../domain/liveBus';
import { LiveIndicator } from './LiveIndicator';
import { DestinationArrival } from './DestinationArrival';
import { WaitingMap } from './WaitingMap';
import { gpsLost, offerAlternatives } from '../domain/alternatives';
import { Alternatives } from './Alternatives';
import { SignalWarning } from './SignalWarning';
import { useEffect, useRef, type ReactNode } from 'react';
import { getScheduleProjection, type BusSession, type BusSessionEvent } from '../domain/busLock';
import { timetablePosition } from '../domain/tripProgress';
import { tripStopTimes } from '../domain/schedule';
import { formatTime12 } from '../domain/time';
import type { Dataset } from '../domain/types';
import type { Lang, Strings } from './i18n';
import { BackupDeadlines } from './BackupDeadlines';
import type { RescueOption } from '../domain/rescue';
import { RideMode } from './RideMode';
import { ShareUpdate } from './ShareUpdate';
import { useScreenWakeLock } from './useScreenWakeLock';

const terminalLock = (session: BusSession) => ['needs_confirmation', 'cancelled', 'ended'].includes(session.lock.status) || ['ended', 'left'].includes(session.phase);

interface Props {
  ds: Dataset;
  session: BusSession;
  /** Where the rider gets off in the trip's stop list; not after the boarding stop when no destination is set. */
  alightIndex: number;
  now: number;
  t: Strings;
  lang: Lang;
  keepAwake: boolean;
  onKeepAwake: (value: boolean) => void;
  onEvent: (event: BusSessionEvent) => void;
  onAdvanceDemo: (minutes: number) => void;
  onUnlock: () => void;
  /** Backup buses while waiting (issue #59): gate line, route badge, and opening one (never changing the lock). */
  gateText: (o: RescueOption) => string | undefined;
  badge: (routeId: string) => ReactNode;
  onOpenBackup: (o: RescueOption) => void;
  onAlternatives: () => void;
  onPenn: () => void;
}

/** The view accepts evidence; it never polls NJ Transit or requests the rider's location. */
export function BusLockPanel({ ds, session, alightIndex, now, t, lang, keepAwake, onKeepAwake, onEvent, onAdvanceDemo, onUnlock, gateText, badge, onOpenBackup, onAlternatives, onPenn }: Props) {
  const b = t.busLock;
  const { departure: dep, lock } = session;
  const heading = useRef<HTMLHeadingElement>(null);
  const waiting = session.phase === 'waiting' && !['cancelled', 'ended'].includes(lock.status);
  const wake = useScreenWakeLock(waiting && keepAwake);
  const clock = (at: number) => formatTime12(at, ds.meta.timezone, lang);
  const stopName = (id: string) => ds.stops.find((s) => s.id === id)?.name ?? id;
  const stopTimes = tripStopTimes(ds, dep);
  const projection = getScheduleProjection(session, stopTimes, now);
  // Only a previously reporting bus gets the owner's moving estimate after a lost signal.
  // A never-observed, overdue bus must not appear to have passed someone still waiting.
  const showScheduleMarker = projection.kind !== 'unavailable' && (projection.kind !== 'overdue_unknown' || gpsLost(session, now));
  const last = lock.last;
  const lastRecord = session.history.slice().reverse().find((p) => p.vehicleId === last?.vehicleId && p.observedAt === last?.observedAt);
  const geometry = useRouteGeometry(ds, liveApiUrl(import.meta.env.VITE_LIVE_API_URL));
  const routeDistance = lastRecord?.source === 'official' && !session.stopChanges?.indices.length && !terminalLock(session) ? reportedRouteDistance(ds, geometry, dep.tripId, dep.serviceDate,
    session.phase === 'onboard' ? alightIndex : dep.stopIndex, last, now, lastRecord.receivedAt, lock.vehicleId) : undefined;
  if (routeDistance && lock.status !== 'tracked') routeDistance.stale = true;
  const date = dep.serviceDate;
  const dateText = lang === 'es' ? `${+date.slice(6, 8)}/${+date.slice(4, 6)}/${date.slice(0, 4)}` : `${+date.slice(4, 6)}/${+date.slice(6, 8)}/${date.slice(0, 4)}`;
  const minutesPast = Math.max(0, Math.floor((now - dep.departs) / 60_000));
  const terminal = session.phase === 'left' || session.phase === 'ended';
  const passed = session.reports.some((report) => report.kind === 'passed_without_stopping');
  // Capacity: only from someone who saw the bus (arrived, on board, or it passed them by).
  const canReportCapacity = !terminal && (session.phase === 'arrived' || session.phase === 'onboard' || (waiting && passed));
  const capacityReport = session.reports.find((report) => report.kind === 'capacity');

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start' });
  }, [session.id]);
  // After "I got off" or leaving the stop, the ride view is gone: put focus back on Bus Lock.
  useEffect(() => { if (session.phase === 'ended' || session.phase === 'left') heading.current?.focus({ preventScroll: true }); }, [session.phase]);

  function record(type: 'start_waiting' | 'no_bus' | 'arrived' | 'boarded' | 'left' | 'passed_without_stopping' | 'end') {
    onEvent({ type, now });
  }

  // These controls exist only on the explicit, banner-marked invented dataset.
  function simulateGps(replacement = false) {
    if (!ds.meta.demo) return;
    const upstream = Math.max(0, dep.stopIndex - 1);
    const a = ds.stops.find((s) => s.id === dep.pattern.stopIds[upstream]);
    const z = ds.stops.find((s) => s.id === dep.pattern.stopIds[dep.stopIndex]);
    if (a?.lat === undefined || a.lon === undefined || z?.lat === undefined || z.lon === undefined) return;
    const vehicleId = replacement ? 'DEMO-REPLACEMENT' : lock.vehicleId ?? 'DEMO-BUS';
    const observations = replacement
      ? [{ lat: a.lat, lon: a.lon, observedAt: now - 1_000 }]
      : [
        { lat: a.lat, lon: a.lon, observedAt: now - 90_000 },
        { lat: (a.lat + z.lat) / 2, lon: (a.lon + z.lon) / 2, observedAt: now - 15_000 },
      ];
    for (const position of observations) onEvent({ type: 'observation', obs: { ...position, vehicleId, tripInstanceId: dep.tripInstanceId }, source: 'demo', receivedAt: now });
  }

  const nearestStop = last ? ds.stops.filter((s) => dep.pattern.stopIds.includes(s.id) && s.lat !== undefined && s.lon !== undefined)
    .sort((a, z) => (a.lat! - last.lat) ** 2 + (a.lon! - last.lon) ** 2 - ((z.lat! - last.lat) ** 2 + (z.lon! - last.lon) ** 2))[0] : undefined;

  return (
    <section className="card bus-lock" aria-labelledby="bus-lock-heading">
      <div className="row-between lock-heading">
        <h2 id="bus-lock-heading" tabIndex={-1} ref={heading}>{b.title}</h2>
        <button className="ghost" onClick={onUnlock}>{t.unlockBus}</button>
      </div>
      <p className="lock-route">{dep.pattern.headsign}</p>
      <p className="small">{b.schedule(dateText, `${dep.estimated ? '~' : ''}${clock(dep.departs)}`, stopName(dep.pattern.stopIds[dep.stopIndex]!))}</p>
      {dep.estimated && <p className="muted small">{t.estimatedNote}</p>}
      <p className={`lock-status ${lock.status === 'tracked' && lastRecord?.source === 'official' ? 'live-glow' : ''}`} data-status={lock.status}>
        {lastRecord?.source !== 'demo' && !terminal && <LiveIndicator live={lock.status === 'tracked' && lastRecord?.source === 'official'} />}
        {lock.status === 'tracked' && !lastRecord ? b.sourceUnknown
          : lock.status === 'tracked' && lastRecord?.source === 'demo' ? b.demoLive : t.lockStatus[lock.status]}
      </p>
      {!ds.meta.demo && !ds.meta.realtime && <p className="muted small">{b.liveUnavailable}</p>}

      {session.phase !== 'onboard' && <RouteDistance value={routeDistance} lang={lang} now={now} />}
      {session.phase !== 'onboard' && <DestinationArrival ds={ds} session={session} index={alightIndex} now={now} t={t} lang={lang} onEvent={onEvent} />}
      {(!ds.meta.realtime || ds.meta.demo) && <SignalWarning session={session} now={now} t={t} estimated={!terminal && !passed && ['scheduled_only', 'stale', 'vanished'].includes(lock.status) && showScheduleMarker} />}
      {offerAlternatives(session, now) && <Alternatives t={t} onBuses={onAlternatives} onGuide={onPenn} />}
      <div className="lock-waiting">
        <p className="lock-phase" role="status">{b.phase[session.phase]}</p>
        {session.waitingSince !== undefined && <p className="small">{b.waitSince(clock(session.waitingSince))}</p>}
        {waiting && !passed && now >= dep.departs && <p className="warn small">{b.due(minutesPast)}</p>}
        {waiting && session.waitingSince !== undefined && session.waitingSince > dep.departs && <p className="small">{b.lateStart}</p>}
        {session.phase === 'viewing' && lock.status !== 'cancelled' && <button className="primary wide" onClick={() => record('start_waiting')}>{b.begin}</button>}
        {waiting && <>
          <div className="lock-actions">
            <button className="primary" disabled={passed || now < dep.departs} onClick={() => record('no_bus')}>{b.noBus}</button>
            <button onClick={() => record('arrived')}>{b.arrived}</button>
            <button onClick={() => record('passed_without_stopping')}>{b.passed}</button>
            <button onClick={() => record('left')}>{b.left}</button>
          </div>
          {passed && <p className="warn small">{b.passedHelp}</p>}
          <BackupDeadlines ds={ds} session={session} alightIndex={alightIndex} now={now} t={t} lang={lang} gateText={gateText} badge={badge} onOpen={onOpenBackup} />
          {now < dep.departs && <p className="muted small">{b.beforeDue}</p>}
          <label className="lock-toggle"><input type="checkbox" checked={keepAwake} onChange={(e) => onKeepAwake(e.target.checked)} />{b.keepAwake}</label>
          <p className="small" data-testid="wake-status" role="status">{b.wake[wake.status]}</p>
          {keepAwake && wake.status === 'unavailable' && <button className="ghost" onClick={wake.retry}>{b.wakeRetry}</button>}
          <p className="muted small">{b.foregroundOnly}</p>
        </>}
        {/* After NJ Transit cancels the trip the waiting controls go, but the backups are what matter. */}
        {session.phase === 'waiting' && lock.status === 'cancelled' && <BackupDeadlines ds={ds} session={session} alightIndex={alightIndex} now={now} t={t} lang={lang} gateText={gateText} badge={badge} onOpen={onOpenBackup} />}
        {session.phase === 'arrived' && <div className="lock-actions"><button className="primary" onClick={() => record('boarded')}>{b.boarded}</button><button onClick={() => record('left')}>{b.left}</button></div>}
        {session.phase === 'onboard' && <><RideMode routeDistance={routeDistance} ds={ds} session={session} alightIndex={alightIndex} now={now} t={t} lang={lang} onEvent={onEvent} onAdvanceDemo={onAdvanceDemo} gateText={gateText} badge={badge} onOpenTrip={onOpenBackup} /><p className="small">{b.ridePrivacy}</p><button onClick={() => record('end')}>{b.stopRide}</button></>}
        {/* On board, ride mode carries its own share button (it may fill the screen). */}
        {session.phase !== 'onboard' && <ShareUpdate ds={ds} session={session} alightIndex={alightIndex} now={now} t={t} lang={lang} />}
        {canReportCapacity && <div className="lock-capacity">
          <p className="small">{b.capacityQ}</p>
          <div className="choice-list">
            {(['seats', 'standing', 'full'] as const).map((level) => (
              <button key={level} className="chip" aria-pressed={capacityReport?.capacity === level} onClick={() => onEvent({ type: 'capacity', level, now })}>{b.capacity[level]}</button>
            ))}
          </div>
          {capacityReport?.capacity && <p className="small" role="status">{b.capacityYou(b.capacity[capacityReport.capacity], clock(capacityReport.reportedAt))}</p>}
          <p className="muted small">{b.capacityLimits}</p>
        </div>}
        <p className="muted small">{b.noBusMeaning}</p>
        <p className="lock-local small" role="note">{b.localOnly}</p>
        {!ds.meta.demo && <p className="muted small">{b.keptOnPhone}</p>}
      </div>

      {lock.status === 'needs_confirmation' && lock.pending && <div className="warn">
        <p>{b.conflict}</p><p>{b.candidate(lock.pending.vehicleId)}</p>
        {lock.pending.tripInstanceId === dep.tripInstanceId
          ? <button onClick={() => onEvent({ type: 'confirm_pending', now })}>{b.acceptVehicle}</button>
          : <p>{b.otherTrip}</p>}
        <button onClick={() => onEvent({ type: 'reject_pending', now })}>{b.keepVehicle}</button>
      </div>}

      <dl className="lock-facts">
        <div><dt>{b.vehicle}</dt><dd>{lock.vehicleId ?? b.notLinked}</dd></div>
        <div><dt>{b.lastGps}</dt><dd>{last ? <>{clock(last.observedAt)} · {b.age(Math.max(0, Math.floor((now - last.observedAt) / 1000)))}</> : b.noGps}</dd></div>
      </dl>
      {last && <div className="lock-location">
        <h3>{b.position}</h3>
        <p className="small">{lastRecord ? b.source[lastRecord.source] : b.sourceUnknown} · {clock(last.observedAt)}</p>
        <p className="coordinates">{last.lat.toFixed(5)}, {last.lon.toFixed(5)}</p>
        {nearestStop && <p className="small">{b.near(nearestStop.name)}</p>}
        {lastRecord && <p className="muted small">{b.received}: {clock(lastRecord.receivedAt)}</p>}
      </div>}

      {!terminal && !passed && !['tracked', 'cancelled', 'needs_confirmation'].includes(lock.status) && <div className="lock-estimate" data-testid="schedule-projection">
        <p className="lock-estimate-label">{b.estimated}</p>
        {stopTimes.length > 1 && showScheduleMarker && <progress className="schedule-progress" aria-label={b.estimated} max={stopTimes.length - 1} value={timetablePosition(stopTimes.map((s) => s.at), now)} />}
        <p>{projection.kind === 'between' && projection.fromIndex !== undefined && projection.toIndex !== undefined
          ? b.between(stopName(stopTimes[projection.fromIndex]!.stopId), stopName(stopTimes[projection.toIndex]!.stopId))
          : projection.kind === 'before_start' ? b.beforeStart
            : projection.kind === 'after_end' ? b.afterEnd
              : projection.kind === 'overdue_unknown' ? b.overdue : b.estimateUnavailable}</p>
        <p className="small">{projection.kind === 'overdue_unknown' ? b.overdueHelp : b.estimateHelp}</p>
      </div>}

      <details className="lock-history" open={session.reports.length > 0}>
        <summary>{b.reportHistory} ({session.reports.length})</summary>
        {!session.reports.length && <p className="muted small">{b.reportsEmpty}</p>}
        <ol>{session.reports.slice().reverse().map((report, i) => <li key={`${report.reportedAt}-${report.kind}-${i}`}>
          <strong>{b.report[report.kind]}{report.capacity ? `: ${b.capacity[report.capacity]}` : ''}</strong><span>{clock(report.reportedAt)}</span>
          {report.kind === 'no_bus' && report.waitingSince !== undefined && <p className="small">{b.coverage(clock(report.waitingSince), clock(report.reportedAt))}</p>}
        </li>)}</ol>
      </details>
      <details className="lock-history">
        <summary>{b.history} ({session.history.length})</summary>
        <p className="muted small">{b.historyHelp}</p>
        {!session.history.length && <p className="muted small">{b.historyEmpty}</p>}
        <ol>{session.history.slice().reverse().map((point) => <li key={`${point.vehicleId}-${point.observedAt}`}>
          <strong>{clock(point.observedAt)}</strong><span>{b.source[point.source]} · {point.vehicleId}</span>
          <p className="small coordinates">{point.lat.toFixed(5)}, {point.lon.toFixed(5)}</p>
          <p className="muted small">{b.received}: {clock(point.receivedAt)}</p>
        </li>)}</ol>
      </details>
      {ds.meta.transcribed && <p className="muted small">{b.noMap}</p>}
      {ds.meta.realtime && !terminal && !passed && session.phase !== 'onboard' && <WaitingMap ds={ds} session={session} alightIndex={alightIndex} now={now} t={t}
        estimate={!['tracked', 'cancelled', 'needs_confirmation'].includes(lock.status) && showScheduleMarker} />}
      {ds.meta.demo && !terminal && <details className="lock-demo">
        <summary>{b.demoControls}</summary>
        <p className="small">{b.demoClock(clock(now))}</p>
        <div className="choice-list">
          <button onClick={() => simulateGps()}>{b.demoFresh}</button>
          <button onClick={() => onAdvanceDemo(3)}>{b.demoStale}</button>
          <button onClick={() => onAdvanceDemo(12)}>{b.demoLost}</button>
          <button disabled={!lock.vehicleId} onClick={() => simulateGps(true)}>{b.demoReplacement}</button>
        </div>
      </details>}
    </section>
  );
}
