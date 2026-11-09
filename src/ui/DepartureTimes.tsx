import { SignText } from './SignText';
import { LiveIndicator } from './LiveIndicator';
import type { ReactNode } from 'react';
import type { DepartureEvidence } from '../domain/liveDepartures';
import type { Strings } from './i18n';
/** The two clocks name their locations and qualify their sources independently. */
export function DepartureTimes({ evidence, boarding, boardingEstimated, arrival, destination, t, time }: {
  evidence: DepartureEvidence; boarding: number; boardingEstimated: boolean;
  arrival?: { at: number; estimated: boolean }; destination: string; t: Strings;
  time: (at: number, estimated: boolean) => ReactNode;
}) {
  const r = t.live.rows, liveBoard = evidence.boarding, liveArrival = evidence.arrival;
  const signal = (live: boolean) => live ? <LiveIndicator live /> : <svg className="live-symbol scheduled-warning" data-live="false" viewBox="0 0 24 24" role="img" aria-label={r.estimateUnavailable} focusable="false" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <path d="M12 4v10" /><circle cx="12" cy="19" r="1" fill="currentColor" />
  </svg>;
  return <span className="dep-paired">
    <span className="dep-clock boarding-clock">
      <span className="dep-place">{r.atYourStop}</span>
      <span className="dep-clock-line">{signal(!!liveBoard)}<span className="dep-time">{time(liveBoard?.at ?? boarding, liveBoard ? false : boardingEstimated)}</span></span>
      <strong className={liveBoard ? 'badge-live' : 'badge-sched'}><SignText text={liveBoard ? liveBoard.kind === 'arrival' ? r.boardingArrival : r.live : t.scheduledOnly} /></strong>
      {liveBoard && <span className="dep-original">{r.scheduleShort} {time(boarding, boardingEstimated)}</span>}
    </span>
    <span className="dep-clock destination-clock">
      <span className="dep-place">{destination}</span>
      <span className="dep-clock-line">{signal(!!liveArrival)}{liveArrival ? <span className="dep-arrival-time">{time(liveArrival.at, false)}</span>
        : arrival ? <span className="dep-arrival-scheduled">{time(arrival.at, arrival.estimated)}</span> : <span className="dep-arrival-scheduled"><SignText text={t.arrival.scheduleUnknown} /></span>}</span>
      <strong className={liveArrival ? 'badge-destination-live' : 'badge-sched'}><SignText text={liveArrival ? r.live : t.scheduledOnly} /></strong>
      {liveArrival && arrival && <span className="dep-destination-original">{r.scheduleShort} {time(arrival.at, arrival.estimated)}</span>}
    </span>
  </span>;
}
