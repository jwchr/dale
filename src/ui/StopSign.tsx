import { useId, useState, type ReactNode } from 'react';
import type { Dataset, Stop } from '../domain/types';
import { resolveStopScene, STOP_SCENES, stopSceneChoice, stopSignRoutes, type StopSceneChoice } from '../domain/stopSign';
import type { Strings } from './i18n';
import './stopSign.css';

// Import URLs, not image bytes. Only the chosen image is requested after opening.
const pictures = import.meta.glob('../assets/stop-scenes/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export function StopSign({ ds, from, to, routeIds, now, t, actions }: {
  ds: Dataset; from: Stop; to: Stop; routeIds: string[]; now: number; t: Strings; actions: (trigger: ReactNode) => ReactNode;
}) {
  const s = t.stopSign;
  const id = useId();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<StopSceneChoice>('auto');
  const [failed, setFailed] = useState(false);
  const scene = open ? resolveStopScene(choice, now) : undefined;
  const routes = open ? stopSignRoutes(ds, from.id, to.id, routeIds) : [];
  const destination = to.terminal === 'PABT' ? `${t.commuteNewYork} · ${t.commutePabt}` : to.name;
  const number = from.code ? t.selection.stopNumber(from.code) : t.selection.numberUnknown;
  return <>
    {actions(<button type="button" className="chip stop-sign-toggle" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen(value => !value)}>{s.open}</button>)}
    <section id={`${id}-panel`} className="stop-sign" hidden={!open} aria-label={s.title}>
    {open && <div className="stop-sign-content">
      <h3>{s.title}</h3>
      <p><strong>{from.name}</strong><br />{number}<br />{t.selection.towards}: {destination}</p>
      <p>{s.routes}: {routes.length ? routes.join(' · ') : s.unknownRoutes}</p>
      <figure>
        <div className="stop-sign-art" aria-hidden="true">
          {/* Crop to the leftmost 40% of the approved scene: the original sign is entirely
              outside this window. No loading, failure or text-wrap state can reveal it. */}
          {scene && !failed && <img key={scene} src={pictures[`../assets/stop-scenes/${scene}.webp`]}
            alt="" width="941" height="1672" decoding="async" fetchPriority="low" onError={() => setFailed(true)} />}
          <div className="stop-sign-face">
            <strong className="stop-sign-brand">DALE!</strong>
            <span>{s.stop}</span>
            <strong className="stop-sign-number">{from.code || t.selection.numberUnknown}</strong>
            <div className="stop-sign-route-tags">{routes.map(route => <strong key={route}>{route}</strong>)}</div>
            <span>{destination}</span>
          </div>
        </div>
        <figcaption>{s.illustration}</figcaption>
      </figure>
      {(!scene || failed) && <p role="status">{s.failed}</p>}
      <label htmlFor={id}>{s.artwork}</label>
      <select id={id} value={choice} onChange={e => { setChoice(stopSceneChoice(e.target.value)); setFailed(false); }}>
        <option value="auto">{s.automatic}</option>
        {STOP_SCENES.map(value => <option key={value} value={value}>{s.scenes[value]}</option>)}
      </select>
      <p className="small muted">{s.automaticNote}</p>
      <p className="small">{s.note}</p>
    </div>}
    </section>
  </>;
}
