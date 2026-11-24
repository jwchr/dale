import { boardingInfo } from '../domain/stopInfo';
import type { Dataset, Stop } from '../domain/types';
import type { Strings } from './i18n';
export function StopChoice({ ds, stop, stopIds = [stop.id], t, onPick, distance }: { ds: Dataset; stop: Stop; stopIds?: string[]; t: Strings; onPick: (s: Stop) => void; distance?: string }) {
  const members = stopIds.map(id => boardingInfo(ds, id, t.gateTurnpikeExpress));
  const routes = [...new Set(members.flatMap(info => info.routes))];
  const destinations = [...new Set(members.flatMap(info => info.destinations))].map(s => s === 'PABT' ? t.commuteNewYork + ' · ' + t.commutePabt : s);
  return <button type="button" className="stop-choice" onClick={() => onPick(stop)}>
    <strong>{stop.name}</strong>
    <span className="stop-number">{stop.code ? t.selection.stopNumber(stop.code) : t.selection.numberUnknown}{distance && <> · {distance}</>}</span>
    <span className="stop-direction">{destinations.length ? <>{t.selection.towards}: {destinations.join(' / ')}</> : t.selection.noBoarding}</span>
    {routes.length > 0 && <span className="muted small">{routes.join(' · ')}</span>}
  </button>;
}
