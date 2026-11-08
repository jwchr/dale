import { useEffect, useState } from 'react';
// Background scenes for Dale's styles (owner request 2026-11-04, D46). Original artwork only: no
// official shields, logos or sign designs of the NJ Turnpike Authority, the Garden State Parkway,
// the MTA, NJ Transit or the Port Authority (the NYC style avoids the MTA's sign system on purpose). Decorative, so hidden from assistive technology.
export type Skin = 'turnpike' | 'parkway' | 'nyc' | 'clean';
export const SKINS: readonly Skin[] = ['turnpike', 'parkway', 'nyc', 'clean'];
// Shared by loading, guide and main views; remounting one does not choose another photo.
const OPENING_PHOTO = Math.random() < .5 ? 'paterson-great-falls' : 'new-jersey-september-sunset';

export function SkinBackdrop({ skin }: { skin: Skin }) {
  // One choice per app opening, held across route/style changes. Only that asset is requested.
  const photo = OPENING_PHOTO;
  const [ready, setReady] = useState(false);
  const url = `${import.meta.env.BASE_URL}backgrounds/${photo}.webp`;
  useEffect(() => {
    if (matchMedia('(prefers-reduced-transparency: reduce), (forced-colors: active)').matches) return;
    let active = true;
    const image = new Image(); image.decoding = 'async'; image.fetchPriority = 'low';
    image.onload = () => { if (active) setReady(true); }; image.src = url;
    return () => { active = false; image.onload = null; };
  }, [url]);
  return (
    <div className="skin-backdrop" aria-hidden="true" data-skin={skin}>
      {ready && <div className="photo-backdrop" data-photo={photo} style={{ backgroundImage: `url("${url}")` }} />}
      {!ready && skin !== 'clean' && <svg viewBox="0 0 400 800" preserveAspectRatio="xMidYMax slice" width="100%" height="100%" focusable="false">
        {skin === 'turnpike' && <Turnpike />}
        {skin === 'parkway' && <Parkway />}
        {skin === 'nyc' && <Skyline />}
      </svg>}
    </div>
  );
}

/** Dusk over a divided highway: glowing horizon, an overhead sign gantry, lane lines running to it. */
function Turnpike() {
  return <>
    <defs>
      <linearGradient id="tp-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#0b1626" />
        <stop offset="0.45" stopColor="#1d3557" />
        <stop offset="0.66" stopColor="#7a3a24" />
        <stop offset="0.7" stopColor="#8a4a2a" />
      </linearGradient>
      <linearGradient id="tp-road" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#2a2f36" />
        <stop offset="1" stopColor="#14171b" />
      </linearGradient>
    </defs>
    <rect width="400" height="800" fill="url(#tp-sky)" />
    {/* distant tree line and city glow */}
    <path d="M0 556 Q40 540 80 552 T160 548 T240 552 T320 544 T400 552 V570 H0Z" fill="#0f1c22" />
    {[30, 62, 300, 318, 342].map((x, i) => <rect key={x} x={x} y={530 - (i % 3) * 8} width="10" height={30 + (i % 3) * 8} fill="#101c26" />)}
    {/* dark verges either side, then the road */}
    <rect x="0" y="558" width="400" height="242" fill="#111a16" />
    <path d="M178 560 L222 560 L420 800 L-20 800 Z" fill="url(#tp-road)" />
    <path d="M178 560 L-20 800" stroke="#f2c94c" strokeWidth="5" />
    <path d="M222 560 L420 800" stroke="#e9eef3" strokeWidth="5" />
    {[0, 1, 2, 3, 4, 5].map((i) => {
      const t0 = i / 6, t1 = t0 + 0.07;
      const y0 = 560 + 240 * t0 ** 1.6, y1 = 560 + 240 * t1 ** 1.6;
      return <g key={i}>
        <path d={`M${200 - 40 * t0 ** 1.6} ${y0} L${200 - 40 * t1 ** 1.6} ${y1}`} stroke="#e9eef3" strokeWidth={2 + 6 * t0} strokeLinecap="round" />
        <path d={`M${200 + 40 * t0 ** 1.6} ${y0} L${200 + 40 * t1 ** 1.6} ${y1}`} stroke="#e9eef3" strokeWidth={2 + 6 * t0} strokeLinecap="round" />
      </g>;
    })}
    {/* overhead sign gantry */}
    <g opacity="0.95">
      <rect x="96" y="500" width="6" height="64" fill="#3b4652" />
      <rect x="298" y="500" width="6" height="64" fill="#3b4652" />
      <rect x="90" y="498" width="220" height="6" fill="#4a5662" />
      <rect x="126" y="474" width="66" height="30" rx="3" fill="#0b6b3f" stroke="#e9eef3" strokeWidth="1.5" />
      <rect x="208" y="474" width="66" height="30" rx="3" fill="#0b6b3f" stroke="#e9eef3" strokeWidth="1.5" />
      <rect x="136" y="483" width="40" height="3" fill="#e9eef3" /><rect x="136" y="490" width="28" height="3" fill="#e9eef3" />
      <rect x="218" y="483" width="44" height="3" fill="#e9eef3" /><rect x="218" y="490" width="30" height="3" fill="#e9eef3" />
    </g>
    {/* a few stars */}
    {[[40, 60], [120, 120], [260, 40], [340, 150], [210, 210], [70, 260]].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" fill="#e9eef3" opacity="0.7" />)}
  </>;
}

/** Evening on a wooded parkway: amber sky behind layered pines, with a road curving away. */
function Parkway() {
  const pines = (y: number, h: number, step: number, color: string, seed: number) => {
    let d = `M-10 800 L-10 ${y}`;
    for (let x = -10, i = 0; x <= 410; x += step, i++) {
      const top = y - h * (0.6 + 0.4 * Math.abs(Math.sin((i + seed) * 1.7)));
      d += ` L${x + step * 0.5} ${top} L${x + step} ${y}`;
    }
    return <path d={`${d} L410 800 Z`} fill={color} />;
  };
  return <>
    <defs>
      <linearGradient id="pk-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#0c2219" />
        <stop offset="0.42" stopColor="#1f4a36" />
        <stop offset="0.62" stopColor="#5e4a1c" />
        <stop offset="0.7" stopColor="#6a4c1c" />
      </linearGradient>
    </defs>
    <rect width="400" height="800" fill="url(#pk-sky)" />
    <circle cx="300" cy="500" r="34" fill="#f8e3a0" opacity="0.3" />
    {pines(560, 70, 26, '#23412f', 1)}
    {pines(610, 90, 34, '#173123', 4)}
    <path d="M150 800 C190 720 260 690 228 640 C214 620 214 610 222 600 L232 600 C226 612 230 624 246 640 C290 690 250 740 260 800 Z" fill="#2b2f2a" />
    <path d="M205 800 C226 740 266 700 238 650" stroke="#f2c94c" strokeWidth="2.5" fill="none" strokeDasharray="10 9" />
    {pines(690, 110, 44, '#0d1f16', 7)}
  </>;
}

/** Night skyline over the river: generic towers with lit windows, no real building drawn. */
function Skyline() {
  const towers: [number, number, number][] = [[0, 520, 34], [36, 470, 28], [66, 540, 40], [108, 430, 30], [140, 500, 36], [178, 380, 26],
    [206, 460, 40], [248, 410, 30], [280, 520, 34], [316, 450, 28], [346, 500, 54]];
  return <>
    <defs>
      <linearGradient id="ny-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#05070c" />
        <stop offset="0.6" stopColor="#141b33" />
        <stop offset="0.78" stopColor="#3a2b4d" />
      </linearGradient>
      <pattern id="ny-win" width="8" height="12" patternUnits="userSpaceOnUse">
        <rect x="2" y="3" width="3" height="5" fill="#ffd36e" opacity="0.55" />
      </pattern>
    </defs>
    <rect width="400" height="800" fill="url(#ny-sky)" />
    {towers.map(([x, top, w]) => <g key={x}>
      <rect x={x} y={top} width={w} height={680 - top} fill="#0b0f1a" />
      <rect x={x + 2} y={top + 8} width={w - 4} height={660 - top} fill="url(#ny-win)" />
    </g>)}
    <path d="M190 380 L191 340 L192 380 Z" fill="#0b0f1a" />
    <rect x="0" y="680" width="400" height="120" fill="#070a12" />
    {[700, 716, 734, 756].map((y, i) => <rect key={y} x={40 + i * 30} y={y} width={300 - i * 60} height="2" fill="#ffd36e" opacity={0.25 - i * 0.05} />)}
  </>;
}
