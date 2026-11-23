import { routeNumber, routeHeadsign } from '../domain/routeDisplay';
import { useEffect, useMemo, useState } from 'react';
import { BUCKET_COUNT, confidenceKeyFor, summarize, type ConfidenceAnswer, type ConfidenceBucket, type ConfidenceKey } from '../domain/arrivalConfidence';
import { addDays, formatTime12 } from '../domain/time';
import type { Dataset, Departure } from '../domain/types';
import { loadArrivalConfidence, type ConfidenceResult } from '../data/arrivalConfidence';
import { howSureStrings, type HowSureStrings } from './howSureStrings';
import { strings, type Lang } from './i18n';

type Ready = Extract<ConfidenceAnswer, { state: 'ready' }>;
type View = { state: 'loading' } | { state: 'none' } | ConfidenceResult | { state: 'demo'; answer: Ready };

/** A labeled sample for demo data only: real summarize() shape, fictional dates and counts (meta.demo). */
export function demoAnswer(key: ConfidenceKey, serviceDate: string, departs: number): Ready {
  const c = new Array<number>(BUCKET_COUNT).fill(0);
  [[11, 9], [12, 16], [13, 18], [14, 13], [15, 12], [16, 8], [17, 7], [18, 5], [19, 4], [20, 3], [21, 2], [22, 1], [24, 1], [31, 1]]
    .forEach(([i, n]) => { c[i!] = n!; });
  const first = addDays(serviceDate, -120), late = addDays(serviceDate, -38), best = addDays(serviceDate, -79);
  const answer = summarize({ c, d: '', f: first, l: addDays(serviceDate, -1), w: [20 * 60, late, departs + 20 * 60_000],
    b: [0, best, departs], e: [-60, addDays(serviceDate, -55), departs - 60_000], u: [0, 0] }, key, 'Demo sample');
  return answer as Ready;
}

const fmtDate = (iso: string, lang: Lang) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(y!, m! - 1, d!));
};

interface Props { ds: Dataset; dep: Departure; lang: Lang; api: string | undefined }

/** "How sure are we?" (#91, mock-up 03): measured history only. Never a live signal, never a guess. */
export function HowSure({ ds, dep, lang, api }: Props) {
  const s = howSureStrings[lang];
  const key = useMemo(() => confidenceKeyFor(ds, dep), [ds, dep]);
  const keyText = key && JSON.stringify(key);
  const [view, setView] = useState<View>({ state: 'loading' });
  const [size, setSize] = useState<1 | 5>(5);
  useEffect(() => {
    if (!key) { setView({ state: 'none' }); return; }
    if (ds.meta.demo) { setView({ state: 'demo', answer: demoAnswer(key, dep.serviceDate, dep.departs) }); return; }
    if (!api) { setView({ state: 'off' }); return; }
    let alive = true;
    setView({ state: 'loading' });
    void loadArrivalConfidence(api, key).then((r) => { if (alive) setView(r); });
    return () => { alive = false; };
    // keyText stands for key; the departure's time is part of it.
  }, [keyText, ds.meta.demo, api, dep.serviceDate, dep.departs]);

  const tz = ds.meta.timezone, clock = (at: number) => formatTime12(at, tz, lang);
  const demo = view.state === 'demo';
  const answer = view.state === 'demo' ? view.answer : view.state === 'answer' ? view.answer : undefined;

  return (
    <section className="card how-sure" aria-labelledby="how-sure-heading">
      <div className="row-between how-sure-head">
        <h2 id="how-sure-heading"><span className="how-sure-icon" aria-hidden="true">((•))</span> {s.title}</h2>
        <span className="how-sure-badge">{demo ? s.demoBadge : s.badge}</span>
      </div>
      <div aria-live="polite">
        {view.state === 'loading' && <p className="muted">{s.loading}</p>}
        {view.state === 'none' && <Lead title={s.notMeasured} help={s.notMeasuredHelp} />}
        {view.state === 'off' && <Lead title={s.off} help={s.offHelp} />}
        {view.state === 'unavailable' && <Lead title={s.unavailable} help={s.unavailableHelp} />}
        {answer?.state === 'insufficient' && <Lead title={s.building} help={s.buildingCount(answer.samples, answer.minimumSamples)} />}
        {answer?.state === 'ready' && <ReadyView a={answer} s={s} lang={lang} dep={dep} clock={clock} demo={demo} size={size} setSize={setSize} />}
      </div>
      <p className="how-sure-explain small"><span aria-hidden="true">ⓘ</span> <span><strong>{s.explainTitle}</strong> {s.explain}</span></p>
    </section>
  );
}

const Lead = ({ title, help }: { title: string; help: string }) => <>
  <p className="how-sure-lead">{title}</p>
  <p className="how-sure-help">{help}</p>
</>;

interface ReadyProps { a: Ready; s: HowSureStrings; lang: Lang; dep: Departure; clock: (at: number) => string; demo: boolean; size: 1 | 5; setSize: (n: 1 | 5) => void }

function ReadyView({ a, s, lang, dep, clock, demo, size, setSize }: ReadyProps) {
  const at = (minute: number) => dep.departs + minute * 60_000;
  const pct = (n: number) => Math.round((n / a.samples) * 100);
  const five = a.fiveMinute, top = five.reduce((m, b) => (b.count > m.count ? b : m), five[0]!);
  // Five-minute view: the windows that hold arrivals, never trimming one that does. One-minute view scrolls.
  const used = (list: ConfidenceBucket[]) => {
    const first = list.findIndex((b) => b.count > 0), last = list.length - 1 - [...list].reverse().findIndex((b) => b.count > 0);
    return list.slice(Math.max(0, first), last + 1);
  };
  const rows = size === 5 ? used(five) : used(a.oneMinute);
  // The mock-up's "12:00-12:04" rows: AM/PM once in the column header when every row shares it.
  const edges = rows.flatMap((b) => [b.fromMinute ?? b.toMinute!, b.toMinute === null ? b.fromMinute! : b.toMinute - 1]);
  const suffixes = new Set(edges.map((m) => clock(at(m)).split(' ').slice(1).join(' ')));
  const shared = suffixes.size === 1 ? [...suffixes][0]! : '';
  const short = (minute: number) => { const text = clock(at(minute)); return shared ? text.slice(0, text.length - shared.length).trim() : text; };
  const range = (b: ConfidenceBucket, cut: (m: number) => string) => b.fromMinute === null ? s.before(cut(b.toMinute!))
    : b.toMinute === null ? `${cut(b.fromMinute)}+`
      : b.toMinute - b.fromMinute === 1 ? cut(b.fromMinute) : `${cut(b.fromMinute)}–${cut(b.toMinute - 1)}`;
  const label = (b: ConfidenceBucket) => range(b, short);
  const full = (b: ConfidenceBucket) => shared && b.fromMinute !== null && b.toMinute !== null ? `${range(b, short)} ${shared}` : range(b, (m) => clock(at(m)));
  const max = Math.max(...rows.map((b) => b.count), 1);
  const lastRow = rows[rows.length - 1]!;
  const days = s.days[a.query.dayType];
  const record = (r: Ready['worst']) => r.minutes > 0 ? s.late(r.minutes) : r.minutes < 0 ? s.early(-r.minutes) : s.onTime;
  const fictional = demo ? ` · ${s.fictional}` : '';
  return <>
    <p className="how-sure-lead">{s.mostOften(full(top))}</p>
    <p className="how-sure-help">{s.share(pct(top.count), a.samples, days)}</p>
    <div className="how-sure-when">
      <div>
        <h3>{s.when}</h3>
        <p className="small">{s.scheduledFor} <strong>{clock(dep.departs)}</strong></p>
        <p className="muted small">{routeNumber(dep.route.shortName)} · {routeHeadsign(dep.pattern.headsign, dep.route.shortName, strings[lang].gateTurnpikeExpress)}</p>
      </div>
      <div className="how-sure-toggle" role="group" aria-label={s.bucketSize}>
        <button type="button" aria-pressed={size === 1} onClick={() => setSize(1)}>{s.oneMin}</button>
        <button type="button" aria-pressed={size === 5} onClick={() => setSize(5)}>{s.fiveMin}</button>
      </div>
    </div>
    <div className="how-sure-cols small" aria-hidden="true"><span>{s.actual}{shared ? ` · ${shared}` : ''}</span><span>{s.tripsShare}</span></div>
    <ol className={`how-sure-bars${size === 1 ? ' scroll' : ''}`} tabIndex={size === 1 ? 0 : undefined} aria-label={s.actual}>
      {rows.map((b) => <li key={`${b.fromMinute}-${b.toMinute}`}>
        <span className="how-sure-time"><span aria-hidden="true">{label(b)}</span><span className="sr-only">{full(b)}</span></span>
        <span className="how-sure-track" aria-hidden="true"><span style={{ width: `${(b.count / max) * 100}%` }} /></span>
        <span className="how-sure-pct"><strong>{pct(b.count)}%</strong><span>{s.trips(b.count)}</span></span>
      </li>)}
    </ol>
    {size === 1 && <p className="muted small">{s.scrollNote(full(lastRow))}</p>}
    <div className="how-sure-records">
      <div className="row-between"><span className="how-sure-cap">{s.recordBook}</span>{demo && <span className="how-sure-cap">{s.demoNote}</span>}</div>
      <div className="how-sure-record-grid">
        <div><p className="small">{s.worst}</p><p className="how-sure-worst"><strong>{record(a.worst)}</strong> <span className="clock">({clock(a.worst.arrivedAt)})</span></p>
          <p className="muted small">{fmtDate(a.worst.serviceDate, lang)}{fictional}</p></div>
        <div><p className="small">{s.best}</p><p className="how-sure-best"><strong>{record(a.best)}</strong> <span className="clock">({clock(a.best.arrivedAt)})</span></p>
          <p className="muted small">{fmtDate(a.best.serviceDate, lang)}{fictional}</p></div>
      </div>
    </div>
    <p className="muted small how-sure-source">{demo ? s.demoNote : s.source} · {s.measured(fmtDate(a.firstServiceDate, lang), fmtDate(a.lastServiceDate, lang), days)}</p>
  </>;
}
