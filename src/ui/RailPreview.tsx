import { useId, useState } from 'react';
import { sampleRailTimetable } from '../data/railSample';
import { railExamples, type RailDay, type RailDirection, type RailStation } from '../domain/railTimetable';
import type { StationChoice } from '../domain/journeyGuide';
import { formatTime12 } from '../domain/time';
import type { Strings } from './i18n';

export function RailPreview({ station, direction, t }: { station: StationChoice; direction: RailDirection; t: Strings }) {
  const [day, setDay] = useState<RailDay>('weekday');
  const id = useId();
  const r = t.rail;
  const journeys = railExamples(sampleRailTimetable, station, direction, day);
  const name = (s: RailStation) => s === 'secaucus' ? 'Secaucus Junction' : s === 'penn' ? 'New York Penn' : t.journey.stations[s];
  // These clocks intentionally have no connection to today's date or the live bus clock.
  const time = (minute: number) => formatTime12(Date.UTC(2000, 0, 1, 0, minute), 'UTC', 'en');
  return <section className="card rail-preview" aria-labelledby={`${id}-title`}>
    <div className="rail-heading"><h2 id={`${id}-title`}>{r.title}</h2><span className="badge-sched">{r.sample}</span></div>
    <p className="small">{r.availability}</p>
    <label htmlFor={`${id}-day`}>{r.day}</label><select id={`${id}-day`} value={day} onChange={e => setDay(e.target.value as RailDay)}>
      <option value="weekday">{r.weekday}</option><option value="weekend">{r.weekend}</option>
    </select>
    <ul className="rail-options" role="list">
      {journeys.map(journey => {
        const [first, second] = journey.legs;
        const train = first.train ?? second.train;
        return <li key={journey.id}>
          <details className="rail-option">
            <summary>
              <span className="rail-clocks"><span><small>{name(first.from.station)}</small><strong>{time(first.from.minute)}</strong></span><span aria-hidden="true">→</span><span><small>{name(second.to.station)}</small><strong>{time(second.to.minute)}</strong></span></span>
              <span className="small">{r.summary(journey.durationMin, train!)} · {r.steps}</span>
            </summary>
            <ol className="rail-steps">
              <li><strong>{r.board(name(first.from.station), time(first.from.minute))}</strong><p>{direction === 'outbound' ? r.outBoard(train!) : r.returnBoard}</p></li>
              <li><strong>{r.transfer}</strong><p>{r.connection(time(first.to.minute), time(second.from.minute), journey.transferGapMin)}</p><p>{direction === 'outbound' ? r.outTransfer : r.returnTransfer(train!, name(second.to.station))}</p>{first.to.mayLeaveEarly && <p className="small">{r.early}</p>}</li>
              <li><strong>{r.finish(name(second.to.station), time(second.to.minute))}</strong><p>{second.to.event === 'call' ? r.callTime : r.arrivalTime}</p></li>
            </ol>
          </details>
        </li>;
      })}
    </ul>
    <details className="small rail-source"><summary>{r.source}</summary><p>{r.sourceText}</p><p>{r.transferNote}</p></details>
  </section>;
}
