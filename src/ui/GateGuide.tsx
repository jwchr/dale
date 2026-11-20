// PABT gate guide (#101 part 3), drawn to docs/design/mockups/02-pabt-gates.jpg: three numbered steps,
// the honest "no gate is inferred" line, and links to official terminal and ticket information.
// The gate icon never carries a number: Dale shows a gate only on a departure that has a sourced one.

import { ArrowRight } from './Dashboard';
import type { Strings } from './i18n';

const PABT_URL = 'https://www.panynj.gov/bus-terminals/en/port-authority.html';
const NJT_APP_URL = 'https://www.njtransit.com/app';

const Out = () => <svg className="gg-out" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3h8v8M13 3 3 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;

const icons = (gateSign: string) => [
  <svg viewBox="0 0 40 40" aria-hidden="true"><rect x="6" y="8" width="28" height="19" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2.2" /><path d="M11 14h18M11 19h18M11 23h10M20 27v5M14 33h12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>,
  <svg viewBox="0 0 40 40" aria-hidden="true"><path d="M7 16 22 7l3 4a3 3 0 0 0 4 2l4 6-15 9-3-4a3 3 0 0 0-4-2Z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" /><path d="m17 13 7 11" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="2 3" /></svg>,
  <svg viewBox="0 0 40 40" aria-hidden="true"><rect x="5" y="9" width="30" height="24" rx="3" fill="currentColor" /><path d="M11 5v4M29 5v4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /><text x="20" y="25" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif" textLength={gateSign.length > 4 ? 25 : 22} lengthAdjust="spacingAndGlyphs">{gateSign}</text></svg>,
];

export function GateGuide({ t, anyGate, onGuide }: { t: Strings; anyGate: boolean; onGuide: () => void }) {
  const g = t.dash.gateGuide;
  return <>
    <section className="card gg-card dash-panel" aria-labelledby="gg-title">
      <div className="gg-head">
        <h1 id="gg-title" className="dash-title">{g.title}</h1>
        <span className="gg-pill">{g.pill}</span>
      </div>
      <p className="gg-sub">{g.subtitle}</p>
      <ol className="gg-steps">
        {g.steps.map((s, i) => <li key={s.title}>
          <span className="gg-num" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
          <span className="gg-icon">{icons(g.gateSign)[i]}</span>
          <span className="gg-text"><strong>{s.title}</strong><span>{s.body}</span></span>
        </li>)}
      </ol>
      {!anyGate && <p className="gg-notice" role="note"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M10 9v5M10 6.2v.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>{g.unavailable}</p>}
      <a className="link gg-link" href={PABT_URL} target="_blank" rel="noreferrer">{g.official}<Out /></a>
    </section>
    <section className="card gg-card dash-panel" aria-labelledby="gg-walk">
      <p className="dash-eyebrow">{g.firstTime}</p>
      <h2 id="gg-walk" className="dash-title gg-walk-title">{t.dash.guidanceTitle}</h2>
      <p className="gg-sub">{g.walkBody}</p>
      <button type="button" className="gg-walk-button" onClick={onGuide}><span>{g.walk}</span><ArrowRight /></button>
      <a className="link gg-link" href={NJT_APP_URL} target="_blank" rel="noreferrer">{g.app}<Out /></a>
    </section>
  </>;
}
