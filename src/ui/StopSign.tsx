import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Dataset, Stop } from '../domain/types';
import {
  resolveStopScene, SIGN_NUMBER, SIGN_VIEW, signRowBand, signRowPlacement, STOP_SCENES, stopSceneChoice, stopSignLines,
  type SignPlacement, type StopSceneChoice,
} from '../domain/stopSign';
import type { Strings } from './i18n';
import './stopSign.css';

// Import URLs, not image bytes. Only the chosen photo is requested after opening.
const pictures = import.meta.glob('../assets/stop-signs/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/** One line of lettering on the photographed sign, squeezed only if it would run off the ruled line. */
function SignText({ at, className, children, ink = true }: { at: SignPlacement; className: string; children: string; ink?: boolean }) {
  const ref = useRef<SVGTextElement>(null);
  const [squeeze, setSqueeze] = useState(false);
  useLayoutEffect(() => {
    const fit = () => {
      const node = ref.current;
      if (!node || typeof node.getComputedTextLength !== 'function') return;
      // Measure the natural width, then put any squeeze back: if the answer is unchanged React will not re-render.
      const kept = node.getAttribute('textLength');
      node.removeAttribute('textLength');
      const natural = node.getComputedTextLength();
      if (kept !== null) node.setAttribute('textLength', kept);
      setSqueeze(natural > at.maxWidth);
    };
    fit();
    document.fonts?.addEventListener?.('loadingdone', fit);
    return () => document.fonts?.removeEventListener?.('loadingdone', fit);
  }, [children, at.maxWidth]);
  return <text ref={ref} className={className} filter={ink ? 'url(#stop-sign-ink)' : undefined}
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
  const destination = to.terminal === 'PABT' ? `${t.commuteNewYork} · ${t.commutePabt}` : to.name;
  // Physical sign wording stays as printed; surrounding controls/explanations translate.
  const signDestination = to.terminal === 'PABT' ? 'New York · Port Authority' : to.name;
  const lines = open ? stopSignLines(ds, from.id, to.id, routeIds) : [];
  const yourRow = lines.findIndex(line => line.yours);
  const number = from.code ? t.selection.stopNumber(from.code) : t.selection.numberUnknown;
  const photo = scene && !failed;
  return <>
    {actions(<button type="button" className="chip stop-sign-toggle" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen(value => !value)}>{s.open}</button>)}
    <section id={`${id}-panel`} className="stop-sign" hidden={!open} aria-label={s.title}>
    {open && <div className="stop-sign-content">
      <h3>{s.title}</h3>
      <p><strong>{from.name}</strong><br />{number}<br />{t.selection.towards}: {destination}</p>
      {/* Accessible list of every route shown on the sign, with the rider's own bus noted;
          route numbers stay language-neutral, "Your bus" translates. */}
      <p>{s.routes}: {lines.length
        ? lines.map(line => line.yours && line.route ? `${line.route} (${s.yourBus})` : line.route || line.text).join(' · ')
        : s.unknownRoutes}</p>
      <figure>
        {/* The real NJ Transit sign as photographed (D69); Dale writes this stop's routes and number on it.
            Decorative: the same facts are in the text above. */}
        {photo && <div className="stop-sign-art" aria-hidden="true">
          <img key={scene} src={pictures[`../assets/stop-signs/${scene}.webp`]} alt="" width={SIGN_VIEW.width} height={SIGN_VIEW.height}
            decoding="async" fetchPriority="low" onError={() => setFailed(true)} />
          <svg viewBox={`0 0 ${SIGN_VIEW.width} ${SIGN_VIEW.height}`} focusable="false">
            <defs>
              <filter id="stop-sign-ink" x="-5%" y="-30%" width="110%" height="160%"><feGaussianBlur stdDeviation=".35" /></filter>
              <filter id="stop-sign-tag-shadow" x="-10%" y="-30%" width="120%" height="170%"><feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="#000" floodOpacity=".55" /></filter>
            </defs>
            {/* Highlighter over the rider's own bus, like a marker on the printed sign. */}
            {lines.map((line, row) => line.yours && <polygon key={`mark-${row}`} className="stop-sign-mark" points={signRowBand(row).map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')} />)}
            {lines.map((line, row) => <SignText key={row} at={signRowPlacement(row)} className={line.yours ? 'stop-sign-row stop-sign-row-yours' : 'stop-sign-row'}>{line.text}</SignText>)}
            {yourRow >= 0 && <g className="stop-sign-callout" transform={`translate(${(signRowBand(yourRow)[1]![0] - 22).toFixed(1)} ${(signRowPlacement(yourRow).y - 11).toFixed(1)})`}>
              <rect x="0" y="-18" width="146" height="36" rx="18" filter="url(#stop-sign-tag-shadow)" />
              <SignText at={{ x: 12, y: 7, slope: 0, maxWidth: 124 }} className="stop-sign-callout-text" ink={false}>{`◀ ${s.yourBus}`}</SignText>
            </g>}
            <SignText at={SIGN_NUMBER} className="stop-sign-number">{from.code || '—'}</SignText>
          </svg>
        </div>}
        {/* Plain drawn sign when the photo is unavailable or the device forces its own colors. */}
        <div className="stop-sign-face" data-fallback={photo ? 'forced-colors' : 'always'} aria-hidden="true">
          <span>Bus Stop</span>
          <strong className="stop-sign-face-number">{from.code || '—'}</strong>
          <div className="stop-sign-route-tags">{lines.filter(line => line.route).map(line => <strong key={line.text} className={line.yours ? 'stop-sign-tag-yours' : undefined}>{line.route}</strong>)}</div>
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
