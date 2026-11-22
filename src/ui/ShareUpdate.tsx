import { routeLabel } from '../domain/routeDisplay';
// One-tap trip update (issue #61): the rider sends it through their own app (Web Share) or copies it.
// Dale itself sends nothing and includes no position.
import { useEffect, useRef, useState } from 'react';
import type { BusSession } from '../domain/busLock';
import { tripUpdate } from '../domain/tripUpdate';
import { formatTime12 } from '../domain/time';
import type { Dataset } from '../domain/types';
import type { Lang, Strings } from './i18n';

/** The place without the dataset's "(to …)" direction hint, which means nothing to the person reading. */
const place = (name: string) => name.replace(/\s+\(to [^)]+\)$/i, '');

export function ShareUpdate({ ds, session, alightIndex, now, t, lang }: { ds: Dataset; session: BusSession; alightIndex: number; now: number; t: Strings; lang: Lang }) {
  const s = t.share;
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const u = tripUpdate(ds, session, alightIndex, now);
  const clock = (at: number, estimated: boolean) => `${estimated ? '~' : ''}${formatTime12(at, ds.meta.timezone, lang)}`;
  const stopName = (id: string) => place(ds.stops.find((x) => x.id === id)?.name ?? id);
  const to = u.update.kind === 'onboard' && u.update.to ? { stop: stopName(u.update.to.stopId), time: clock(u.update.to.at, u.update.to.estimated) } : undefined;
  const text = `${u.demo ? s.demo : ''}${s.text(u.update, routeLabel(u.route), clock(u.departs, u.estimated), stopName(u.stopId), to)}`;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function share() {
    try { await navigator.share({ text }); } catch (e) {
      // Closing the sheet is not a failure; anything else falls back to copying.
      if ((e as { name?: string } | undefined)?.name !== 'AbortError') await copy();
    }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(text); setStatus('copied'); } catch { setStatus('failed'); }
  }
  // Focus moves to the message when it opens and back to the opener when it closes.
  const opener = useRef<HTMLButtonElement>(null);
  const message = useRef<HTMLParagraphElement>(null);
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    if (open) message.current?.focus(); else opener.current?.focus();
  }, [open]);
  const toggle = (v: boolean) => { toggled.current = true; setStatus('idle'); setOpen(v); };
  if (!open) return <button ref={opener} className="ghost share-open" onClick={() => toggle(true)}>{s.open}</button>;
  return (
    <div className="share-update">
      <p className="share-text" data-testid="share-text" tabIndex={-1} ref={message}>{text}</p>
      <div className="lock-actions">
        {canShare && <button className="primary" onClick={() => void share()}>{s.share}</button>}
        <button className={canShare ? '' : 'primary'} onClick={() => void copy()}>{s.copy}</button>
        <button className="ghost" onClick={() => toggle(false)}>{s.close}</button>
      </div>
      <p className="small" role="status">{status === 'copied' ? s.copied : status === 'failed' ? s.copyFailed : ''}</p>
      <p className="muted small">{s.note}</p>
    </div>
  );
}
