import type { Ref } from 'react';
import type { Strings } from './i18n';

/** Original vehicle silhouettes, not agency logos. Native buttons retain Enter/Space support. */
export function TravelModeSelector({ mode, onChange, t, trainRef }: {
  mode: 'bus' | 'train'; onChange: (mode: 'bus' | 'train') => void; t: Strings; trainRef?: Ref<HTMLButtonElement>;
}) {
  return <nav className="travel-mode" aria-label={t.journey.compare}>
    <button type="button" aria-pressed={mode === 'bus'} onClick={() => onChange('bus')}>
      <svg viewBox="0 0 48 30" aria-hidden="true" focusable="false"><path d="M4 5h32q6 0 7 7l1 10H3V8q0-3 1-3Z" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M7 8h27v8H7Zm30 1 3 1 1 6h-4Z" fill="currentColor" /><path d="M5 19h36" stroke="currentColor" strokeWidth="2" />
        <circle cx="12" cy="23" r="4" fill="currentColor" /><circle cx="36" cy="23" r="4" fill="currentColor" /></svg>
      <span>{t.journey.busMode}</span>
    </button>
    <button type="button" ref={trainRef} aria-pressed={mode === 'train'} onClick={() => onChange('train')}>
      <svg viewBox="0 0 48 30" aria-hidden="true" focusable="false"><path d="M12 4q12-5 24 0l2 18H10Z" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M15 6h8v8h-8Zm10 0h8v8h-8Z" fill="currentColor" /><circle cx="16" cy="18" r="2" fill="currentColor" /><circle cx="32" cy="18" r="2" fill="currentColor" />
        <path d="m16 23-4 5m20-5 4 5M14 26h20" stroke="currentColor" strokeWidth="2" /></svg>
      <span>{t.journey.trainMode}</span>
    </button>
  </nav>;
}
