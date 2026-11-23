import { routeLabel, routeNumber } from '../domain/routeDisplay';
import { useMemo } from 'react';
import { icsEvent, untilParts } from '../domain/calendar';
import { lastReturn } from '../domain/lastReturn';
import { formatTime12, localYmd } from '../domain/time';
import type { Dataset, Departure } from '../domain/types';
import type { Lang, Strings } from './i18n';

interface ReturnLeg { fromStopId: string; toStopId: string; routeIds: string[] }
interface Props {
  ds: Dataset;
  outbound: Departure;
  toStopId: string;
  t: Strings;
  lang: Lang;
  now: number;
  onOpen: (dep: Departure, leg: ReturnLeg) => void;
}

/** Always show the service-day boundary and the following departure; never infer an end of service. */
export function LastReturnCard({ ds, outbound, toStopId, t, lang, now, onOpen }: Props) {
  const result = useMemo(() => lastReturn(ds, outbound, toStopId), [ds, outbound, toStopId]);
  if (result.status === 'not_applicable') return null;
  const l = t.lastReturn;
  const fmtDate = (date: string) => lang === 'es'
    ? `${+date.slice(6, 8)}/${+date.slice(4, 6)}/${date.slice(0, 4)}`
    : `${+date.slice(4, 6)}/${+date.slice(6, 8)}/${date.slice(0, 4)}`;
  const time = (dep: Departure) => `${dep.estimated ? '~' : ''}${formatTime12(dep.departs, ds.meta.timezone, lang)} · ${fmtDate(localYmd(dep.departs, ds.meta.timezone))}`;
  const stop = ds.stops.find((s) => s.id === result.returnLeg?.toStopId);
  const usable = (dep: Departure) => !!result.window && dep.departs >= result.window.from;
  const open = (dep: Departure) => { if (result.returnLeg) onOpen(dep, { ...result.returnLeg, routeIds: [result.routeId] }); };
  return (
    <section className="card last-return" aria-labelledby="last-return-heading">
      <h2 id="last-return-heading">{l.title}</h2>
      <p className="small">{l.operatingDay(routeLabel(outbound.route.shortName, t.gateTurnpikeExpress), fmtDate(result.serviceDate))}</p>
      {stop && <p className="small">{l.destination(stop.name)}</p>}
      {result.status === 'unconfirmed' && <p className="warn small">{l.unconfirmed}</p>}
      {result.status === 'no_return_listed' && <p className="warn small">{l.noReturn}</p>}
      {result.status === 'continues_overnight' && <p className="small">{l.ongoing}</p>}
      {result.limitations.includes('holiday_schedule_missing') && <p className="warn small">{l.holiday}</p>}
      {result.limitations.includes('no_reverse_stop') && <p className="small">{l.noReverse}</p>}
      {result.lastForServiceDay && <>
        <p className="small">{l.finalListed}</p>
        <p className="return-time"><strong>{time(result.lastForServiceDay)}</strong></p>
        {/* Only a catchable, confirmed last trip gets a countdown and reminder: not one that leaves before the
            rider reaches Port Authority, nor one on a day whose schedule Dale does not know. */}
        {(result.status === 'available' || result.status === 'continues_overnight') && usable(result.lastForServiceDay)
          && <LastBusReminder ds={ds} t={t} lang={lang} now={now} dep={result.lastForServiceDay} overnight={result.status === 'continues_overnight'}
            from={ds.stops.find((s) => s.id === result.returnLeg?.fromStopId)?.name ?? ''} />}
        {usable(result.lastForServiceDay) && <button className="wide" onClick={() => open(result.lastForServiceDay!)}>{l.open}</button>}
      </>}
      {result.previous && <div className="return-option">
        <p className="small">{l.previous}: <strong>{time(result.previous)}</strong></p>
        <button className="ghost wide" onClick={() => open(result.previous!)}>{l.earlier}</button>
      </div>}
      {result.nextAfterLast ? <p className="small">{l.next}: <strong>{time(result.nextAfterLast)}</strong></p>
        : result.lastForServiceDay && <p className="muted small">{l.unknownNext}</p>}
      {!result.lastForServiceDay && !result.limitations.includes('no_reverse_stop') && result.status === 'unconfirmed' && <p className="small">{l.missing}</p>}
      <p className="muted small">{l.schedule}</p>
      {ds.meta.transcribed && <p className="muted small">{l.printed}</p>}
    </section>
  );
}

/** Countdown to the last listed return, and a calendar reminder 30 minutes before it (issue #58). */
function LastBusReminder({ ds, t, lang, now, dep, from, overnight }: { ds: Dataset; t: Strings; lang: Lang; now: number; dep: Departure; from: string; overnight: boolean }) {
  const l = t.lastReturn;
  const left = untilParts(now, dep.departs);
  const clock = `${dep.estimated ? '~' : ''}${formatTime12(dep.departs, ds.meta.timezone, lang)}`;
  function download() {
    const ics = icsEvent({
      uid: `${dep.tripInstanceId}@dale`, start: dep.departs, minutes: 15, alarmMinutes: 30, now,
      summary: l.calendarSummary(routeLabel(dep.route.shortName, t.gateTurnpikeExpress), clock, from),
      description: overnight ? `${l.calendarNote} ${l.ongoing}` : l.calendarNote,
    });
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `dale-last-${routeNumber(dep.route.shortName)}-${localYmd(dep.departs, ds.meta.timezone)}.ics`;
    a.click();
    // Some mobile browsers read the file late; keep the link alive for a minute.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return (
    <div className="last-bus-reminder">
      <p className="small">{left ? l.leavesIn(left.h, left.m) : l.alreadyLeft}</p>
      {left && <button className="ghost" onClick={download}>{l.calendar}</button>}
      {left && <p className="muted small">{l.calendarNote}</p>}
    </div>
  );
}

