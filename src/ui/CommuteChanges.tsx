import { routeLabel } from '../domain/routeDisplay';
import { useId, useRef, useState } from 'react';
import type { CommuteChange, ChangedDeparture } from '../domain/commuteChanges';
import type { Favorite } from '../domain/favorites';
import { addDays, formatTime12, localYmd } from '../domain/time';
import type { Lang, Strings } from './i18n';
import type { Dataset } from '../domain/types';
import { returnLeg } from '../domain/direction';
import { briefingSelectionKnown, type BriefingSelection } from '../domain/commuteBriefing';
import { briefingDate, CommuteBriefing, SourceClock } from './CommuteBriefing';

export function CommuteChanges({ notices, favorites, durable, dismiss, t, lang, tz, ds, now, reversedIds, onTimetable, onReselect, checkedAt, fromCache, savedAt }: {
  notices: CommuteChange[]; favorites: Favorite[]; durable: boolean; dismiss: (id: string) => Promise<void>; t: Strings; lang: Lang; tz: string;
  ds: Dataset; now: number; reversedIds: Set<string>; onTimetable: (selection: BriefingSelection) => void; onReselect: (favorite: Favorite, reversed: boolean) => void;
  checkedAt?: number; fromCache?: boolean; savedAt?: number;
}) {
  const heading = useId(), region = useRef<HTMLElement>(null);
  const messages = t.commuteChanges;
  const b = messages.briefing, today = localYmd(now, tz);
  const [chosen, setChosen] = useState<string>();
  const date = chosen && chosen >= today && chosen <= addDays(today, 6) ? chosen : today;
  if (!favorites.length && !notices.length && durable) return null;
  const dateLabel = (date: string) => briefingDate(date, lang, tz);
  const clock = (instant: number, day: string) => `${localYmd(instant, tz) === day ? '' : dateLabel(localYmd(instant, tz)) + ' · '}${formatTime12(instant, tz, lang)}`;
  const rows = (values: ChangedDeparture[], day: string) => values.length ? <ul>{values.map((row, i) => <li key={i}>
    {row.direction === 'out' ? messages.out : messages.back} · {routeLabel(row.route)} · {formatTime12(row.departure, tz, lang)}
    {row.estimated && <> ({messages.estimate})</>} · {row.arrival === undefined ? messages.unknownArrival : `${messages.arrival} ${clock(row.arrival, day)}`}
  </li>)}</ul> : <p>{messages.none}</p>;
  return <section ref={region} className="commute-changes" aria-labelledby={heading}>
    <h2 id={heading} tabIndex={-1}>{b.heading}</h2>
    {!durable && <p className="warn small">{messages.storage}</p>}
    {favorites.length > 0 && <>
      <label className="briefing-date">{b.date}<select value={date} onChange={event => setChosen(event.target.value)}>
        {Array.from({ length: 7 }, (_, i) => addDays(today, i)).map(day => <option key={day} value={day}>{dateLabel(day)}</option>)}
      </select></label>
      <aside className="card briefing-alerts" role="note">
        <strong>{b.alerts}</strong><p className="small">{b.alertsWhy} {b.alertAge}</p>
        <a className="link" href="https://www.njtransit.com/travel-alerts-to" target="_blank" rel="noreferrer">{b.checkOfficial}</a>
      </aside>
      {favorites.map(favorite => {
        const reversed = reversedIds.has(favorite.id);
        const leg = reversed ? returnLeg(ds, favorite.fromStopId, favorite.toStopId, favorite.routeIds) : favorite;
        return <article className="card briefing-commute" key={favorite.id}>
          <h3>{favorite.label} · {reversed ? messages.back : messages.out}</h3>
          <CommuteBriefing ds={ds} selection={leg ? { ...leg, routeIds: favorite.routeIds, date } : undefined}
            now={now} t={t} lang={lang} onTimetable={onTimetable} onReselect={() => onReselect(favorite, reversed)}
            checkedAt={checkedAt} fromCache={fromCache} savedAt={savedAt} />
        </article>;
      })}
    </>}
    {notices.map(notice => {
      const favorite = favorites.find(f => f.id === notice.favoriteId);
      const name = favorite?.label ?? t.savedCommute;
      const directions = [...new Set([...notice.before, ...notice.after].map(row => row.direction))];
      if (!directions.length) directions.push(reversedIds.has(notice.favoriteId) ? 'back' : 'out');
      return <article className="card commute-change" key={notice.id}>
        <h3>{messages.title(name)}</h3>
        <p>{messages[notice.kind]}</p>
        {notice.date && <p>{messages.firstDay(dateLabel(notice.date))}</p>}
        <SourceClock source={notice.sources?.after} now={now} t={t} lang={lang} tz={tz} />
        <p className="small">{b.checkUnknown}</p>
        <details>
          <summary>{messages.details}</summary>
          {notice.kind === 'timetable' && <>
            <div className="change-copies"><div><h4>{messages.before}</h4>{rows(notice.before, notice.date!)}</div><div><h4>{messages.after}</h4>{rows(notice.after, notice.date!)}</div></div>
            <p className="small">{messages.scope}</p>
            <p className="small">{messages.stopScope}</p>
          </>}
          <p className="small">{messages.versions(notice.fromVersion, notice.toVersion)}</p>
          <h4>{b.beforeSource}</h4><SourceClock source={notice.sources?.before} now={now} t={t} lang={lang} tz={tz} />
        </details>
        {favorite && directions.map(direction => {
          const leg = direction === 'out' ? favorite : returnLeg(ds, favorite.fromStopId, favorite.toStopId, favorite.routeIds);
          return leg && briefingSelectionKnown(ds, { ...leg, routeIds: favorite.routeIds }) && <button key={direction} type="button" onClick={() => onTimetable({ ...leg, routeIds: favorite.routeIds, date: notice.date && notice.date >= today ? notice.date : date })}>
            {b.timetable} · {direction === 'out' ? messages.out : messages.back}
          </button>;
        })}
        {favorite && (notice.kind === 'selection' || notice.kind === 'uncomparable') && <button type="button" onClick={() => onReselect(favorite, false)}>{b.reselect}</button>}
        <button type="button" aria-label={messages.dismissNamed(name)} onClick={async event => {
          const button = event.currentTarget;
          button.disabled = true;
          // Keep keyboard focus nearby after the selected card disappears. Incoming notices never take focus.
          const buttons = [...region.current!.querySelectorAll<HTMLButtonElement>('button')];
          const index = buttons.indexOf(button), card = button.closest('article');
          const next = buttons.slice(index + 1).find(candidate => !card?.contains(candidate))
            ?? buttons.slice(0, index).reverse().find(candidate => !card?.contains(candidate));
          await dismiss(notice.id);
          // Move focus only once the dismissed card is really gone: on a slow phone React can commit after
          // the next frame, and focusing the soon-removed heading would drop focus to the page body.
          // A control the rider moved to meanwhile keeps focus.
          const movedOn = () => { const now = document.activeElement; return !!now && now !== button && now !== document.body && now.isConnected; };
          const settle = (frames = 0) => requestAnimationFrame(() => {
            if (movedOn()) return;
            if (button.isConnected && frames < 60) { settle(frames + 1); return; }
            if (next?.isConnected) next.focus();
            else (region.current?.querySelector<HTMLElement>('h2')
              ?? document.querySelector<HTMLElement>('[data-favorite-id] button, main button'))?.focus();
          });
          settle();
        }}>{messages.dismiss}</button>
      </article>;
    })}
  </section>;
}
