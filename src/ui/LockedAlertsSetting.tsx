// "Alerts when my phone is locked" (#176 step C): off by default, separate from "Phone notification".
// Turning it on explains what Dale's server keeps, asks for the household code, then for notifications.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { normalizeHouseholdCode, validHouseholdCode } from '../domain/lockedAlerts';
import type { Strings } from './i18n';
import {
  clearLockedNote, retryLockedAlerts, setHouseholdCode, turnOffLockedAlerts, turnOnLockedAlerts, useLockedAlertsView, type LockedNote,
} from './lockedRideAlerts';

const RETRYABLE: LockedNote[] = ['unavailable', 'later', 'full', 'invalid', 'failed', 'storage'];

/** `row`: the Settings layout (simpler layout mock-up, Nov 24): one switch row, with the ride-screen note folded into the limits. */
export function LockedAlertsSetting({ t, row = false }: { t: Strings; row?: boolean }) {
  const s = t.lockedAlerts;
  const view = useLockedAlertsView();
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [checking, setChecking] = useState(false);
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLInputElement>(null);
  const needCode = view.enabled && !view.hasCode;
  const formOpen = (asking && !view.enabled) || needCode;
  useEffect(() => { if (asking) field.current?.focus(); }, [asking]);
  // Focus returns to the option once the form has closed and the option is enabled again.
  const refocus = useRef(false);
  useEffect(() => { if (refocus.current && !checking && !formOpen) { refocus.current = false; toggle.current?.focus(); } });

  function close() { setAsking(false); setInvalid(false); setCode(''); refocus.current = true; }
  async function submit(e: FormEvent) {
    e.preventDefault();
    const normalized = normalizeHouseholdCode(code);
    if (!validHouseholdCode(normalized)) { setInvalid(true); field.current?.focus(); return; }
    setInvalid(false);
    if (needCode) { setHouseholdCode(normalized); setCode(''); return; }
    setChecking(true);
    try { await turnOnLockedAlerts(normalized); } finally { setChecking(false); close(); }
  }

  const status = view.removing ? s.removing
    : view.note ? (view.note === 'blocked' ? t.ride.notifyBlocked : view.note === 'code' ? '' : s[view.note])
    : !view.enabled ? (view.context === 'demo' ? s.demo : view.context === 'no-live' ? s.needsLive : '')
    : view.ride === 'on' ? s.on : view.ride === 'starting' ? s.starting : view.ride === 'waiting-gps' ? s.waitingGps : s.ready(t.busLock.boarded);
  const unavailableHere = view.context !== 'ok' && !view.enabled;

  return (
    <div className={row ? 'locked-alerts locked-alerts-row' : 'locked-alerts'} data-testid="locked-alerts">
      <label className={row ? 'lock-toggle switch-row' : 'lock-toggle'}>
        <input ref={toggle} type="checkbox" checked={view.enabled || formOpen} disabled={unavailableHere || checking} aria-describedby={`${id}-status`}
          onChange={(e) => {
            if (e.target.checked) { clearLockedNote(); setAsking(true); }
            else if (!view.enabled) close();
            else turnOffLockedAlerts();
          }} />
        {row ? <span className="menu-row-text"><strong>{s.title}</strong><span>{s.rowDetail}</span></span> : s.title}
      </label>
      {formOpen && <form className="locked-consent" onSubmit={(e) => { void submit(e); }} noValidate aria-labelledby={needCode ? `${id}-code-label` : `${id}-consent-title`}>
        {needCode ? <p className="locked-alert-note" role="alert">{s.wrongCode}</p> : <>
          <p className="locked-consent-title" id={`${id}-consent-title`}>{s.consentTitle}</p>
          <p id={`${id}-consent`}>{s.consent}</p>
          <p>{s.noLocation}</p>
          <p className="locked-limits-title">{s.limitsTitle}</p>
          <ul className="locked-limits-list">{s.limits.map((line) => <li key={line}>{line}</li>)}</ul>
        </>}
        <label htmlFor={`${id}-code`} id={`${id}-code-label`} className="locked-code-label">{s.codeLabel}</label>
        <input id={`${id}-code`} ref={field} className="locked-code" type="text" value={code} autoComplete="off" autoCapitalize="characters" spellCheck={false}
          aria-invalid={invalid || undefined} aria-describedby={`${id}-help${invalid ? ` ${id}-invalid` : ''}${needCode ? '' : ` ${id}-consent`}`}
          onChange={(e) => { setCode(e.target.value); if (invalid) setInvalid(false); }} />
        <p id={`${id}-help`} className="small muted">{s.codeHelp}</p>
        {invalid && <p id={`${id}-invalid`} className="small locked-alert-note" role="alert">{s.codeInvalid}</p>}
        <div className="locked-actions">
          <button type="submit" className="primary" disabled={checking}>{checking ? s.checking : needCode ? s.saveCode : s.turnOn}</button>
          <button type="button" className="ghost" disabled={checking} onClick={() => { if (needCode) turnOffLockedAlerts(); close(); }}>{s.cancel}</button>
        </div>
      </form>}
      <div className="locked-status">
        <p className="small" role="status" id={`${id}-status`}>{status}</p>
        {view.note && RETRYABLE.includes(view.note) && view.enabled && <button type="button" className="ghost" onClick={retryLockedAlerts}>{s.tryAgain}</button>}
      </div>
      {!formOpen && <details className="locked-limits">
        <summary>{s.limitsTitle}</summary>
        {row && <p className="small">{s.settingsNote}</p>}
        <ul className="locked-limits-list">{s.limits.map((line) => <li key={line}>{line}</li>)}</ul>
      </details>}
    </div>
  );
}
