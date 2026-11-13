import { transitContextLayers } from './mapStyle';
import type { MapStrings } from './mapStrings';
import { leadPadding } from './leadPadding';
// The ride on a street map (owner decision 2026-11-04: self-hosted OpenStreetMap). Everything is served
// from Dale's own site: the North Jersey and Manhattan map file (Protomaps build of OpenStreetMap data,
// ODbL), the fonts (Noto, OFL) and icons (MIT); no tile company sees what the rider looks at.
// Loaded on demand (it is large), and only where stops have coordinates.
import { layers, namedFlavor } from '@protomaps/basemaps';
import { addProtocol, Map as MapLibreMap, NavigationControl, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
// The map draws in a background worker; Vite builds it as its own module file next to the app.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Feature, FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { useEffect, useRef, useState } from 'react';

/** The map file: its name carries the OpenStreetMap build date, so a new build is a new file. */
export const MAP_FILE = 'map/nj-nyc-20261104.pmtiles';
/** What the file covers; the map cannot be panned far outside it. */
const COVERS: [number, number, number, number] = [-74.25, 40.7, -73.9, 41.1];

export interface MapStop { id: string; city?: string; lat: number; lon: number; name: string; current?: boolean; state: 'passed' | 'next' | 'alight' | 'ahead' }
export interface RouteMapProps { stops: MapStop[]; bus?: { lat: number; lon: number }; dark: boolean; label: string; failedText: string; text: MapStrings; presentation?: 'street' | 'transit' }

let protocolAdded = false;

/** Following the bus (owner, #155): the dot sits off-centre, away from where the route goes next, so more of the
 *  route ahead stays on screen. Screen padding only; the bus position itself is drawn exactly where it was reported. */
function followBus(m: MapLibreMap, bus: { lat: number; lon: number }, stops: MapStop[], zoom: number) {
  const target = stops.filter(s => s.state !== 'passed').slice(0, 4).at(-1);
  const { clientWidth: w, clientHeight: h } = m.getContainer();
  const padding = target ? leadPadding(m.project([bus.lon, bus.lat]), m.project([target.lon, target.lat]), w, h) : leadPadding({ x: 0, y: 0 }, { x: 0, y: 0 }, w, h);
  m.jumpTo({ center: [bus.lon, bus.lat], zoom, padding });
}

export default function RouteMap({ stops, bus, dark, label, failedText, text, presentation = 'street' }: RouteMapProps) {
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<'bus' | 'route' | 'manual'>(bus ? 'bus' : 'route');
  const following = useRef(true);
  const drawn = useRef({ stops: '', bus: '' });
  const camera = useRef<{ center: [number, number]; zoom: number } | undefined>(undefined);
  const el = useRef<HTMLElement>(null);
  const map = useRef<MapLibreMap | undefined>(undefined);
  const latest = useRef({ stops, bus });
  latest.current = { stops, bus };

  useEffect(() => {
    if (failed || !el.current) return;
    if (!protocolAdded) { setWorkerUrl(workerUrl); addProtocol('pmtiles', new Protocol().tile); protocolAdded = true; }
    const base = new URL(import.meta.env.BASE_URL, location.href).href;
    const flavor = presentation === 'transit' ? 'light' : dark ? 'dark' : 'light';
    const inkDark = flavor === 'dark';
    const baseLayers = layers('protomaps', namedFlavor(flavor), { lang: 'en' });
    const contextLayers = presentation === 'street' ? baseLayers : transitContextLayers(baseLayers);
    const lons = stops.map((s) => s.lon), lats = stops.map((s) => s.lat);
    let m: MapLibreMap;
    try {
      m = new MapLibreMap({
      container: el.current,
      style: {
        version: 8,
        glyphs: `${base}map/fonts/{fontstack}/{range}.pbf`,
        sprite: `${base}map/sprites/${flavor}`,
        sources: {
          protomaps: {
            type: 'vector', url: `pmtiles://${base}${MAP_FILE}`,
            attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          },
        },
        layers: contextLayers,
      },
      ...(camera.current ? camera.current : bus ? { center: [bus.lon, bus.lat] as [number, number], zoom: 13.5 }
        : { bounds: [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]] as [[number, number], [number, number]], fitBoundsOptions: { padding: 36, maxZoom: 14 } }),
      maxBounds: [[COVERS[0] - 0.08, COVERS[1] - 0.06], [COVERS[2] + 0.08, COVERS[3] + 0.06]],
      maxZoom: 17,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      });
    } catch {
      // No WebGL (an old phone, or graphics turned off): say so and leave the rest of ride mode alone.
      setFailed(true);
      return;
    }
    // Tile/archive/style failures arrive after construction (for example an offline first map load).
    m.on('error', () => setFailed(true));
    m.on('webglcontextlost', () => setFailed(true));
    m.touchZoomRotate.disableRotation();
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    const userMoved = () => { following.current = false; setView('manual'); };
    m.on('dragstart', userMoved);
    m.on('zoomstart', e => { if (e.originalEvent) userMoved(); });
    m.on('load', () => {
      if (following.current && latest.current.bus) { followBus(m, latest.current.bus, latest.current.stops, Math.max(13.5, m.getZoom())); setView('bus'); }
      m.addSource('route', { type: 'geojson', data: routeData(latest.current.stops) });
      m.addSource('stops', { type: 'geojson', data: stopData(latest.current.stops) });
      m.addSource('bus', { type: 'geojson', data: busData(latest.current.bus) });
      drawn.current = { stops: JSON.stringify(latest.current.stops), bus: JSON.stringify(latest.current.bus) ?? '' };
      m.addLayer({ id: 'route-casing', type: 'line', source: 'route', paint: { 'line-color': '#000000', 'line-width': 9, 'line-opacity': 0.55 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      m.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': presentation === 'transit' ? '#007e93' : '#ffb02e', 'line-width': 5 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      m.addLayer({
        id: 'stops', type: 'circle', source: 'stops',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'state'], 'alight', 9, 'next', 8, 2], 15, ['match', ['get', 'state'], 'alight', 9, 'next', 8, 5]],
          'circle-color': ['case', ['==', ['get', 'current'], true], '#ffb02e', ['match', ['get', 'state'], 'passed', '#6b7280', 'alight', '#ff5a4f', '#ffffff']],
          'circle-stroke-color': ['match', ['get', 'state'], 'alight', '#ffffff', '#111111'],
          'circle-stroke-width': 2,
        },
      });
      m.addLayer({
        id: 'stop-names', type: 'symbol', source: 'stops', filter: ['in', ['get', 'state'], ['literal', ['next', 'alight']]],
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': inkDark ? '#f2f4f7' : '#111827', 'text-halo-color': inkDark ? '#000000' : '#ffffff', 'text-halo-width': 1.6 },
      });
      m.addLayer({ id: 'stop-other-names', type: 'symbol', source: 'stops', minzoom: 15,
        filter: ['!', ['in', ['get', 'state'], ['literal', ['next', 'alight']]]],
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true, 'text-padding': 8 },
        paint: { 'text-color': inkDark ? '#f2f4f7' : '#111827', 'text-halo-color': inkDark ? '#000000' : '#ffffff', 'text-halo-width': 1.6 } });
      m.addLayer({ id: 'bus-glow', type: 'circle', source: 'bus', paint: { 'circle-radius': 16, 'circle-color': '#ffb02e', 'circle-opacity': 0.3, 'circle-blur': 0.6 } });
      m.addLayer({ id: 'bus', type: 'circle', source: 'bus', paint: { 'circle-radius': 7, 'circle-color': '#ffd36e', 'circle-stroke-color': '#111111', 'circle-stroke-width': 3 } });
    });
    map.current = m;
    return () => { const c = m.getCenter(); camera.current = { center: [c.lng, c.lat], zoom: m.getZoom() }; m.remove(); map.current = undefined; };
  }, [dark, failed, presentation]); // eslint-disable-line react-hooks/exhaustive-deps

  // New progress moves the dots and the bus without rebuilding the map.
  useEffect(() => {
    const m = map.current;
    if (!m || !m.isStyleLoaded()) return;
    const stopKey = JSON.stringify(stops), busKey = JSON.stringify(bus) ?? '';
    if (drawn.current.stops !== stopKey) {
      (m.getSource('stops') as GeoJSONSource | undefined)?.setData(stopData(stops));
      (m.getSource('route') as GeoJSONSource | undefined)?.setData(routeData(stops));
      drawn.current.stops = stopKey;
    }
    if (drawn.current.bus !== busKey) {
      (m.getSource('bus') as GeoJSONSource | undefined)?.setData(busData(bus)); drawn.current.bus = busKey;
      if (following.current && bus) { followBus(m, bus, stops, Math.max(13.5, m.getZoom())); setView('bus'); }
    }
  }, [stops, bus]);

  // A labelled region, not an image: it holds the zoom buttons and the attribution link.
  if (failed) return <p className="warn small" role="note">{failedText}</p>;
  return <><div className="choice-list map-camera-controls">
    <button type="button" className="chip" disabled={!bus} aria-pressed={view === 'bus'} onClick={() => { if (!map.current || !bus) return; following.current = true; setView('bus'); followBus(map.current, bus, stops, 13.5); }}>{text.close}</button>
    <button type="button" className="chip" aria-pressed={view === 'route'} onClick={() => { if (!map.current || !stops.length) return; following.current = false; setView('route'); map.current.fitBounds([[Math.min(...stops.map(s => s.lon)), Math.min(...stops.map(s => s.lat))], [Math.max(...stops.map(s => s.lon)), Math.max(...stops.map(s => s.lat))]], { padding: 36, maxZoom: 14, duration: 0 }); }}>{text.route}</button>
  </div><section className="route-map" ref={el} aria-label={label} data-camera={view} data-presentation={presentation} /></>;
}

function routeData(stops: MapStop[]): Feature {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: stops.map((s) => [s.lon, s.lat]) } };
}
function stopData(stops: MapStop[]): FeatureCollection {
  return { type: 'FeatureCollection', features: stops.map((s) => ({ type: 'Feature', properties: { name: s.city ? `${s.name} · ${s.city}` : s.name, state: s.state, current: !!s.current }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })) };
}
function busData(bus?: { lat: number; lon: number }): FeatureCollection {
  return { type: 'FeatureCollection', features: bus ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [bus.lon, bus.lat] } }] : [] };
}
