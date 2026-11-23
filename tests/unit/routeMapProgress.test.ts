import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';
import RouteMap, { type RouteMapProps } from '../../src/ui/RouteMap';
import { mapStrings } from '../../src/ui/mapStrings';

// Run the component's effects with persistent refs, while controlling source
// readiness independently of basemap loading. No WebGL or recorded feed needed.
const harness = vi.hoisted(() => ({
  refs: [] as { current: unknown }[], refIndex: 0, effectIndex: 0,
  dependencies: [] as unknown[][], effects: [] as (() => unknown)[],
  container: { dataset: {} as Record<string, string>, clientWidth: 320, clientHeight: 400 },
  listeners: {} as Record<string, () => void>,
  sources: {} as Record<string, { data: Feature | FeatureCollection; setData: ReturnType<typeof vi.fn> }>,
  jumpTo: vi.fn(), isStyleLoaded: vi.fn(() => false),
}));

vi.mock('react', () => ({
  useRef: (initial: unknown) => harness.refs[harness.refIndex++] ??= { current: initial === null ? harness.container : initial },
  useState: (initial: unknown) => [initial, vi.fn()],
  useEffect: (effect: () => unknown, deps: unknown[]) => {
    const index = harness.effectIndex++, previous = harness.dependencies[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) harness.effects.push(effect);
    harness.dependencies[index] = deps;
  },
}));
vi.mock('maplibre-gl', () => ({
  addProtocol: vi.fn(), setWorkerUrl: vi.fn(), NavigationControl: class {},
  Map: class {
    on(name: string, listener: () => void) { harness.listeners[name] = listener; }
    getContainer() { return harness.container; }
    touchZoomRotate = { disableRotation: vi.fn() };
    addControl() {}
    addLayer() {}
    addSource(id: string, source: { data: Feature | FeatureCollection }) {
      harness.sources[id] = { data: source.data, setData: vi.fn() };
    }
    getSource(id: string) { return harness.sources[id]; }
    isStyleLoaded = harness.isStyleLoaded;
    project([x, y]: number[]) { return { x, y }; }
    getZoom() { return 13.5; }
    jumpTo = harness.jumpTo;
  },
}));
vi.mock('../../src/ui/mapGlyphs', () => ({ mapGlyphs: () => ({ url: '', dispose: vi.fn() }) }));
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '' }));

beforeEach(() => {
  harness.refs = []; harness.dependencies = []; harness.effects = [];
  harness.listeners = {}; harness.sources = {};
  vi.clearAllMocks();
  vi.stubGlobal('location', { href: 'https://example.invalid/' });
});
afterEach(() => vi.unstubAllGlobals());

function render(props: RouteMapProps) {
  harness.refIndex = 0; harness.effectIndex = 0;
  RouteMap(props);
  for (const effect of harness.effects.splice(0)) effect();
}

function initialProps(): RouteMapProps {
  return {
    stops: [{ id: 'test', name: 'Test', lat: 40.8, lon: -74.1, state: 'next' }],
    bus: { lat: 40.8, lon: -74.1 }, you: { lat: 40.81, lon: -74.11 },
    dark: false, label: 'Map', failedText: 'Unavailable', text: mapStrings.en,
  };
}

it('applies bus, rider and stop changes while basemap resources are still loading', () => {
  const props = initialProps();
  render(props);
  harness.listeners['style.load']!();
  const update = { ...props, stops: props.stops.map(s => ({ ...s, state: 'passed' as const })),
    bus: { lat: 40.82, lon: -74.12 }, you: { lat: 40.83, lon: -74.13 } };
  render(update);
  expect(harness.sources.bus!.setData).toHaveBeenCalledWith(expect.objectContaining({ features: [expect.objectContaining({ geometry: { type: 'Point', coordinates: [-74.12, 40.82] } })] }));
  expect(harness.sources.you!.setData).toHaveBeenCalledWith(expect.objectContaining({ features: [expect.objectContaining({ geometry: { type: 'Point', coordinates: [-74.13, 40.83] } })] }));
  expect(harness.sources.stops!.setData).toHaveBeenCalledOnce();
  expect(harness.sources.route!.setData).toHaveBeenCalledOnce();
  expect(harness.jumpTo).toHaveBeenLastCalledWith(expect.objectContaining({ center: [-74.12, 40.82] }));
  expect(harness.isStyleLoaded).not.toHaveBeenCalled();
  render(update);
  expect(harness.sources.bus!.setData).toHaveBeenCalledOnce();
});

it('initializes overlays from the latest props when progress arrives before style.load', () => {
  const props = initialProps();
  render(props);
  const update = { ...props, bus: { lat: 40.82, lon: -74.12 } };
  render(update);
  expect(harness.sources).toEqual({});
  harness.listeners['style.load']!();
  expect(harness.sources.bus!.data).toMatchObject({ features: [{ geometry: { coordinates: [-74.12, 40.82] } }] });
  expect(harness.jumpTo).toHaveBeenLastCalledWith(expect.objectContaining({ center: [-74.12, 40.82] }));
});
