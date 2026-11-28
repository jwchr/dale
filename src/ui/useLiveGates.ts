import { useEffect, useState } from 'react';
import type { Dataset } from '../domain/types';
import { currentGatePostings, loadLiveGates, type LiveGateReceipt } from '../data/liveGates';

/** One corridor snapshot while the current screen actually has PABT departures. */
export function useLiveGates(ds: Dataset, api: string | undefined, demand: boolean) {
  const enabled = !!api && demand && !ds.meta.demo && ds.meta.realtime?.provider === 'njt-bus-g2';
  const [snapshot, setSnapshot] = useState<{ ds: Dataset; receipt: LiveGateReceipt }>();
  const [, tick] = useState(0);
  useEffect(() => {
    setSnapshot(undefined);
    if (!enabled || !api) return;
    let stopped = false, epoch = 0, ctl: AbortController | undefined;
    let next: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState !== 'hidden';
    async function poll() {
      if (stopped || !visible()) return;
      const generation = ++epoch;
      ctl?.abort(); const controller = new AbortController(); ctl = controller;
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const receipt = await loadLiveGates(api!, ds, controller.signal);
        if (!stopped && visible() && generation === epoch) setSnapshot({ ds, receipt });
      } catch { /* Original receipt age keeps advancing; errors never renew it. */ }
      finally { clearTimeout(timeout); if (!stopped && visible() && generation === epoch) next = setTimeout(() => void poll(), 30_000); }
    }
    const suspend = () => { epoch++; clearTimeout(next); ctl?.abort(); setSnapshot(undefined); };
    const resume = () => { suspend(); if (visible()) void poll(); };
    // Visibility history is useful for initial-background analytics, but this flow deliberately
    // starts with no postings and always fetches before showing evidence, including on Safari.
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pagehide', suspend); window.addEventListener('pageshow', resume);
    const timer = setInterval(() => { if (visible()) tick(n => n + 1); }, 1000);
    void poll();
    return () => { stopped = true; epoch++; clearInterval(timer); clearTimeout(next); ctl?.abort(); document.removeEventListener('visibilitychange', resume); window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume); };
  }, [enabled, api, ds]);
  useEffect(() => {
    if (!snapshot) return;
    const remaining = snapshot.receipt.postings.map(p => 120_000 - p.ageMs - (performance.now() - snapshot.receipt.arrivedAt)).filter(ms => ms > 0);
    if (!remaining.length) return;
    const timeout = setTimeout(() => tick(n => n + 1), Math.min(...remaining));
    return () => clearTimeout(timeout);
  });
  return enabled && snapshot?.ds === ds && document.visibilityState !== 'hidden' ? currentGatePostings(snapshot.receipt, performance.now()) : [];
}
