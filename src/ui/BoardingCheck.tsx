// Boarding check (issue #55): one compact screen for the curb or the gate, plus a large bilingual card
// to show the driver. It checks the scheduled trip the rider picked, never the physical bus: a route
// number alone does not identify a bus, so the card asks the driver to confirm.
import { useEffect, useRef, useState } from 'react';
import { placeIndex } from '../domain/place';
import { tripStopTimes } from '../domain/schedule';
import { formatTime12 } from '../domain/time';
import type { Dataset, Departure } from '../domain/types';
import type { Lang, Strings } from './i18n';
import { strings } from './i18n';

interface Props {
  ds: Dataset;
  dep: Departure;
  toStopId: string;
  t: Strings;
  lang: Lang;
  /** The gate line with its source, when boarding at Port Authority. */
  gate?: string;
}

/** The place without the dataset's "(to …)" direction hint, which is noise to a driver. */
const place = (name: string) => name.replace(/\s+\(to [^)]+\)$/i, '');

export function BoardingCheck({ ds, dep, toStopId, t, lang, gate }: Props) {
  const c = t.boarding;
  const [card, setCard] = useState(false);
  // Focus follows the switch: onto the card's question when it opens, back to its button when it closes.
  const cardHeading = useRef<HTMLHeadingElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const switched = useRef(false);
  useEffect(() => { if (switched.current) (card ? cardHeading.current : showButton.current)?.focus(); switched.current = true; }, [card]);
  const name = (id: string) => ds.stops.find((s) => s.id === id)?.name ?? id;
  const clock = (at: number) => formatTime12(at, ds.meta.timezone, lang);
  const alightIndex = placeIndex(ds, dep.pattern, toStopId, dep.stopIndex + 1);
  const at = alightIndex > dep.stopIndex ? tripStopTimes(ds, dep)[alightIndex] : undefined;
  const dest = name(toStopId);
  const variant = dep.pattern.variant ? t.variantNotes[dep.pattern.variant] : undefined;
  // The same printed stop notes the trip screen shows: where pickups really are, and request-only stops.
  const board = ds.stops.find((s) => s.id === dep.pattern.stopIds[dep.stopIndex]);
  const alight = ds.stops.find((s) => s.id === toStopId);
  const requestOnly = alight?.noteId === 'parkride-request' && ['P', 'FP'].includes(dep.pattern.variant ?? '');
  const alightNote = alight?.noteId && (alight.noteId !== 'parkride-request' || requestOnly) ? t.stopNotes[alight.noteId] : undefined;
  const boardNote = board?.noteId ? t.stopNotes[board.noteId] : undefined;

  if (card) {
    // Both languages at once, whatever the app language: the driver may read either.
    return (
      <section className="driver-card" aria-label={c.cardLabel}>
        <h1 className="driver-q" lang="en" tabIndex={-1} ref={cardHeading}>{strings.en.boarding.ask(place(dest))}</h1>
        <p className="driver-q" lang="es">{strings.es.boarding.ask(place(dest))}</p>
        <p className="driver-route">{dep.route.shortName} · {dep.pattern.headsign}</p>
        <button className="primary wide" onClick={() => setCard(false)}>{c.closeCard}</button>
      </section>
    );
  }
  return (
    <section className="boarding-check">
      <h1>{c.title}</h1>
      <dl className="lock-facts">
        <div><dt>{c.route}</dt><dd>{dep.route.shortName}{variant ? ` · ${variant}` : ''}</dd></div>
        <div><dt>{c.direction}</dt><dd>{dep.pattern.headsign}</dd></div>
        <div><dt>{c.leaves}</dt><dd>{dep.estimated ? '~' : ''}{clock(dep.departs)} · {name(dep.pattern.stopIds[dep.stopIndex]!)}</dd></div>
        <div><dt>{c.gettingOff}</dt><dd>{dest}</dd></div>
      </dl>
      {at
        ? <p className="boarding-ok" role="status">{(requestOnly ? c.servesOnRequest : c.serves)(dest, `${at.estimated ? '~' : ''}${clock(at.at)}`)}</p>
        : <p className="warn" role="alert">{c.notServed(dest)}</p>}
      {alightNote && <p className="warn small" role="note">{alightNote}</p>}
      {boardNote && <p className="muted small" role="note">{boardNote}</p>}
      {ds.meta.transcribed && <p className="muted small">{c.printed}</p>}
      {gate && <p className="dep-gate">{gate}</p>}
      <p className="small">{c.checkSign}</p>
      <button className="primary wide" ref={showButton} onClick={() => setCard(true)}>{c.showCard}</button>
      <p className="muted small">{c.notThisBus}</p>
    </section>
  );
}
