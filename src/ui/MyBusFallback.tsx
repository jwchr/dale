import { useEffect, useId, useRef, useState } from 'react';
import { MYBUS_WEB, myBusPhone, myBusSms, myBusStop } from '../domain/myBus';
import type { Dataset, Departure } from '../domain/types';
import type { Lang } from './i18n';
import { myBusStrings } from './myBusStrings';

function CopyStopCode({ code, lang }: { code: string; lang: Lang }) {
  const t = myBusStrings[lang], id = useId(), target = useRef<HTMLElement>(null);
  const [message, setMessage] = useState('');
  const previous = useRef(''), alive = useRef(true), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  async function copy() {
    let next: string;
    try { await navigator.clipboard.writeText(code); next = t.copied; }
    catch { next = t.failed; }
    if (!alive.current) return;
    clearTimeout(timer.current);
    if (next === previous.current) next += '\u00a0';
    previous.current = next;
    setMessage(next);
    timer.current = setTimeout(() => setMessage(''), 6000);
  }
  useEffect(() => {
    alive.current = true;
    const node = target.current;
    const command = (event: Event) => { if ((event as Event & { command: string }).command === '--copy') void copy(); };
    if ('CommandEvent' in window) node?.addEventListener('command', command, true);
    return () => { alive.current = false; clearTimeout(timer.current); node?.removeEventListener('command', command, true); };
  }, [code, lang]);
  return <>
    <p>{t.code}: <strong><span ref={target} id={id} className="mybus-code">{code}</span></strong></p>
    <button type="button" {...({ command: '--copy', commandfor: id } as Record<string, string>)}
      onClick={() => { if (!('CommandEvent' in window)) void copy(); }}>{t.copy}</button>
    <p className="small mybus-feedback" role="status">{message}</p>
  </>;
}

/** A rider-opened handoff only: no lookup requests, text sending, or changes to the bus lock. */
export function MyBusFallback({ ds, dep, lang }: { ds?: Dataset; dep?: Departure; lang: Lang }) {
  const t = myBusStrings[lang];
  const stop = ds && dep ? myBusStop(ds, dep) : undefined;
  const phone = typeof navigator === 'undefined' ? 'other' : myBusPhone(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  const sms = stop && myBusSms(stop.code, phone);
  return <details className="mybus-fallback" data-testid="mybus-fallback">
    <summary>{t.title}</summary>
    <p className="small">{t.note}</p>
    {stop ? <>
      <p><strong>{t.boarding}: {stop.name}</strong><br />{t.direction}: {stop.headsign}</p>
      <p className="small">{t.confirm}</p>
      <CopyStopCode key={`${stop.code}:${lang}`} code={stop.code} lang={lang} />
    </> : <p>{t.missing}</p>}
    <div className="choice-list mybus-actions">
      <a href={MYBUS_WEB} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t.web}</a>
      {sms ? <a href={sms}>{phone === 'apple' ? t.messages : t.draft}</a>
        : !stop ? <button type="button" disabled>{t.disabled}</button> : null}
    </div>
    {stop && <>
      <p className="small">{sms ? phone === 'apple' ? t.paste : t.send : t.desktop}</p>
      <p className="small">{t.rates}</p>
    </>}
  </details>;
}
