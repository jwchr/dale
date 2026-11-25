// Home dashboard pieces and the bottom tab bar (#101 part 2). Layout: docs/design/mockups/04-dashboard.jpg.
// Original artwork only, drawn as inline SVG: no NJ Transit or Port Authority marks. The New Jersey outline
// is hand-drawn from the state's real border points (simplified); the route map is schematic, not to scale.
import { useLayoutEffect, useRef, type ReactNode, type Ref } from 'react';
import type { Strings } from './i18n';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
function Icon({ children, className, filled }: { children: ReactNode; className?: string; filled?: boolean }) {
  return <svg className={className ? `dash-icon ${className}` : 'dash-icon'} viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...(filled ? {} : stroke)}>{children}</svg>;
}

/** A setback skyscraper with a spire, in the spirit of the Empire State Building. */
export const BuildingIcon = () => <Icon className="icon-building">
  <path d="M12 1.2v3.3M10.6 4.5h2.8v2.6h-2.8zM9.1 7.1h5.8v3H9.1zM7 10.1h10V22H7zM4.5 22h15M9.6 13v6.2M12 13v6.2M14.4 13v6.2" />
</Icon>;
/** New Jersey, drawn from the state's border points (simplified). */
export const NewJerseyIcon = () => <Icon className="icon-nj" filled>
  <path fill="currentColor" d="M12.22 1 14.54 2.42 17.78 4.26 17.6 4.96 17.32 5.78 16.97 6.41 16.83 6.96 16.56 7.32 16.07 7.45 15.65 7.59 15.58 8.22 15.24 8.77 15.52 9.04 16.35 9.22 16.9 9.04 17.08 9.4 17.18 10.31 17.11 11.22 16.83 12.39 16.62 13.3 16.42 14.66 16.28 15.66 15.65 16.75 14.82 18.01 14.13 19.01 13.16 19.92 12.4 21.01 11.56 22.09 10.8 23 10.32 22.82 10.59 21.73 10.94 20.82 9.76 20.46 8.72 20.1 7.61 19.28 6.64 18.29 6.22 17.11 6.43 16.11 6.99 15.2 8.03 14.66 9.14 14.3 9.76 13.39 10.59 12.67 11.49 12.12 11.98 11.67 11.49 11.03 10.66 10.31 10.18 9.67 9.69 9.49 9.41 8.59 8.79 8.04 8.79 7.05 9.28 6.23 9.62 5.51 9.21 4.51 9.9 3.87 10.66 3.15 11.22 2.42 11.77 1.7Z" />
</Icon>;
export const ArrowUpRight = () => <Icon className="icon-go"><path d="M7 17 17 7M9 7h8v8" /></Icon>;
export const ArrowRight = () => <Icon className="icon-next"><path d="M4.5 12h15M13.5 6l6 6-6 6" /></Icon>;
const ChevronDown = () => <Icon className="icon-caret"><path d="m6.5 9.5 5.5 5.5 5.5-5.5" /></Icon>;
const ChevronRight = () => <Icon className="icon-chevron"><path d="m9 5.5 6.5 6.5L9 18.5" /></Icon>;
export const Pin = () => <Icon className="icon-pin"><path d="M12 21.2s-6.4-5.8-6.4-11a6.4 6.4 0 0 1 12.8 0c0 5.2-6.4 11-6.4 11z" /><circle cx="12" cy="10.2" r="2.3" /></Icon>;
const Locate = () => <Icon className="icon-locate"><circle cx="12" cy="12" r="6.6" /><circle cx="12" cy="12" r="2.4" fill="currentColor" /><path d="M12 1.8v3.4M12 18.8v3.4M1.8 12h3.4M18.8 12h3.4" /></Icon>;
export const FilterIcon = () => <Icon className="icon-filter"><path d="M3.5 7h9M16.5 7h4M3.5 17h4M11.5 17h9" /><circle cx="14.5" cy="7" r="2" /><circle cx="9.5" cy="17" r="2" /></Icon>;
export const BusIcon = () => <Icon className="icon-bus"><path d="M6.5 3h11A2.5 2.5 0 0 1 20 5.5V17a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5.5A2.5 2.5 0 0 1 6.5 3zM4 11.5h16M4 7h16M7.5 18v2.5M16.5 18v2.5M7.8 14.8h.01M16.2 14.8h.01" /></Icon>;
/** A house: "Get me home". */
export const RescueIcon = () => <Icon className="icon-rescue"><path d="M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5M10 20v-5.5h4V20" /></Icon>;
const Signpost = () => <Icon className="icon-signpost"><path d="M12 2.5v19M8.5 21.5h7M4.5 6.5h12.2l2.8 2.6-2.8 2.6H4.5zM19.5 13.5H7.3l-2.8 2.4 2.8 2.4h12.2z" /></Icon>;

/** "Household Beta": the stage of this household tool; the build stamp stays in its title and in the footer. */
export function BetaPill({ t, title }: { t: Strings; title?: string }) {
  return <span className="beta-pill" title={title}><span className="beta-dot" aria-hidden="true" />{t.dash.beta}</span>;
}

export interface DirectionChoice { key: string; label: string; icon: 'ny' | 'nj'; pressed: boolean; onPress: () => void }
/** The two big direction buttons, then the stop the rider leaves from and the near-me shortcut. */
export function DirectionPanel({ t, choices, fromLabel, onFrom, onLocation }: {
  t: Strings; choices: DirectionChoice[]; fromLabel?: string; onFrom?: () => void; onLocation?: () => void;
}) {
  return <div className="dash-panel dash-direction">
    <div className="dash-direction-buttons" role="group" aria-label={t.dash.direction}>
      {choices.map(c => <button key={c.key} type="button" className="dash-dir" data-dir={c.icon} aria-pressed={c.pressed} onClick={c.pressed ? undefined : c.onPress}>
        {c.icon === 'ny' ? <BuildingIcon /> : <NewJerseyIcon />}<span className="dash-dir-label">{c.label}</span><ArrowUpRight />
      </button>)}
    </div>
    {fromLabel !== undefined && <div className="dash-from-row">
      {onFrom ? <button type="button" className="dash-from" onClick={onFrom}><Pin /><span className="dash-from-text">{t.dash.from} {fromLabel}<span className="sr-only">, {t.dash.changeFrom}</span></span><ChevronDown /></button>
        : <p className="dash-from"><Pin /><span className="dash-from-text">{t.dash.from} {fromLabel}</span></p>}
      {onLocation && <button type="button" className="dash-locate" onClick={onLocation}><Locate /><span>{t.dash.useLocation}</span></button>}
    </div>}
  </div>;
}

/** LIVE only when a shown row has a fresh NJ Transit prediction; otherwise the same pill says Scheduled.
 * A polite status region, so a switch between the two is announced without reading out the whole board. */
export function StatusPill({ t, live }: { t: Strings; live: boolean }) {
  return <p className="status-pill" data-live={live} role="status">
    <span className="status-dot" aria-hidden="true" /><span className="status-word">{live ? t.dash.live : t.dash.scheduled}</span>
    <span className="sr-only">. {live ? t.dash.liveNote : t.dash.scheduledNote}</span>
  </p>;
}

/** The light tile beside each board: the big number and "min" under it (or "Now", "Cancelled"...). */
export function MinutesTile({ t, minutes, text }: { t: Strings; minutes?: number; text: string }) {
  return minutes !== undefined && minutes > 0
    ? <span className="dep-tile" aria-hidden="true"><span className="dep-tile-num">{minutes}</span><span className="dep-tile-unit">{t.dash.minShort}</span></span>
    : <span className="dep-tile" aria-hidden="true"><span className="dep-tile-text">{text}</span></span>;
}

/** A stop drawn on the home map; `index` is its place in the bus's stop list, used to place the moving dots. */
export interface MapPoint { name: string; index: number; board?: boolean }
type Pt = readonly [number, number];
const cubic = (a: Pt, b: Pt, c: Pt, d: Pt): Pt[] => Array.from({ length: 8 }, (_, i) => {
  const s = (i + 1) / 8, r = 1 - s;
  return [r * r * r * a[0] + 3 * r * r * s * b[0] + 3 * r * s * s * c[0] + s * s * s * d[0], r * r * r * a[1] + 3 * r * r * s * b[1] + 3 * r * s * s * c[1] + s * s * s * d[1]] as const;
});
const along = (line: Pt[]) => line.reduce<number[]>((acc, p, i) => [...acc, i ? acc[i - 1]! + Math.hypot(p[0] - line[i - 1]![0], p[1] - line[i - 1]![1]) : 0], []);
/** The point `len` along a polyline. */
function pointAt(line: Pt[], lens: number[], len: number): Pt {
  const i = Math.max(1, lens.findIndex(l => l >= len));
  const a = line[i - 1]!, b = line[i] ?? a, f = lens[i] === lens[i - 1] ? 0 : (len - lens[i - 1]!) / (lens[i]! - lens[i - 1]!);
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
}
/** Where a trip position (fractional stop index) falls on the drawn line, between the drawn stops; undefined outside them. */
function placeOn(anchors: { index: number; len: number }[], line: Pt[], lens: number[], position: number): Pt | undefined {
  const sorted = [...anchors].sort((a, b) => a.index - b.index);
  if (sorted.length < 2 || position < sorted[0]!.index - 0.01 || position > sorted.at(-1)!.index + 0.01) return undefined;
  const j = Math.max(1, sorted.findIndex(a => a.index >= position));
  const a = sorted[j - 1]!, b = sorted[j] ?? a, f = b.index === a.index ? 0 : Math.min(1, Math.max(0, (position - a.index) / (b.index - a.index)));
  return pointAt(line, lens, a.len + f * (b.len - a.len));
}

/**
 * Schematic map of the rider's trip on this route: New Jersey stops on the left, the Hudson, and Port Authority
 * on the right when the trip crosses into Manhattan. Only real stops from the schedule are drawn. The next bus
 * (official GPS, or the timetable's estimate, labeled beside the map) and the rider's own phone (opt-in) move
 * along the line between them.
 */
export function ConnectionMap({ t, nj, ny, eastbound, county, bus, you }: { t: Strings; nj: MapPoint[]; ny?: MapPoint; eastbound: boolean; county?: string; bus?: { position: number; live: boolean }; you?: number }) {
  const d = t.dash;
  // New Jersey points sit on the upper line; with one point it is centered on it.
  const shown = nj.slice(ny ? -2 : -3);
  const xs = ny ? (shown.length >= 2 ? [74, 252] : [190]) : shown.length >= 3 ? [74, 316, 560] : shown.length === 2 ? [90, 560] : [190];
  const points = shown.map((p, i) => ({ ...p, x: xs[i]!, y: 118 }));
  const end = ny ? { ...ny, x: 602, y: 182 } : undefined;
  const lastNj = points[points.length - 1]!;
  const x0 = points[0]!.x;
  const line = end
    ? `M${x0} 118H332C356 118 370 131 370 152V160C370 173 378 182 392 182H${end.x}`
    : `M${x0} 118H${Math.max(lastNj.x, 560)}`;
  const poly: Pt[] = end
    ? [[x0, 118], [332, 118], ...cubic([332, 118], [356, 118], [370, 131], [370, 152]), [370, 160], ...cubic([370, 160], [370, 173], [378, 182], [392, 182]), [end.x, 182]]
    : [[x0, 118], [Math.max(lastNj.x, 560), 118]];
  const lens = along(poly);
  const anchors = [...points.map(p => ({ index: p.index, len: p.x - x0 })), ...(end ? [{ index: end.index, len: lens.at(-1)! }] : [])];
  const busAt = bus && placeOn(anchors, poly, lens, bus.position);
  const youAt = you !== undefined ? placeOn(anchors, poly, lens, you) : undefined;
  const board = [...points, ...(end ? [end] : [])].find(p => p.board);
  // The gold marker sits on the line just past the boarding stop, pointing the way the bus goes.
  const marker = board && (board === end ? { x: end.x - 54, y: 182 } : { x: board.x + 50, y: 118 });
  const label = d.mapLabel([...points, ...(end ? [end] : [])].map(p => p.board ? `${p.name} (${d.yourStop})` : p.name).join(', '));
  return <svg className="connection-map" viewBox="0 0 700 236" role="img" aria-label={label} focusable="false">
    <defs>
      <linearGradient id="cm-land" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#e6eedc" /><stop offset="1" stopColor="#d9e6cf" /></linearGradient>
      <linearGradient id="cm-river" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#a3c9e8" /><stop offset="1" stopColor="#b3d3ec" /></linearGradient>
    </defs>
    <rect width="700" height="236" rx="20" fill="url(#cm-land)" />
    <path d="M0 40C80 18 170 60 250 44S390 8 440 30V0H0Z" fill="#eef3e6" opacity=".8" />
    <path d="M180 236C230 200 300 214 360 196S430 160 440 236Z" fill="#e8efdf" opacity=".9" />
    {end && <path d="M520 0H700V236H470C478 190 512 150 530 104S522 30 520 0Z" fill="#e9efe2" />}
    {/* Background streets, decorative. */}
    <path d="M70 90H166C182 90 192 100 192 116V150C192 160 200 166 212 166H612" fill="none" stroke="#bdd5e6" strokeWidth="5" strokeLinecap="round" />
    <path d="M232 144H624" fill="none" stroke="#cfe0c3" strokeWidth="6" strokeLinecap="round" />
    {end && <>
      <path d="M452 0C470 40 478 72 462 112S428 176 430 236H492C490 182 516 144 530 102S520 34 516 0Z" fill="url(#cm-river)" />
      <text className="cm-river" x="0" y="0" transform="translate(489 120) rotate(-76)">{d.hudson.toUpperCase()}</text>
      <text className="cm-area" x="548" y="66">{d.manhattan.toUpperCase()}</text>
    </>}
    <text className="cm-area" x="44" y="38">{(county ? d.county(county) : d.newJersey).toUpperCase()}</text>
    <path d={line} fill="none" stroke="#7a5200" strokeOpacity=".25" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" transform="translate(0 1.5)" />
    <path d={line} fill="none" stroke="#e9a614" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
    {[...points, ...(end ? [end] : [])].map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="8.5" fill="#fffaf0" stroke="#e9a614" strokeWidth="4" />)}
    {marker && <g transform={`translate(${marker.x - 15} ${marker.y - 15})`}>
      <rect width="30" height="30" rx="6" fill="#f2b31f" stroke="#c98a07" strokeWidth="1.5" />
      <path d={eastbound ? 'M9 21 21 9M12 9h9v9' : 'M21 21 9 9M18 9H9v9'} fill="none" stroke="#1d2a22" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </g>}
    {points.map((p, i) => <text key={i} className="cm-stop" x={i === 0 && points.length > 1 ? 44 : p.x} y={i === 0 && points.length > 1 ? 152 : 90} textAnchor={i === 0 && points.length > 1 ? 'start' : 'middle'}>{p.name}</text>)}
    {end && <text className="cm-stop" x={end.x - 76} y="218">{end.name}</text>}
    {youAt && <g className="cm-you" data-testid="map-you" transform={`translate(${youAt[0].toFixed(1)} ${youAt[1].toFixed(1)})`}>
      <circle r="17" fill="#1a73e8" opacity=".18" /><circle r="8.5" fill="#1a73e8" stroke="#fff" strokeWidth="3.5" />
    </g>}
    {busAt && <g className="cm-bus" data-testid="map-bus" data-live={bus!.live} transform={`translate(${busAt[0].toFixed(1)} ${busAt[1].toFixed(1)})`}>
      {bus!.live ? <circle className="cm-bus-pulse" r="20" fill="#1f5a3a" opacity=".22" /> : <circle r="19" fill="none" stroke="#173d2b" strokeWidth="2" strokeDasharray="4 4" />}
      <circle r="14" fill="#173d2b" stroke="#fff" strokeWidth="2.5" />
      <path d="M-5.5-6.5h11a1.6 1.6 0 0 1 1.6 1.6V5h-14.2V-4.9a1.6 1.6 0 0 1 1.6-1.6zM-7.1-.6h14.2M-4.2 5v2M4.2 5v2" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </g>}
  </svg>;
}

/** The cream-gold banner that opens the first-ride guide. */
/** One tappable row that opens a deeper screen: a title, a short plain line under it and a chevron (simpler layout, Nov 24). */
export function MenuRow({ title, detail, onOpen, ref }: { title: string; detail?: ReactNode; onOpen: () => void; ref?: Ref<HTMLButtonElement> }) {
  return <button ref={ref} type="button" className="menu-row" onClick={onOpen}>
    <span className="menu-row-text"><strong>{title}</strong>{detail && <span>{detail}</span>}</span><ChevronRight />
  </button>;
}
export function GuidanceBanner({ t, onOpen }: { t: Strings; onOpen: () => void }) {
  return <button type="button" className="guidance-banner" onClick={onOpen}>
    <Signpost /><span className="guidance-text"><strong>{t.dash.guidanceTitle}</strong><span>{t.dash.guidanceBody}</span></span><ChevronRight />
  </button>;
}

export type Tab = 'dashboard' | 'schedules' | 'routes' | 'gates' | 'household';
const TAB_ICONS: Record<Tab, (active: boolean) => ReactNode> = {
  dashboard: active => <Icon className="icon-home"><path d="M4 10.4 12 3.8l8 6.6V20a1 1 0 0 1-1 1h-4.6v-6.2H9.6V21H5a1 1 0 0 1-1-1z" fill={active ? 'currentColor' : 'none'} /></Icon>,
  schedules: () => <Icon><circle cx="12" cy="12" r="8.8" /><path d="M12 7v5.2l3.4 2.1" /></Icon>,
  routes: () => <Icon><circle cx="6" cy="6" r="2.6" /><circle cx="18" cy="18" r="2.6" /><path d="M8.6 6h7.9a3 3 0 0 1 0 6h-9a3 3 0 0 0 0 6h7.9" /></Icon>,
  gates: () => <Icon><path d="M3 6.2h18v3.6a2.2 2.2 0 0 0 0 4.4v3.6H3v-3.6a2.2 2.2 0 0 0 0-4.4z" /><path d="m9.4 9.6-2.4 2.4 2.4 2.4M14.6 9.6l2.4 2.4-2.4 2.4" /></Icon>,
  // Settings (simpler layout, Nov 24): a gear, so the tab reads as settings rather than people.
  household: () => <Icon><circle cx="12" cy="12" r="3.1" /><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8" /><circle cx="12" cy="12" r="6.6" /></Icon>,
};
/** One navigation for every style (owner, #101): fixed at the bottom, above the phone's home bar. */
export function TabBar({ t, active, onTab }: { t: Strings; active: Tab | undefined; onTab: (tab: Tab) => void }) {
  const bar = useRef<HTMLElement>(null);
  // Reserve the bar's real height, so page content and sticky buttons never hide behind it.
  useLayoutEffect(() => {
    const node = bar.current;
    if (!node) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty('--tab-bar-height', `${Math.ceil(node.getBoundingClientRect().height)}px`);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    if (observer) observer.observe(node); else window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); root.style.removeProperty('--tab-bar-height'); };
  }, []);
  const tabs: Tab[] = ['dashboard', 'schedules', 'routes', 'gates', 'household'];
  return <nav ref={bar} className="tab-bar" aria-label={t.dash.tabs.label}>
    <ul>{tabs.map(tab => <li key={tab}>
      <button type="button" className="tab" data-tab={tab} aria-current={active === tab ? 'page' : undefined} onClick={() => onTab(tab)}>
        {TAB_ICONS[tab](active === tab)}<span className="tab-label">{t.dash.tabs[tab]}</span>
      </button>
    </li>)}</ul>
  </nav>;
}
