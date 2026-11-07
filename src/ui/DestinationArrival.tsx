import { reportedDestinationArrival, type DestinationArrival as Arrival } from '../domain/destinationArrival';
import type { Dataset } from '../domain/types';
import type { BusSession, BusSessionEvent } from '../domain/busLock';
import { tripArrivalAt } from '../domain/schedule';
import { formatTime12 } from '../domain/time';
import type { Strings, Lang } from './i18n';
export function ArrivalResult({ value, t, lang, tz }: { value: Arrival; t: Strings; lang: Lang; tz: string }) {
  const a = t.arrival, clock = (at: number) => formatTime12(at, tz, lang);
  return <>
    <p><strong>{value.route} · {value.destination}</strong></p>
    <p className="small">{new Intl.DateTimeFormat(lang, { timeZone: tz, dateStyle: 'medium' }).format(value.at)}</p>
    <dl className="arrival-times"><div><dt>{a.scheduled}</dt><dd>{value.scheduledAt === undefined ? a.scheduleUnknown : clock(value.scheduledAt)}</dd></div>
      <div><dt>{value.source === 'rider' ? a.rider : a.official}</dt><dd>{clock(value.at)}</dd></div></dl>
    {value.scheduledAt !== undefined && <p className="arrival-difference">{a.difference(Math.trunc((value.at - value.scheduledAt) / 60000))}</p>}
    <p className="small">{value.source === 'rider' ? a.riderNote : a.officialNote}</p>
    <p className="small muted">{a.local}</p>
  </>;
}
export function DestinationArrival({ ds, session, index, now, t, lang, onEvent }: { ds: Dataset; session: BusSession; index: number; now: number; t: Strings; lang: Lang; onEvent: (event: BusSessionEvent) => void }) {
  const dep = session.departure, stop = ds.stops.find(x => x.id === dep.pattern.stopIds[index]), trip = ds.trips.find(x => x.id === dep.tripId);
  if (!stop || !trip || index <= dep.stopIndex) return null;
  const value = session.destinationArrival, scheduled = tripArrivalAt(ds, trip, dep.serviceDate, index), a = t.arrival;
  const report = reportedDestinationArrival(ds, session, index, now);
  return <section className="destination-arrival" aria-label={a.title}>
    <h4>{a.title}</h4>
    {value ? <ArrivalResult value={value} t={t} lang={lang} tz={ds.meta.timezone} /> : <>
      <p>{stop.name}</p><p>{a.scheduled}: {scheduled === undefined ? a.scheduleUnknown : formatTime12(scheduled, ds.meta.timezone, lang)}</p>
      <p><strong>{a.unknown}</strong></p><p className="small">{a.noEvidence}</p>
      {report && <button type="button" onClick={() => onEvent({ type: 'destination_arrival', arrival: report, now })}>{a.confirm(stop.name)}</button>}
    </>}
  </section>;
}
