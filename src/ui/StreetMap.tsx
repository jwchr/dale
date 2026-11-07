import { TransitLineMap } from './TransitLineMap';
// Shared lazy map/failure boundary for waiting and riding; map errors never take the tracker down.
import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import type { RouteMapProps } from './RouteMap';
let preferredView: 'street' | 'transit' | 'line' = 'street';
const RouteMap = lazy(() => import('./RouteMap'));
class MapBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
export function StreetMap({ loadingText, ...props }: RouteMapProps & { loadingText: string }) {
  const [view, setView] = useState(preferredView), text = props.text;
  return <div className="map-views">
    <div className="choice-list" role="group" aria-label={text.views}>{(['street', 'transit', 'line'] as const).map(v => <button type="button" className="chip" key={v} aria-pressed={view === v} onClick={() => { preferredView = v; setView(v); }}>{text[v]}</button>)}</div>
    {view === 'line' ? <TransitLineMap stops={props.stops} bus={props.bus} text={text} />
      : <MapBoundary fallback={<p className="warn small" role="note">{props.failedText}</p>}>
        <Suspense fallback={<p className="small">{loadingText}</p>}><RouteMap {...props} presentation={view} /></Suspense>
      </MapBoundary>}
  </div>;
}
