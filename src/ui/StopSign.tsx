import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Dataset, Stop } from '../domain/types';
import {
  resolveStopScene, SIGN_NUMBER, SIGN_VIEW, signRowPlacement, signRowTexts, STOP_SCENES, stopSceneChoice, stopSignRoutes,
  type SignPlacement, type StopSceneChoice,
} from '../domain/stopSign';
import type { Strings } from './i18n';
import './stopSign.css';

// Import URLs, not image bytes. Only the chosen photo is requested after opening.
const pictures = import.meta.glob('../assets/stop-signs/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/** One line of lettering on the photographed sign, squeezed only if it would run off the ruled line. */
function SignText({ at, className, children }: { at: SignPlacement; className: string; children: string }) {
  const ref = useRef<SVGTextElement>(null);
  const [squeeze, setSqueeze] = useState(false);
  useLayoutEffect(() => {
    const fit = () => {
      const node = ref.current;
      if (!node || typeof node.getComputedTextLength !== 'function') return;
      node.removeAttribute('textLength');
      setSqueeze(node.getComputedTextLength() > at.maxWidth);
    };
    fit();
    document.fonts?.addEventListener?.('loadingdone', fit);
    return () => document.fonts?.removeEventListener?.('loadingdone', fit);
  }, [children, at.maxWidth]);
  return <text ref={ref} className={className} filter="url(#stop-sign-ink)"
    transform={`matrix(1 ${at.slope.toFixed(4)} 0 1 ${at.x.toFixed(2)} ${at.y.toFixed(2)})`}
    {...(squeeze ? { textLength: at.maxWidth, lengthAdjust: 'spacingAndGlyphs' } : {})}>{children}</text>;
}

/** Lazy boarding-sign panel; the caller places its linked disclosure button among trip actions. */
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
  // Physical sign wording stays as printed; surrounding controls/explanations translate.
  const signDestination = to.terminal === 'PABT' ? 'New York · Port Authority' : to.name;
  const rowDestination = to.terminal === 'PABT' ? 'New York' : to.name;
  const number = from.code ? t.selection.stopNumber(from.code) : t.selection.numberUnknown;
  const photo = scene && !failed;
  return <>
    {actions(<button type="button" className="chip stop-sign-toggle" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen(value => !value)}>{s.open}</button>)}
    <section id={`${id}-panel`} className="stop-sign" hidden={!open} aria-label={s.title}>
    {open && <div className="stop-sign-content">
      <h3>{s.title}</h3>
      <p><strong>{from.name}</strong><br />{number}<br />{t.selection.towards}: {destination}</p>
      <p>{s.routes}: {routes.length ? routes.join(' · ') : s.unknownRoutes}</p>
      <figure>
        {/* The real NJ Transit sign as photographed (D69); Dale writes this stop's routes and number on it.
            Decorative: the same facts are in the text above. */}
        {photo && <div className="stop-sign-art" aria-hidden="true">
          <img key={scene} src={pictures[`../assets/stop-signs/${scene}.webp`]} alt="" width={SIGN_VIEW.width} height={SIGN_VIEW.height}
            decoding="async" fetchPriority="low" onError={() => setFailed(true)} />
          <svg viewBox={`0 0 ${SIGN_VIEW.width} ${SIGN_VIEW.height}`} focusable="false">
            <defs><filter id="stop-sign-ink" x="-5%" y="-30%" width="110%" height="160%"><feGaussianBlur stdDeviation=".35" /></filter></defs>
            {signRowTexts(routes, rowDestination).map((line, row) => <SignText key={row} at={signRowPlacement(row)} className="stop-sign-row">{line}</SignText>)}
            <SignText at={SIGN_NUMBER} className="stop-sign-number">{from.code || '—'}</SignText>
          </svg>
        </div>}
        {/* Plain drawn sign when the photo is unavailable or the device forces its own colors. */}
        <div className="stop-sign-face" data-fallback={photo ? 'forced-colors' : 'always'} aria-hidden="true">
          <span>Bus Stop</span>
          <strong className="stop-sign-face-number">{from.code || '—'}</strong>
          <div className="stop-sign-route-tags">{routes.map(route => <strong key={route}>{route}</strong>)}</div>
          <span>{signDestination}</span>
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
