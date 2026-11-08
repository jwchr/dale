import { Fragment } from 'react';
import type { MapStop } from './RouteMap';
import type { MapStrings } from './mapStrings';
import { progressAlong, OFF_ROUTE_M } from '../domain/rideGuide';
/** Original stop-order diagram; no geographic or arrival confirmation is inferred from its spacing. */
export function TransitLineMap({ stops, bus, text }: { stops: MapStop[]; bus?: { lat: number; lon: number }; text: MapStrings }) {
  const projection = bus && stops.length > 1 ? progressAlong(stops, 0, stops.length - 1, bus) : undefined;
  const position = projection && projection.offM <= OFF_ROUTE_M ? projection.progress : undefined;
  const near = position === undefined ? Math.max(0, stops.findIndex(s => s.state === 'next')) : Math.floor(position);
  const selected = stops.map((_, i) => i).filter(i => stops.length <= 12 || i === 0 || stops[i]?.state === 'alight' || i >= near - 2 && i <= near + 5);
  const item = (i: number, marker = false) => <li key={i} data-state={stops[i]!.state} data-current={stops[i]!.current || undefined}>
    <span className="line-node" aria-hidden="true" /><span><strong>{stops[i]!.name}</strong>{stops[i]!.city && <small>{stops[i]!.city}</small>}
      {stops[i]!.state === 'alight' && <small>{text.yours}</small>}{stops[i]!.state === 'next' && <small>{text.next}</small>}
      {stops[i]!.current && <small>{text.here}</small>}
      {marker && <small className="line-bus">● {text.marker}</small>}</span>
  </li>;
  return <section className="transit-line-map" aria-label={text.line}>
    <p className="small">{text.schematic}</p>
    {bus && position === undefined && <p className="warn small">{text.unplaced}</p>}
    <ol className="line-stations">{selected.map((i, n) => <Fragment key={i}>
      {n > 0 && i > selected[n - 1]! + 1 && <li className="line-gap">{text.between(i - selected[n - 1]! - 1)}</li>}
      {item(i, !!stops[i]!.current)}
      {position !== undefined && !stops.some(s => s.current) && i === Math.floor(position) && <li className="line-bus-between"><span className="line-bus">● {text.marker}</span></li>}
    </Fragment>)}</ol>
    {stops.length > 12 && <details><summary>{text.listed(stops.length)}</summary><ol className="line-stations">{stops.map((_, i) => item(i))}</ol></details>}
  </section>;
}
