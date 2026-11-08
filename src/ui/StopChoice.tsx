import { boardingInfo } from '../domain/stopInfo';
import type { Dataset, Stop } from '../domain/types';
import type { Strings } from './i18n';
export function StopChoice({ ds, stop, t, onPick, distance }: { ds: Dataset; stop: Stop; t: Strings; onPick: (s: Stop) => void; distance?: string }) {
  const info = boardingInfo(ds, stop.id), destinations = info.destinations.map(s => s === 'PABT' ? t.commuteNewYork + ' · ' + t.commutePabt : s);
  return <button type="button" className="stop-choice" onClick={() => onPick(stop)}>
    <strong>{stop.name}</strong>
    <span className="stop-number">{stop.code ? t.selection.stopNumber(stop.code) : t.selection.numberUnknown}{distance && <> · {distance}</>}</span>
    <span className="stop-direction">{destinations.length ? <>{t.selection.towards}: {destinations.join(' / ')}</> : t.selection.noBoarding}</span>
    {info.routes.length > 0 && <span className="muted small">{info.routes.join(' · ')}</span>}
  </button>;
}
