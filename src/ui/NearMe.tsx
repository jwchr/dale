// "Stops near me" (issue #31): opt-in, one position from the phone, used on the phone to list nearby
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
const GIVE_UP_MS = 20_000;
/** Distances are shown to 10 m: enough to choose a corner, too coarse to pin down where the rider stands. */
const roundTo10 = (m: number) => Math.max(10, Math.round(m / 10) * 10);

type State =
  | { status: 'idle' }
  | { status: 'asking' }
  | { status: 'done'; results: { stop: Stop; distanceM: number }[]; accuracyM: number }
  | { status: 'denied' | 'failed' | 'unsupported' };

export function NearMe({ ds, t, onPick }: { ds: Dataset; t: Strings; onPick: (s: Stop) => void }) {
  const n = t.nearMe;
  const [state, setState] = useState<State>({ status: 'idle' });
  const giveUp = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(giveUp.current), []);
  if (!hasStopLocations(ds)) return <p className="muted small" role="note">{n.unavailable}</p>;

  function ask() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setState({ status: 'unsupported' }); return; }
    setState({ status: 'asking' });
    clearTimeout(giveUp.current);
    giveUp.current = setTimeout(() => setState((s) => (s.status === 'asking' ? { status: 'failed' } : s)), GIVE_UP_MS);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(giveUp.current);
        // The coordinates stay in this callback. Only the stop list, distances rounded to 10 m and the
        // stated accuracy are kept, in memory on this screen; none of it is stored, logged or sent.
        const results = nearbyStops(ds, { lat: p.coords.latitude, lon: p.coords.longitude }, RADIUS_M)
          .map((x) => ({ ...x, distanceM: roundTo10(x.distanceM) }));
        setState({ status: 'done', results, accuracyM: Math.round(p.coords.accuracy) });
      },
      (e) => { clearTimeout(giveUp.current); setState({ status: e.code === e.PERMISSION_DENIED ? 'denied' : 'failed' }); },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }

  return (
    <div className="near-me">
      <button onClick={ask}>{n.button}</button>
      <p className="muted small">{n.explain}</p>
      <div role="status">
        {state.status === 'asking' && <p className="small">{n.asking}</p>}
        {state.status === 'denied' && <p className="warn small">{n.denied}</p>}
        {state.status === 'failed' && <p className="warn small">{n.failed}</p>}
        {state.status === 'unsupported' && <p className="warn small">{n.unsupported}</p>}
        {state.status === 'done' && !state.results.length && <p className="small">{n.none(RADIUS_M)}</p>}
        {state.status === 'done' && state.results.length > 0 && <>
          <p className="small">{n.results(state.accuracyM)}</p>
          {state.accuracyM > ROUGH_M && <p className="warn small">{n.rough}</p>}
        </>}
      </div>
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
