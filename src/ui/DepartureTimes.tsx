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
  return <span className="dep-paired">
    <span className="dep-clock boarding-clock">
      <span className="dep-place">{r.atYourStop}</span>
      <span className="dep-time">{time(liveBoard?.at ?? boarding, liveBoard ? false : boardingEstimated)}</span>
      <span className={liveBoard ? 'badge-live' : 'badge-sched'}>{liveBoard ? liveBoard.kind === 'arrival' ? r.boardingArrival : r.live : t.scheduledOnly}</span>
      {liveBoard && <span className="dep-original">{r.scheduleShort} {time(boarding, boardingEstimated)}</span>}
    </span>
    <span className="dep-clock destination-clock">
      <span className="dep-place">{destination}</span>
      {liveArrival ? <span className="dep-arrival-time">{time(liveArrival.at, false)}</span>
        : arrival ? <span className="dep-arrival-scheduled">{time(arrival.at, arrival.estimated)}</span> : <span className="dep-arrival-scheduled">{t.arrival.scheduleUnknown}</span>}
      <span className={liveArrival ? 'badge-destination-live' : 'badge-sched'}>{liveArrival ? r.live : t.scheduledOnly}</span>
      {liveArrival && arrival && <span className="dep-destination-original">{r.scheduleShort} {time(arrival.at, arrival.estimated)}</span>}
    </span>
  </span>;
}
