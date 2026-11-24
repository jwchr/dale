import { routeLabel, routeList, routeHeadsign } from '../domain/routeDisplay';
// "I missed my stop" / "wrong bus" (issue #60), inside ride mode. The rider says what happened and
// where they are; Dale lists scheduled ways back to their original stop. It never changes the lock.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { recoveryOptions, recoveryStops, type RecoveryKind } from '../domain/recovery';
import type { RescueOption } from '../domain/rescue';
import { formatTime12, localYmd } from '../domain/time';
import type { Dataset, Departure } from '../domain/types';
import type { Lang, Strings } from './i18n';

/** Recovery steps per Bus Lock session, so leaving or entering full screen keeps the rider's place. */
const steps = new Map<string, { open: boolean; kind?: RecoveryKind; at?: string; notListed?: boolean }>();

interface Props {
  sessionId: string;
  ds: Dataset; dep: Departure; alightIndex: number; now: number; t: Strings; lang: Lang;
  gateText: (o: RescueOption) => string | undefined;
  badge: (routeId: string) => ReactNode;
  onOpen: (o: RescueOption) => void;
}

export function Recovery({ sessionId, ds, dep, alightIndex, now, t, lang, gateText, badge, onOpen }: Props) {
  const r = t.recovery;
  const [state, setState] = useState(() => steps.get(sessionId) ?? { open: false });
  const update = (next: typeof state) => { steps.set(sessionId, next); setState(next); };
  const { open, kind, at, notListed } = state;
  const setOpen = (v: boolean) => update(v ? { ...state, open: true } : { open: false });
  const setKind = (k: RecoveryKind) => update({ open: true, kind: k });
  const setAt = (id: string) => update({ ...state, at: id });
  const step = useRef<HTMLHeadingElement>(null);
  // Focus the step heading when the rider moves between steps (not when the view is rebuilt).
  const shown = useRef(`${open}|${kind}|${at}`);
  useEffect(() => {
    const key = `${open}|${kind}|${at}`;
    if (open && key !== shown.current) step.current?.focus();
    shown.current = key;
  }, [open, kind, at]);
  // Closing returns focus to the button that opened it.
  const opener = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => { if (!open && wasOpen.current) opener.current?.focus(); wasOpen.current = open; }, [open]);
  const name = (id: string) => ds.stops.find((s) => s.id === id)?.name ?? id;
  const clock = (ms: number, estimated: boolean) => `${estimated ? '~' : ''}${formatTime12(ms, ds.meta.timezone, lang)}`;
  const dest = dep.pattern.stopIds[alightIndex]!;
  const today = localYmd(now, ds.meta.timezone);
  const day = (ms: number) => localYmd(ms, ds.meta.timezone) === today ? ''
    : `${new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'short', timeZone: ds.meta.timezone }).format(new Date(ms))} `;

  // Worked out once a minute (the clock ticks every second during a lock).
  const minute = Math.floor(now / 60_000);
  const listed = useMemo(() => (kind && at ? recoveryOptions(ds, at, dest, minute * 60_000) : undefined), [ds, kind, at, dest, minute]);
  // The list is worked out once a minute; a bus that has left drops off with the live clock.
  const result = listed && { ...listed, options: listed.options.filter((o) => o.dep.departs >= now) };
  if (!open) return <button ref={opener} className="ghost recovery-open" onClick={() => setOpen(true)}>{r.open}</button>;
  const reset = () => update({ open: true });
  return (
    <section className="recovery" aria-labelledby={`recovery-step-${dep.tripInstanceId}`}>
      {!kind ? <>
        <h4 id={`recovery-step-${dep.tripInstanceId}`} tabIndex={-1} ref={step}>{r.what}</h4>
        <div className="choice-list">
          {(['missed', 'passed', 'wrong_bus'] as const).map((k) => <button key={k} onClick={() => setKind(k)}>{r.kind[k]}</button>)}
        </div>
      </> : !at ? <>
        <h4 id={`recovery-step-${dep.tripInstanceId}`} tabIndex={-1} ref={step}>{r.where}</h4>
        <p className="small">{kind === 'wrong_bus' ? r.whereWrong(routeLabel(dep.route.shortName, t.gateTurnpikeExpress)) : r.whereMissed}</p>
        {(() => {
          const stops = recoveryStops(ds, dep, alightIndex, kind);
          return stops.length ? <div className="choice-list">{stops.map((id) => <button key={id} className="chip" onClick={() => setAt(id)}>{name(id)}</button>)}</div>
            : <p className="warn small">{r.noStops}</p>;
        })()}
        {kind === 'wrong_bus' && <>
          <button className="ghost" aria-expanded={!!notListed} onClick={() => update({ ...state, notListed: !notListed })}>{r.notListed}</button>
          {notListed && <p className="small">{r.notListedHelp(routeLabel(dep.route.shortName, t.gateTurnpikeExpress))}</p>}
        </>}
      </> : result && <>
        <h4 id={`recovery-step-${dep.tripInstanceId}`} tabIndex={-1} ref={step}>{r.waysBack(name(dest))}</h4>
        <p className="small">{r.from(name(at))}</p>
        {!result.options.length && <p className="warn small" role="note">{result.otherSideUnknown === 'here' ? r.otherSideUnknown(name(at)) : result.otherSideUnknown === 'destination' ? r.otherSideUnknownDest(name(dest)) : r.none}</p>}
        <ol className="rescue-list">
          {result.options.map((o) => {
            const gate = gateText(o);
            return (
              <li key={o.dep.tripInstanceId}>
                <button className="dep" onClick={() => onOpen(o)}>
                  {badge(o.dep.route.id)}
                  <span className="dep-main">
                    <span className="dep-sub">{routeHeadsign(o.dep.pattern.headsign, o.dep.route.shortName, t.gateTurnpikeExpress)}</span>
                    <span className="dep-time">{day(o.dep.departs)}{clock(o.dep.departs, o.dep.estimated)}</span>
                    <span className="dep-sub">{t.rescue.arrives(clock(o.arrives, o.arrivesEstimated), name(o.alightStopId))}</span>
                    {o.acrossFromBoard && <span className="dep-sub">{t.rescue.acrossBoard(name(o.boardStopId))}</span>}
                    {o.acrossFromHome && <span className="dep-sub">{t.rescue.acrossHome}</span>}
                    {gate && <span className="dep-gate">{gate}</span>}
                  </span>
                  <span className="dep-right"><span className="badge-sched">{t.scheduledOnly}</span></span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="muted small">{t.rescue.coverage(routeList(result.routesSearched, t.gateTurnpikeExpress))}</p>
        <p className="muted small">{t.rescue.noWalking}</p>
      </>}
      <p className="muted small">{r.keep}</p>
      <div className="edit-row">
        {kind && <button className="ghost" onClick={reset}>{r.startOver}</button>}
        <button className="ghost" onClick={() => setOpen(false)}>{r.close}</button>
      </div>
    </section>
  );
}
