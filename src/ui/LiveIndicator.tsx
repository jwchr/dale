/** Decorative reinforcement: the neighboring translated text always carries the actual status. */
export function LiveIndicator({ live }: { live: boolean }) {
  return <svg className="live-symbol" data-live={live} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    {live ? <><path d="M5 14a10 10 0 0 1 0-10M8.5 11a5.5 5.5 0 0 1 0-4M19 14a10 10 0 0 0 0-10M15.5 11a5.5 5.5 0 0 0 0-4M12 11v10M8 21h8" /><circle cx="12" cy="8" r="2" fill="currentColor" /></>
      : <><circle cx="12" cy="12" r="9" /><path d="m5.5 18.5 13-13" /></>}
  </svg>;
}
