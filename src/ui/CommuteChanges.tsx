import { routeLabel } from '../domain/routeDisplay';
import { useId, useRef } from 'react';
import type { CommuteChange, ChangedDeparture } from '../domain/commuteChanges';
import type { Favorite } from '../domain/favorites';
import { formatTime12, localYmd, parseYmd, zonedWallTime } from '../domain/time';
import type { Lang, Strings } from './i18n';

export function CommuteChanges({ notices, favorites, durable, dismiss, t, lang, tz }: {
  notices: CommuteChange[]; favorites: Favorite[]; durable: boolean; dismiss: (id: string) => Promise<void>; t: Strings; lang: Lang; tz: string;
}) {
  const heading = useId(), region = useRef<HTMLElement>(null);
  const messages = t.commuteChanges;
  if (!notices.length && durable) return null;
  const dateLabel = (date: string) => {
    const [y, m, d] = parseYmd(date);
    return new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { timeZone: tz, month: 'long', day: 'numeric', year: 'numeric' })
      .format(zonedWallTime(y, m, d, 12, 0, tz));
  };
  const clock = (instant: number, day: string) => `${localYmd(instant, tz) === day ? '' : dateLabel(localYmd(instant, tz)) + ' · '}${formatTime12(instant, tz, lang)}`;
  const rows = (values: ChangedDeparture[], day: string) => values.length ? <ul>{values.map((row, i) => <li key={i}>
    {row.direction === 'out' ? messages.out : messages.back} · {routeLabel(row.route, t.gateTurnpikeExpress)} · {formatTime12(row.departure, tz, lang)}
    {row.estimated && <> ({messages.estimate})</>} · {row.arrival === undefined ? messages.unknownArrival : `${messages.arrival} ${clock(row.arrival, day)}`}
  </li>)}</ul> : <p>{messages.none}</p>;
  return <section ref={region} className="commute-changes" aria-labelledby={heading}>
    <h2 id={heading} tabIndex={-1}>{messages.heading}</h2>
    {!durable && <p className="warn small">{messages.storage}</p>}
    {notices.map(notice => {
      const name = favorites.find(f => f.id === notice.favoriteId)?.label ?? t.savedCommute;
      return <article className="card commute-change" key={notice.id}>
        <h3>{messages.title(name)}</h3>
        <p>{messages[notice.kind]}</p>
        {notice.date && <p>{messages.firstDay(dateLabel(notice.date))}</p>}
        <details>
          <summary>{messages.details}</summary>
          {notice.kind === 'timetable' && <>
            <div className="change-copies"><div><h4>{messages.before}</h4>{rows(notice.before, notice.date!)}</div><div><h4>{messages.after}</h4>{rows(notice.after, notice.date!)}</div></div>
            <p className="small">{messages.scope}</p>
            <p className="small">{messages.stopScope}</p>
          </>}
          <p className="small">{messages.versions(notice.fromVersion, notice.toVersion)}</p>
        </details>
        <button type="button" aria-label={messages.dismissNamed(name)} onClick={async event => {
          const button = event.currentTarget;
          button.disabled = true;
          // Keep keyboard focus nearby after the selected card disappears. Incoming notices never take focus.
          const buttons = [...region.current!.querySelectorAll<HTMLButtonElement>('button')];
          const next = buttons[buttons.indexOf(button) + 1] ?? buttons[buttons.indexOf(button) - 1];
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
