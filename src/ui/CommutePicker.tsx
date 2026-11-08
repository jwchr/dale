import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cityBoardingStops, cityDestinationStops, cityStopGroups, stopCity } from '../domain/cityStops';
import { checkDirection } from '../domain/direction';
import type { Dataset, Stop } from '../domain/types';
import type { Lang, Strings } from './i18n';
import { StopChoice } from './StopChoice';

export type CommutePickEnd = 'from' | 'to';
const folded = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
/** A local draft: cities first, then source-qualified stops; only Save commits the new pair. */
export function CommutePicker({ ds, t, lang, initialFrom, initialTo, routeIds, end, level, onSave, onCancel }: {
  ds: Dataset; t: Strings; lang: Lang; initialFrom: string; initialTo: string; routeIds: string[];
  end: CommutePickEnd; level: 'city' | 'stop'; onSave: (from: string, to: string) => boolean; onCancel: () => void;
}) {
  const [from, setFrom] = useState(initialFrom), [to, setTo] = useState(initialTo);
  const [stage, setStage] = useState<CommutePickEnd | 'review'>(end);
  const [city, setCity] = useState<string | undefined>(() => level === 'stop' ? stopCity(ds, ds.stops.find(stop => stop.id === (end === 'from' ? initialFrom : initialTo))!) : undefined);
  const [query, setQuery] = useState(''), [error, setError] = useState(false);
  const submitted = useRef(false), heading = useRef<HTMLHeadingElement>(null), id = useId();
  const s = t.cityPicker;
  const candidates = useMemo(() => stage === 'from' ? cityBoardingStops(ds, routeIds) : cityDestinationStops(ds, from, routeIds), [ds, stage, from, routeIds]);
  const groups = useMemo(() => cityStopGroups(ds, candidates, lang), [ds, candidates, lang]);
  const check = checkDirection(ds, from, to, routeIds);
  const cityLabel = (name: string) => name === 'New York' ? t.commuteNewYork : name || t.selection.unknownCity;
  const reset = (next: CommutePickEnd) => { setStage(next); setCity(undefined); setQuery(''); setError(false); };
  const pick = (stop: Stop) => {
    setError(false); setQuery('');
    if (stage === 'from') {
      setFrom(stop.id);
      if (checkDirection(ds, stop.id, to, routeIds).ok) setStage('review');
      else { setStage('to'); setCity(undefined); }
    } else { setTo(stop.id); setStage('review'); }
  };
  useEffect(() => { heading.current?.focus(); }, [stage, city, from, to]);
  const reviewStop = (stopId: string) => {
    const stop = ds.stops.find(stop => stop.id === stopId);
    return stop ? <><strong>{cityLabel(stopCity(ds, stop))}</strong><span>{stop.name}</span><small>{stop.code ? t.selection.stopNumber(stop.code) : t.selection.numberUnknown}</small></> : t.unknownStop;
  };
  if (stage === 'review') return <form className="card commute-picker" onSubmit={event => {
    event.preventDefault();
    if (!check.ok || submitted.current) { setError(true); heading.current?.focus(); return; }
    submitted.current = true;
    if (!onSave(from, to)) { submitted.current = false; setError(true); }
  }}>
    <h1 ref={heading} tabIndex={-1}>{s.review}</h1>
    <dl className="picker-review"><div><dt>{t.commuteFrom}</dt><dd>{reviewStop(from)}<button type="button" className="link" onClick={() => reset('from')}>{s.changeFrom}</button></dd></div>
      <div><dt>{t.commuteToLabel}</dt><dd>{reviewStop(to)}<button type="button" className="link" onClick={() => reset('to')}>{s.changeTo}</button></dd></div></dl>
    {!check.ok && check.reason === 'wrong-side' && <div className="warn" role="alert"><p>{t.wrongSideNoDistance(`${check.useStop.name}${check.useStop.code ? ' · ' + t.selection.stopNumber(check.useStop.code) : ''}`)}</p>
      <button type="button" onClick={() => { setFrom(check.useStop.id); setError(false); }}>{t.useThatStop}</button></div>}
    {(!check.ok && check.reason === 'not-served' || error) && <p className="warn" role="alert">{t.notServed}</p>}
    <div className="choice-list"><button type="submit" className="primary save-trip">{t.selection.save}</button><button type="button" className="chip" onClick={onCancel}>{s.cancel}</button></div>
  </form>;
  const visible = city === undefined ? groups.filter(group => folded(cityLabel(group.city)).includes(folded(query.trim())))
    : groups.filter(group => group.city === city);
  const stops = visible.flatMap(group => group.stops).filter(stop => folded(query.trim()).split(/\s+/).every(word => folded(`${stop.name} ${stop.code ?? ''}`).includes(word)));
  return <section className="card commute-picker">
    <h1 ref={heading} tabIndex={-1}>{stage === 'from' ? t.commuteFrom : t.commuteToLabel}: {city === undefined ? s.city : s.stop}</h1>
    {city !== undefined && <div className="picker-city"><strong>{cityLabel(city)}</strong><button type="button" className="link" onClick={() => { setCity(undefined); setQuery(''); }}>{s.changeCity}</button></div>}
    <label htmlFor={id}>{city === undefined ? s.searchCity : s.searchStop}</label>
    <input id={id} name="city-stop-search" className="search" type="search" value={query} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="search" onChange={event => setQuery(event.currentTarget.value)} />
    <ul className="results city-stop-results">{city === undefined ? visible.map(group => <li key={group.city}><button type="button" className="city-choice" onClick={() => { setCity(group.city); setQuery(''); }}><strong>{cityLabel(group.city)}</strong><span className="muted small">{group.stops.length}</span></button></li>)
      : stops.map(stop => <li key={stop.id}><StopChoice ds={ds} stop={stop} t={t} onPick={pick} /></li>)}</ul>
    {(city === undefined ? !visible.length : !stops.length) && <p role="status">{s.empty}</p>}
    <button type="button" className="chip" onClick={onCancel}>{s.cancel}</button>
  </section>;
}
