import { commuteBriefing, sourceAge, type BriefingSelection } from '../domain/commuteBriefing';
import type { Dataset } from '../domain/types';
import type { ScheduleSource } from '../domain/commuteChanges';
import { formatTime12, localYmd, parseYmd, zonedWallTime } from '../domain/time';
import type { Lang, Strings } from './i18n';

export function briefingDate(date: string, lang: Lang, tz: string) {
  const [y, m, d] = parseYmd(date);
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { timeZone: tz, month: 'long', day: 'numeric', year: 'numeric' })
    .format(zonedWallTime(y, m, d, 12, 0, tz));
}
export function SourceClock({ source, now, t, lang, tz }: { source?: ScheduleSource; now: number; t: Strings; lang: Lang; tz: string }) {
  const b = t.commuteChanges.briefing;
  const age = sourceAge(source?.builtAt, now);
  return <div className="small briefing-source">
    <p>{b.source}: {source?.source ?? 'NJ Transit'}{source && <> · {b.version}: {source.version}</>}</p>
    <p>{b.publicationUnknown}</p>
    <p>{age === undefined ? b.ageUnknown : <>{b.built}: {new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', {
      timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(source!.builtAt))} · {b.buildAge}: {b.age(Math.floor(age / 60_000))}</>}</p>
  </div>;
}

export function CommuteBriefing({ ds, selection, now, t, lang, onTimetable, onReselect, checkedAt, fromCache, savedAt }: {
  ds: Dataset; selection?: BriefingSelection; now: number; t: Strings; lang: Lang;
  onTimetable: (selection: BriefingSelection) => void; onReselect: () => void;
  checkedAt?: number; fromCache?: boolean; savedAt?: number;
}) {
  const b = t.commuteChanges.briefing, tz = ds.meta.timezone;
  const model = selection && commuteBriefing(ds, selection);
  const at = (time: number) => `${briefingDate(localYmd(time, tz), lang, tz)} · ${formatTime12(time, tz, lang)}`;
  return <>
    {selection && model ? <>
      <p className="briefing-scope">{(model.routeNames.length ? model.routeNames.join(' / ') : selection.routeIds.map(id => ds.routes.find(r => r.id === id)?.shortName ?? b.allRoutes).join(' / ')) || b.allRoutes}
        {' · '}{ds.stops.find(s => s.id === selection.fromStopId)?.name ?? t.commuteChanges.briefing.missing}
        {' → '}{ds.stops.find(s => s.id === selection.toStopId)?.name ?? t.commuteChanges.briefing.missing}</p>
      <p>{briefingDate(selection.date, lang, tz)} · {b.allDay}</p>
      <p>{model.state === 'scheduled' ? b.scheduled(model.departures.length) : b[model.state]}</p>
      <details><summary>{b.source}</summary>
        <SourceClock source={{ source: ds.meta.source, version: ds.meta.feedVersion, builtAt: ds.meta.builtAt }} now={now} t={t} lang={lang} tz={tz} />
        <p className="small">{sourceAge(checkedAt, now) === undefined ? b.checkUnknown : `${b.checked}: ${at(checkedAt!)} · ${b.age(Math.floor((now - checkedAt!) / 60_000))}`}</p>
        {ds.meta.transcribed && <p className="small">{b.issued}: {briefingDate(ds.meta.transcribed.issued, lang, tz)}</p>}
        {[...new Set(model.validity.map(v => `${v.start}:${v.end}`))].map(v => <p className="small" key={v}>{b.valid}: {v.split(':').map(d => briefingDate(d, lang, tz)).join(' → ')}</p>)}
        {fromCache && <><p className="small">{b.offline}</p><p className="small">{sourceAge(savedAt, now) === undefined ? b.savedUnknown : `${b.saved}: ${at(savedAt!)} · ${b.age(Math.floor((now - savedAt!) / 60_000))}`}</p></>}
        <p className="small">{b.translation}</p>
      </details>
      <button type="button" onClick={() => onTimetable(selection)}>{b.timetable}</button>
      {model.state === 'unknown' && <button type="button" onClick={onReselect}>{b.reselect}</button>}
      {ds.stops.some(s => s.id === selection.fromStopId && s.terminal === 'PABT') && <p className="small">{b.gate} {b.gateSource}
        {ds.publishedGates && <> {b.printedRules} {ds.publishedGates.source} · {b.effective}: {briefingDate(ds.publishedGates.effective, lang, tz)}</>}</p>}
    </> : <><p>{b.missing}</p><button type="button" onClick={onReselect}>{b.reselect}</button></>}
  </>;
}
