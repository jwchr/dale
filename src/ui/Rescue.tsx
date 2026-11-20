// "Get me the fuck home" (issue #32): every scheduled way home in Dale's data, ranked by arrival,
// with what was searched and what was not. Schedule only: it never claims a bus is running or that
// no other way exists. Routes from the wider official schedule load only when this screen opens.
import { useMemo, type ReactNode } from 'react';
import { rescueOptions, type RescueOption, type RescueTransfer, type RescueWider } from '../domain/rescue';
import { formatTime12, localHour, localYmd } from '../domain/time';
import type { Dataset } from '../domain/types';
import { BackupPlans } from './BackupPlans';
import type { Lang, Strings } from './i18n';
import { rescueStrings } from './rescueStrings';
import { useRescueSchedule } from './useRescueSchedule';

interface Props {
  ds: Dataset;
  t: Strings;
  lang: Lang;
  now: number;
  fromStopId: string;
  homeStopId: string;
  usualRouteId?: string;
  /** 'home' when heading out of New York; 'other' for trips into Port Authority. */
  label: 'home' | 'other';
  /** The gate line for a departure boarding at Port Authority, with its source; undefined elsewhere. */
  gateText: (o: RescueOption) => string | undefined;
  onOpen: (o: RescueOption) => void;
  badge: (routeId: string) => ReactNode;
}

export function Rescue({ ds, t, lang, now, fromStopId, homeStopId, usualRouteId, label, gateText, onOpen, badge }: Props) {
  const r = t.rescue, w = rescueStrings[lang];
  const loaded = useRescueSchedule(ds);
  // Searched once a minute, not on every screen update: the one-change search walks many stops (#225).
  // The load state is a new object on most renders, so the search is keyed on what it holds.
  const minute = Math.floor(now / 60_000);
  const widerKey = loaded.state === 'ready' ? loaded.schedule : loaded.state === 'missing' ? loaded.reason : 'loading';
  const result = useMemo(() => {
    const wider: RescueWider = loaded.state === 'ready' ? { state: 'ready', schedule: loaded.schedule } : loaded;
    return rescueOptions(ds, fromStopId, homeStopId, minute * 60_000, usualRouteId, undefined, undefined, wider);
  }, [ds, fromStopId, homeStopId, minute, usualRouteId, widerKey]);
  const stops = new Map([...ds.stops, ...(loaded.state === 'ready' ? loaded.schedule.stops : [])].map((s) => [s.id, s] as const));
  const name = (id: string) => stops.get(id)?.name ?? id;
  const clock = (at: number) => formatTime12(at, ds.meta.timezone, lang);
  const soon = result.options.filter((o) => !o.lastOnLine || o.dep.departs <= result.searchedUntil);
  const today = localYmd(now, ds.meta.timezone);
  // A row on another calendar day says which day, so 1:10 AM tomorrow never reads as 1:10 AM today.
  const day = (at: number) => localYmd(at, ds.meta.timezone) === today ? ''
    : `${new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'short', timeZone: ds.meta.timezone }).format(new Date(at))} `;
  const missing = loaded.state === 'missing' ? w.missing[loaded.reason] : undefined;

  // Wider routes are not in the app's own schedule, so their rows are not opened as a trip screen.
  const row = (o: RescueOption, extra?: ReactNode) => {
    const gate = o.wider ? undefined : gateText(o);
    const body = (
      <>
        {o.wider ? <span className="route-badge">{o.dep.route.shortName}</span> : badge(o.dep.route.id)}
        <span className="dep-main">
          <span className="dep-time">{day(o.dep.departs)}{o.dep.estimated ? '~' : ''}{clock(o.dep.departs)}</span>
          <span className="dep-sub">{r.arrives(`${o.arrivesEstimated ? '~' : ''}${clock(o.arrives)}`, name(o.alightStopId))}</span>
          {extra}
          {o.acrossFromBoard && <span className="dep-sub">{r.acrossBoard(name(o.boardStopId))}</span>}
          {o.acrossFromHome && <span className="dep-sub">{r.acrossHome}</span>}
          {gate && <span className="dep-gate">{gate}</span>}
        </span>
        <span className="dep-right">
          {o.lastOnLine && <span className="tag">{o.lastUnconfirmed ? r.lastUnconfirmed
            : localHour(o.dep.departs, ds.meta.timezone) >= 4 && localHour(o.dep.departs, ds.meta.timezone) < 18 ? r.lastToday : r.lastOnLine}</span>}
          {o.sameLine && !o.lastOnLine && <span className="muted small">{r.sameLine}</span>}
          <span className="badge-sched">{o.wider ? w.widerTag : t.scheduledOnly}</span>
        </span>
      </>
    );
    return (
      <li key={o.dep.tripInstanceId}>
        {o.wider ? <div className="dep">{body}</div> : <button className="dep" onClick={() => onOpen(o)}>{body}</button>}
      </li>
    );
  };

  // A one-change trip opens its first bus; a first bus on a wider route has no trip screen.
  const transferRow = (x: RescueTransfer) => {
    const { first, second } = x;
    const body = (
      <>
        {first.wider ? <span className="route-badge">{first.dep.route.shortName}</span> : badge(first.dep.route.id)}
        <span className="dep-main">
          <span className="dep-time">{day(first.dep.departs)}{first.dep.estimated ? '~' : ''}{clock(first.dep.departs)}</span>
          <span className="dep-sub">{w.transferRide(name(x.changeStopId), `${first.arrivesEstimated ? '~' : ''}${clock(first.arrives)}`)}</span>
          <span className="dep-sub">{w.transferChange(second.dep.route.shortName, `${second.dep.estimated ? '~' : ''}${clock(second.dep.departs)}`, Math.round(x.waitMs / 60_000))}</span>
          <span className="dep-sub">{r.arrives(`${second.arrivesEstimated ? '~' : ''}${clock(second.arrives)}`, name(second.alightStopId))}</span>
          {first.acrossFromBoard && <span className="dep-sub">{r.acrossBoard(name(first.boardStopId))}</span>}
          {second.acrossFromHome && <span className="dep-sub">{r.acrossHome}</span>}
        </span>
        <span className="dep-right"><span className="badge-sched">{first.wider || second.wider ? w.widerTag : t.scheduledOnly}</span></span>
      </>
    );
    return (
      <li key={`${first.dep.tripInstanceId}>${second.dep.tripInstanceId}`}>
        {first.wider ? <div className="dep">{body}</div> : <button className="dep" onClick={() => onOpen(first)}>{body}</button>}
      </li>
    );
  };

  return (
    <section className="rescue">
      <h1>{label === 'home' ? r.title : r.otherWays}</h1>
      <p className="leg">{r.leg(name(fromStopId), name(homeStopId))}</p>
      <p className="small">{r.scheduleOnly(clock(result.searchedUntil), result.options.some((o) => o.lastOnLine))}</p>
      {loaded.state === 'loading' && <p className="muted small" role="status">{w.loading}</p>}
      {!soon.length && !result.nearHome.length && !result.transfers.length && <p className="warn" role="note">{r.none}{missing ? ` ${missing}` : ''}</p>}
      <ol className="rescue-list">{result.options.map((o) => row(o))}</ol>
      {result.nearHome.length > 0 && (
        <>
          <h2 className="small">{w.nearTitle}</h2>
          <ol className="rescue-list">{result.nearHome.map((o) => row(o, <span className="dep-sub">{w.near(name(o.alightStopId), Math.round(o.straightLineM / 10) * 10)}</span>))}</ol>
        </>
      )}
      {result.transfers.length > 0 && (
        <>
          <h2 className="small">{w.transfersTitle}</h2>
          <ol className="rescue-list">{result.transfers.map(transferRow)}</ol>
        </>
      )}
      <BackupPlans t={t} />
      <p className="muted small" role="note">{r.coverage(result.routesSearched.join(', '))}</p>
      {result.widerRoutes.length > 0 && <p className="muted small">{w.widerIncluded(result.widerRoutes.join(', '))}</p>}
      {loaded.state === 'ready' && loaded.savedAt !== undefined && <p className="muted small">{w.savedCopy(clock(loaded.savedAt))}</p>}
      {missing && (soon.length > 0 || result.nearHome.length > 0 || result.transfers.length > 0) && <p className="muted small">{missing}</p>}
      <p className="muted small">{result.limitations.includes('no_walking_or_transfers') ? r.noWalking : w.walkNote}</p>
      {result.limitations.includes('printed_timepoints_only') && <p className="muted small">{r.printed}</p>}
    </section>
  );
}
