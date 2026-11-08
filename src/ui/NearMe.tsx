// "Stops near me" (issue #31): opt-in, one position from the device, used locally to list nearby
// stops and then dropped. Never stored, logged or sent. The rider picks the stop; the direction guard
// and the printed fare zones still decide the rest. Hidden where stops have no coordinates.
import { useEffect, useRef, useState } from 'react';
import { hasStopLocations, nearbyStops } from '../domain/direction';
import type { Dataset, Stop } from '../domain/types';
import { StopChoice } from './StopChoice';
import type { Strings } from './i18n';

const RADIUS_M = 500;
/** A position less precise than this may not pick out the nearest corner. */
const ROUGH_M = 150;
/** Some browsers never answer a dismissed prompt; stop waiting after this long. */
const ATTEMPT_MS = 10_000;
/** Distances are shown to 10 m: enough to choose a corner, too coarse to pin down where the rider stands. */
const roundTo10 = (m: number) => Math.max(10, Math.round(m / 10) * 10);

type State =
  | { status: 'idle' }
  | { status: 'asking'; fallback: boolean }
  | { status: 'done'; results: { stop: Stop; distanceM: number }[]; accuracyM: number }
  | { status: 'denied' | 'failed' | 'timeout' | 'unsupported' };

export function NearMe({ ds, t, onPick }: { ds: Dataset; t: Strings; onPick: (s: Stop) => void }) {
  const n = t.nearMe;
  const [state, setState] = useState<State>({ status: 'idle' });
  const giveUp = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestId = useRef(0);
  useEffect(() => {
    setState({ status: 'idle' });
    return () => { requestId.current++; clearTimeout(giveUp.current); };
  }, [ds]);
  if (!hasStopLocations(ds)) return <p className="muted small" role="note">{n.unavailable}</p>;

  function ask() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setState({ status: 'unsupported' }); return; }
    const id = ++requestId.current;
    let attempt = 0;
    const finish = (next: State) => {
      requestId.current++; // Ignore late callbacks after success, failure, retry or navigation.
      clearTimeout(giveUp.current);
      setState(next);
    };
    const locate = (highAccuracy: boolean) => {
      const currentAttempt = ++attempt;
      const active = () => requestId.current === id && attempt === currentAttempt;
      setState({ status: 'asking', fallback: !highAccuracy });
      const failed = (code: number) => {
        if (!active()) return;
        clearTimeout(giveUp.current);
        if (code === 1) finish({ status: 'denied' });
        else if (highAccuracy) locate(false); // One bounded fallback, useful on computers without GPS.
        else finish({ status: code === 3 ? 'timeout' : 'failed' });
      };
      clearTimeout(giveUp.current);
      giveUp.current = setTimeout(() => failed(3), ATTEMPT_MS);
      try {
        navigator.geolocation.getCurrentPosition(p => {
          if (!active()) return;
          const { latitude: lat, longitude: lon, accuracy } = p.coords;
          if (![lat, lon, accuracy].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || accuracy < 0) {
            failed(2); return;
          }
          // Coordinates never leave this callback. Only rounded distances and accuracy remain in
          // screen memory; no storage, logs, external geocoder or background position watcher.
          const results = nearbyStops(ds, { lat, lon }, RADIUS_M).map(x => ({ ...x, distanceM: roundTo10(x.distanceM) }));
          finish({ status: 'done', results, accuracyM: Math.round(accuracy) });
        }, e => failed(e.code), { enableHighAccuracy: highAccuracy, timeout: 8_000, maximumAge: 60_000 });
      } catch { failed(2); }
    };
    locate(true);
  }

  return (
    <div className="near-me">
      <button onClick={ask} disabled={state.status === 'asking'}>{n.button}</button>
      <p className="muted small">{n.explain}</p>
      <div role="status">
        {state.status === 'asking' && <p className="small">{state.fallback ? n.fallback : n.asking}</p>}
        {state.status === 'denied' && <p className="warn small">{n.denied}</p>}
        {state.status === 'failed' && <p className="warn small">{n.failed}</p>}
        {state.status === 'timeout' && <p className="warn small">{n.timeout}</p>}
        {state.status === 'unsupported' && <p className="warn small">{n.unsupported}</p>}
        {state.status === 'done' && !state.results.length && <p className="small">{n.none(RADIUS_M)}</p>}
        {state.status === 'done' && state.results.length > 0 && <>
          <p className="small">{n.results(state.accuracyM)}</p>
          {state.accuracyM > ROUGH_M && <p className="warn small">{n.rough}</p>}
        </>}
      </div>
      {['denied', 'failed', 'timeout'].includes(state.status) && <details className="small"><summary>{n.help}</summary><p>{n.helpText}</p></details>}
      {state.status === 'done' && state.results.length > 0 && (
        <ul className="results">
          {state.results.map(({ stop, distanceM }) => (
            <li key={stop.id}><StopChoice ds={ds} stop={stop} t={t} onPick={onPick} distance={n.distance(distanceM)} /></li>
          ))}
        </ul>
      )}
    </div>
  );
}
