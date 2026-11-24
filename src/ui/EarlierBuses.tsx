import { useEffect, useId, useMemo, useState } from 'react';
import { loadEarlierBuses } from '../data/earlierBuses';
import { parseEarlierQuery, type EarlierAnswer, type EarlierBus, type EarlierTime } from '../domain/earlierBuses';
import { formatTime12, localYmd } from '../domain/time';
import { routeLabel } from '../domain/routeDisplay';
import { boardIndex, samePlace } from '../domain/place';
import type { Dataset } from '../domain/types';
import { strings, type Lang } from './i18n';

interface Props { ds: Dataset; stop: string; routeIds: string[]; direction?: 0 | 1; toStop?: string; lang: Lang; now: number; api?: string }
export function EarlierBuses({ ds, stop, routeIds, direction, toStop, lang, now, api }: Props) {
  const s = strings[lang].earlierBuses, heading = useId();
  const queries = useMemo(() => {
    const routes = new Set(routeIds), seen = new Set<string>();
    return ds.patterns.flatMap(p => {
      const index = boardIndex(ds, p, stop);
      if ((routes.size > 0 && !routes.has(p.routeId)) || index < 0 || (direction !== undefined && p.directionId !== direction)
        || (toStop && !p.stopIds.some((id, i) => samePlace(ds, id, toStop) && i > index))) return [];
      const route = ds.routes.find(r => r.id === p.routeId)?.shortName;
      const key = `${route}|${p.directionId}`;
      if (!route || seen.has(key)) return [];
      seen.add(key);
      const query = parseEarlierQuery(new URLSearchParams({ route, stop, direction: String(p.directionId) }), ds);
      return query ? [query] : [];
    });
  }, [ds, stop, routeIds.join('|'), direction, toStop]);
  const today = localYmd(now, ds.meta.timezone), key = `${today}|${JSON.stringify(queries)}`;
  const [view, setView] = useState<{ key: string; answers?: (EarlierAnswer | undefined)[] }>({ key: '' });
  useEffect(() => {
    // Nothing to ask the server: answer at once, with no timer or visibility listener (Neon BONUS Nov24).
    if (!api || ds.meta.demo || !queries.length) { setView({ key, answers: [] }); return; }
    let alive = true;
    const end = pollWhileVisible(async isLatest => {
      const answers = await Promise.all(queries.map(q => loadEarlierBuses(api, q, today)));
      if (alive && isLatest()) setView({ key, answers });
    }, typeof document === 'undefined' ? undefined : document, 60_000);
    return () => { alive = false; end(); };
  }, [key, today, api, ds.meta.demo]);
  const loading = view.key !== key || !view.answers;
  const answers = view.key === key ? view.answers ?? [] : [];
  const clock = (at: number) => formatTime12(at, ds.meta.timezone, lang);
  const coverageClock = (at: number) => localYmd(at, ds.meta.timezone) === today ? clock(at)
    : new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { timeZone: ds.meta.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(at);
  return <section className="dash-panel earlier-buses" aria-labelledby={heading}>
    <h3 className="dash-title" id={heading}>{s.title}</h3>
    <div aria-live="polite">{loading ? <p className="muted">{s.loading}</p> : !queries.length ? <p className="muted">{s.unavailable}</p>
      : queries.map((query, qi) => {
        const a = answers[qi], routeKey = `${query.route}|${query.direction}`;
        if (!a || localYmd(a.generatedAt, ds.meta.timezone) !== today || now - a.generatedAt >= 10 * 60_000)
          return <p key={routeKey} className="muted">{routeLabel(query.route, strings[lang].gateTurnpikeExpress)} · {s.unavailable}</p>;
        return <div key={routeKey}>
        <p className="small muted">{routeLabel(a.query.route, strings[lang].gateTurnpikeExpress)} · {s.coverage} {coverageClock(a.coverageStart)} · {s.through} {coverageClock(a.through)}</p>
        {a.gap && <p className="small warn">{s.gap}</p>}
        {!a.items.length ? <p className="muted">{s.empty}</p> : <ul className="earlier-list">{earlierKeys(a.items).map(([bus, itemKey]) => <li key={itemKey}>
          <EarlierBusDetails bus={bus} ds={ds} lang={lang} now={now} />
        </li>)}</ul>}
      </div>; })}</div>
    <p className="small muted">{s.scheduleSource} · {Number.isFinite(Date.parse(ds.meta.builtAt)) ? s.age(Math.max(0, Math.floor((now - Date.parse(ds.meta.builtAt)) / 60_000))) : s.unknown}</p>
    <p className="small muted">{s.explain}</p>
  </section>;
}

/** Shared disclosure for an exact earlier-bus record, also usable by #252's just-left row.
 * No lock action or rider storage access. The caller supplies the exact record, never a route-only match.
 */
export function EarlierBusDetails({ bus, ds, lang, now }: { bus: EarlierBus; ds: Dataset; lang: Lang; now: number }) {
  const s = strings[lang].earlierBuses;
  const today = localYmd(now, ds.meta.timezone);
  const clock = (at: number) => localYmd(at, ds.meta.timezone) === today ? formatTime12(at, ds.meta.timezone, lang)
    : new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { timeZone: ds.meta.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(at);
  const age = (at: number) => s.age(Math.max(0, Math.floor((now - at) / 60_000)));
  const scheduleAge = Date.parse(ds.meta.builtAt);
  function evidence(t: EarlierTime) {
    const e = t.evidence;
    return e ? <><strong>{e.kind === 'gps' ? s.observed : s.expected}: {clock(e.at)}{e.minutesLate !== null && <> · {s.late(e.minutesLate)}</>}</strong>
      <span className="small muted">{e.kind === 'gps' ? s.gps : s.prediction} · {age(e.sourceAt)}</span></>
      : <span className="muted">{s.unknown}</span>;
  }
  return <details>
    <summary><span>{routeLabel(bus.route, strings[lang].gateTurnpikeExpress)} · {s.scheduled} {bus.stop.scheduledAt === null ? s.unknown : clock(bus.stop.scheduledAt)}</span>
      <span className="earlier-summary"><span className="earlier-place">{s.atStop}: {evidence(bus.stop)}</span>{bus.portAuthority !== null && <span className="earlier-place">{s.terminal}: {evidence(bus.portAuthority)}</span>}</span>
      <span className="small earlier-details-label">{s.details}</span>
    </summary>
    <dl>{([[s.atStop, bus.stop], ...(bus.portAuthority !== null ? [[s.terminal, bus.portAuthority] as const] : [])] as const).map(([label, time]) => <div key={label}>
      <dt>{label}</dt><dd>{s.scheduled}: {time?.scheduledAt ? clock(time.scheduledAt) : s.unknown}
        <span className="small muted earlier-source">{s.scheduleSource} · {Number.isFinite(scheduleAge) ? age(scheduleAge) : s.unknown}</span>
        <div>{s.actual}: {s.unknown}</div>
        {time && <div className="earlier-evidence">{evidence(time)}</div>}
      </dd></div>)}</dl>
    <p className="small muted">{s.explain}</p>
  </details>;
}

/** Stable list keys, so a newly listed bus does not close an open row (Neon BONUS Nov24). */
function earlierKeys(items: EarlierBus[]): [EarlierBus, string][] {
  const seen = new Map<string, number>();
  return items.map(bus => {
    const base = `${bus.route}|${bus.stop.scheduledAt ?? `e${bus.stop.evidence?.at ?? ''}`}`, n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return [bus, n ? `${base}|${n}` : base];
  });
}

type VisibilityDoc = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
/**
 * Runs `load` now, every `everyMs` while the page is visible, and again when it becomes visible
 * (audit, Nov 24, 2026): a hidden tab does not poll, and only the newest run may show its answer,
 * so a slow older request can never replace a newer list.
 */
export function pollWhileVisible(load: (isLatest: () => boolean) => Promise<void> | void, doc: VisibilityDoc | undefined, everyMs: number, clock: () => number = Date.now): () => void {
  let latest = 0, lastRun = -Infinity, timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => doc?.visibilityState !== 'hidden';
  // Each run restarts the cadence; a hidden tab lets the timer lapse until it is shown again (Neon BONUS Nov24).
  const tick = () => { timer = undefined; if (visible()) run(); };
  const run = () => {
    const ticket = ++latest; lastRun = clock();
    clearTimeout(timer); timer = setTimeout(tick, everyMs);
    void load(() => ticket === latest);
  };
  // Showing the tab polls only when the last answer is a full interval old, so quick tab switches send nothing.
  const onChange = () => { if (visible() && clock() - lastRun >= everyMs) run(); };
  if (visible()) run();
  doc?.addEventListener('visibilitychange', onChange);
  return () => { clearTimeout(timer); doc?.removeEventListener('visibilitychange', onChange); };
}
