import { useId } from 'react';
import { FlapText } from './FlapText';
import { minutesLate, type LiveRailBoard as Board } from '../domain/railLive';
import { formatTime12 } from '../domain/time';
import type { Strings } from './i18n';

const ROWS = 6;

/** One station's live departures, exactly as NJ Transit sent them, with the answer's age. */
export function LiveRailBoard({ board, t, lang, now }: { board: Board & { state: 'ok' }; t: Strings; lang: 'en' | 'es'; now: number }) {
  const id = useId(), l = t.rail.live;
  const ageMin = Math.max(0, Math.floor((now - board.receivedAt) / 60_000));
  const rows = board.departures.slice(0, ROWS);
  return <section className="rail-live" aria-labelledby={`${id}-title`}>
    <h3 className="rail-board-title" id={`${id}-title`}>{l.board(l.stations[board.station])}</h3>
    <p className={board.stale ? 'rail-live-age stale' : 'rail-live-age'} role={board.stale ? 'alert' : undefined}>
      {board.stale ? l.stale(ageMin) : l.age(ageMin)}
    </p>
    {rows.length ? <ul className="rail-live-rows" role="list">
      {rows.map((d) => {
        const late = minutesLate(d);
        return <li key={`${d.trainId}-${d.scheduledAt}`} className="rail-live-row">
          <strong className="rail-live-time"><FlapText text={formatTime12(d.scheduledAt, 'America/New_York', lang)} /></strong>
          <span className="rail-live-dest"><FlapText text={d.destination ?? '—'} /></span>
          <span className="rail-live-meta">
            <span>{l.trainNo(d.trainId)}{d.lineCode ? ` · ${d.lineCode}` : ''}</span>
            <span className={d.track ? 'rail-live-track' : undefined}>{d.track ? l.trackNo(d.track) : l.noTrack}</span>
            {d.status && <span className="rail-live-status">{d.status}</span>}
            {late !== null && <span className="rail-live-late">{l.late(late)}</span>}
          </span>
        </li>;
      })}
    </ul> : <p className="rail-live-empty">{l.empty}</p>}
  </section>;
}
