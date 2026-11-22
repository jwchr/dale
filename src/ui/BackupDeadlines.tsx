import { routeHeadsign } from '../domain/routeDisplay';
// Backup buses while waiting (issue #59): shown once the locked bus is late past the rider's chosen
// threshold, or passed them. A choice only: opening one never changes the Bus Lock.
import { useMemo, useState, type ReactNode } from 'react';
import { backupDeadlines, DEFAULT_LATE, LATE_CHOICES, type LateChoice } from '../domain/backupDeadlines';
import type { BusSession } from '../domain/busLock';
import type { RescueOption } from '../domain/rescue';
import { formatTime12 } from '../domain/time';
import type { Dataset } from '../domain/types';
import type { Lang, Strings } from './i18n';

// A per-viewer convenience; works the same without storage.
const KEY = 'arriba.backupAfter.v1';
const readLate = (): LateChoice => {
  try { const n = Number(window.localStorage.getItem(KEY)); return (LATE_CHOICES as readonly number[]).includes(n) ? n as LateChoice : DEFAULT_LATE; } catch { return DEFAULT_LATE; }
};

interface Props {
  ds: Dataset; session: BusSession; alightIndex: number; now: number; t: Strings; lang: Lang;
  gateText: (o: RescueOption) => string | undefined;
  badge: (routeId: string) => ReactNode;
  onOpen: (o: RescueOption) => void;
}

export function BackupDeadlines({ ds, session, alightIndex, now, t, lang, gateText, badge, onOpen }: Props) {
  const b = t.backupBuses;
  const [late, setLate] = useState(readLate);
  const choose = (n: LateChoice) => { setLate(n); try { window.localStorage.setItem(KEY, String(n)); } catch { /* not saved */ } };
  // The list is worked out once a minute (the clock ticks every second during a lock); the session's
  // own changes (reports, lock status) re-run it. Minutes left always use the live clock, rounded
  // down, so they are never a minute optimistic, and a bus that has just left drops off at once.
  const minute = Math.floor(now / 60_000);
  const listed = useMemo(() => backupDeadlines(ds, session, alightIndex, minute * 60_000, late), [ds, session, alightIndex, minute, late]);
  const state = listed.show
    ? { ...listed, backups: listed.backups.filter((x) => x.option.dep.departs >= now).map((x) => ({ ...x, minutesLeft: Math.floor((x.option.dep.departs - now) / 60_000) })) }
    : listed;
  const name = (id: string) => ds.stops.find((s) => s.id === id)?.name ?? id;
  const clock = (at: number, estimated: boolean) => `${estimated ? '~' : ''}${formatTime12(at, ds.meta.timezone, lang)}`;
  return (
    <div className="backup-buses">
      <div className="choice-list" role="group" aria-label={b.threshold}>
        <span className="small">{b.threshold}</span>
        {LATE_CHOICES.map((n) => <button key={n} className="chip" aria-pressed={late === n} onClick={() => choose(n)}>{b.min(n)}</button>)}
      </div>
      {state.show && <section aria-labelledby="backup-buses-heading">
        <h3 id="backup-buses-heading">{b.title}</h3>
        <p className="small" role="status">{state.reason === 'cancelled' ? b.cancelledIntro : state.reason === 'passed' ? b.passedIntro : b.lateIntro(state.lateMin)}</p>
        {!state.backups.length && <p className="warn small" role="note">{b.none}</p>}
        <ol className="rescue-list">
          {state.backups.map(({ option: o, minutesLeft }) => {
            const gate = gateText(o);
            return (
              <li key={o.dep.tripInstanceId}>
                <button className="dep" onClick={() => onOpen(o)}>
                  {badge(o.dep.route.id)}
                  <span className="dep-main">
                    <span className="dep-sub">{routeHeadsign(o.dep.pattern.headsign, o.dep.route.shortName)}</span>
                    <span className="dep-time">{clock(o.dep.departs, o.dep.estimated)}</span>
                    <span className="dep-sub">{b.left(minutesLeft)}</span>
                    <span className="dep-sub">{t.rescue.arrives(clock(o.arrives, o.arrivesEstimated), name(o.alightStopId))}</span>
                    {o.acrossFromBoard && <span className="dep-sub">{b.across(name(o.boardStopId))}</span>}
                    {o.acrossFromHome && <span className="dep-sub">{t.rescue.acrossHome}</span>}
                    {gate && <span className="dep-gate">{gate}</span>}
                  </span>
                  <span className="dep-right"><span className="badge-sched">{t.scheduledOnly}</span></span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="muted small">{b.keep}</p>
      </section>}
    </div>
  );
}
