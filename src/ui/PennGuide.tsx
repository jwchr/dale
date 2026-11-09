import { useEffect, useRef, useState } from 'react';
import { initialChecklist, readChecklist, saveChecklist, STATIONS, type JourneyChecklist } from '../domain/journeyGuide';
import type { Strings } from './i18n';
import { RailPreview } from './RailPreview';

const stationUrls = { anderson: 'https://www.njtransit.com/station/anderson-street-station', essex: 'https://www.njtransit.com/station/essex-street-station-pvl' };
/** Lives above screen navigation, so even blocked storage cannot erase progress on a mode switch. */
export function useJourneyChecklist(demo: boolean) {
  const storage = (() => { try { return window.localStorage; } catch { return undefined; } })();
  const [state, setState] = useState(() => demo ? initialChecklist() : readChecklist(storage));
  const [saved, setSaved] = useState(false);
  const previousDemo = useRef(demo);
  const modes = useRef<Partial<Record<JourneyChecklist['mode'], JourneyChecklist>>>({});
  useEffect(() => {
    if (demo !== previousDemo.current) {
      previousDemo.current = demo; modes.current = {};
      setState(demo ? initialChecklist() : readChecklist(storage));
    }
  }, [demo, storage]);
  useEffect(() => { if (!demo) setSaved(saveChecklist(storage, state)); }, [state, storage, demo]);
  const selectMode = (mode: JourneyChecklist['mode']) => setState(current => {
    if (current.mode === mode) return current;
    modes.current[current.mode] = current;
    return modes.current[mode] ?? (demo ? { ...initialChecklist(), mode } : readChecklist(storage, mode));
  });
  return { state, setState, saved, selectMode };
}
export type JourneyModel = ReturnType<typeof useJourneyChecklist>;
export function PennGuide({ t, demo = false, model, railOnly = false }: {
  t: Strings; demo?: boolean; model: JourneyModel; railOnly?: boolean;
}) {
  const j = t.journey;
  const { state, setState, saved, selectMode } = model;
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const [focusStep, setFocusStep] = useState(false);
  useEffect(() => { if (focusStep) { stepHeading.current?.focus(); setFocusStep(false); } }, [focusStep]);
  const select = (patch: Partial<JourneyChecklist>) => setState((s) => Object.entries(patch).every(([key, value]) => s[key as keyof JourneyChecklist] === value) ? s : { ...s, ...patch, step: 0 });
  const station = j.stations[state.station];
  const steps = state.mode === 'train' ? (state.direction === 'outbound' ? j.railOut(station) : j.railReturn(station))
    : state.direction === 'outbound' ? j.busOut : j.busReturn;
  const step = steps[state.step]!;
  const move = (n: number) => { setState((s) => ({ ...s, step: n })); setFocusStep(true); };
  const checklist = <>
    <div className="choice-list">
      <button className="chip" aria-pressed={!state.travelling} onClick={() => setState((s) => ({ ...s, travelling: false }))}>{j.practice}</button>
      <button className="chip" aria-pressed={state.travelling} onClick={() => setState((s) => ({ ...s, travelling: true }))}>{j.travelling}</button>
    </div>
    <p className="warn" role="note">{state.travelling ? j.travelNote : j.practiceNote}</p>
    <article className="card journey-step" aria-labelledby="journey-step-title">
      {state.mode !== 'train' && <p className="badge-sched">{j.step(state.step + 1, steps.length)}</p>}
      <h2 id="journey-step-title" tabIndex={-1} ref={stepHeading}>{step.title}</h2><p>{step.text}</p>
      <div className="row-between">
        <button disabled={state.step === 0} onClick={() => move(state.step - 1)}>{j.previous}</button>
        {state.step < steps.length - 1 ? <button className="primary" onClick={() => move(state.step + 1)}>{state.travelling ? j.done : j.next}</button>
          : <button onClick={() => move(0)}>{j.restart}</button>}
      </div>
    </article>
    {!demo && <p className="small" role="status">{saved ? j.saved : j.unsaved}</p>}
  </>;
  const help = <>
    <p className="warn" role="note">{j.limits}</p><p>{j.days}</p>
    {state.mode === 'train' && <div className="card"><h2>{j.ticketTitle}</h2><p>{j.ticket(station)}</p><h2>{j.missedTitle}</h2><p>{j.missed}</p></div>}
    <div className="card journey-links">
      <a className="link" target="_blank" rel="noreferrer" href="https://www.njtransit.com/trip-planner-to">{j.planner}</a>
      {state.mode === 'train' && <a className="link" target="_blank" rel="noreferrer" href="https://webtickets.njtransit.com/">{j.tickets}</a>}
      <a className="link" target="_blank" rel="noreferrer" href="https://www.njtransit.com/app">{j.app}</a>
      <a className="link" target="_blank" rel="noreferrer" href="https://www.njtransit.com/travel-alerts-to">{j.alerts}</a>
      {state.mode === 'train' && <a className="link" target="_blank" rel="noreferrer" href={stationUrls[state.station]}>{j.stationLink}</a>}
      <p className="small">{j.external}</p>
    </div>
    <details className="card"><summary>{j.walks}</summary><p>{j.walkHelp}</p>
      {([...STATIONS, 'summit'] as const).map((key) => <label className="journey-walk" key={key}>{j.walkLabel(j.stations[key])}
        <input type="number" min="0" max="120" step="1" inputMode="numeric" value={state.walks[key] ?? ''} onChange={(e) => {
          const raw = e.target.value, n = Number(raw);
          if (raw && (!Number.isInteger(n) || n < 0 || n > 120)) return;
          setState((s) => { const walks = { ...s.walks }; if (!raw) delete walks[key]; else walks[key] = n; return { ...s, walks }; });
        }} />
      </label>)}
    </details>
    <p className="muted small">{j.sources}</p>
  </>;
  return <section className="penn-guide">
    <h1>{j.title}</h1>{state.mode !== 'train' && <><p>{j.intro}</p><p className="small">{j.scope}</p></>}
    <div className="card journey-controls">
      {!railOnly && <h2>{j.compare}</h2>}
      {!railOnly && <div className="choice-list">
        <button className="chip" aria-pressed={state.mode === 'train'} onClick={() => selectMode('train')}>{j.train}</button>
        <button className="chip" aria-pressed={state.mode === 'bus'} onClick={() => selectMode('bus')}>{j.bus}</button>
      </div>}
      {state.mode !== 'train' && <p>{j.busSummary}</p>}

      {state.mode === 'train' && <label>{j.station}<select value={state.station} onChange={(e) => select({ station: e.target.value as JourneyChecklist['station'] })}>
        {STATIONS.map((s) => <option key={s} value={s}>{j.stations[s]}</option>)}
      </select></label>}
      <fieldset><legend className="sr-only">{j.direction}</legend><div className="choice-list">
        <button className="chip" aria-pressed={state.direction === 'outbound'} onClick={() => select({ direction: 'outbound' })}>{j.outbound}</button>
        <button className="chip" aria-pressed={state.direction === 'return'} onClick={() => select({ direction: 'return' })}>{j.returning}</button>
      </div></fieldset>
    </div>
    {state.mode === 'train' && <RailPreview station={state.station} direction={state.direction} t={t} />}
    {state.mode === 'train' ? <>
      <details className="card journey-checklist"><summary>{t.rail.checklist} · <span>{j.step(state.step + 1, steps.length)}</span></summary>{checklist}</details>
      <details className="card journey-help"><summary>{t.rail.help}</summary><p>{j.intro}</p><p className="small">{j.scope}</p><p>{j.trainSummary}</p>{help}</details>
    </> : <>{checklist}{help}</>}
  </section>;
}
