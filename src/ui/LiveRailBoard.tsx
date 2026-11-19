import { useEffect, useId, useRef, useState } from 'react';
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
  // Screen readers hear a newly posted track or a changed status politely; the first answer is not announced.
  const seen = useRef<Map<string, string> | undefined>(undefined);
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    // Remember every departure on the board, so a train that scrolls into view between answers still has a baseline.
    const prev = seen.current, next = new Map<string, string>(), changes: string[] = [];
    const visible = new Set(rows.map((d) => `${d.trainId}-${d.scheduledAt}`));
    for (const d of board.departures) {
      const k = `${d.trainId}-${d.scheduledAt}`, cur = `${d.track ?? ''}|${d.status ?? ''}`;
      next.set(k, cur);
      const was = prev?.get(k);
      if (!visible.has(k) || was === undefined || was === cur) continue;
      const [track, status] = was.split('|');
      const parts = [d.track && d.track !== track ? l.trackNo(d.track) : '', d.status && d.status !== status ? d.status : ''].filter(Boolean);
      if (parts.length) changes.push(`${l.trainNo(d.trainId)}: ${parts.join(', ')}`);
    }
    seen.current = next;
    // Cleared on a quiet answer, so the same change posted again is announced again.
    setAnnounce(changes.join('. '));
  }, [board.receivedAt]); // only a new answer announces
  return <section className="rail-live" aria-labelledby={`${id}-title`}>
    <h3 className="rail-board-title" id={`${id}-title`}>{l.board(l.stations[board.station])}</h3>
    <p className="sr-only" role="status">{announce}</p>
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
