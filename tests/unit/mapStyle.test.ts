import { expect, it } from 'vitest';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { createExpression, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { LayerSpecification } from 'maplibre-gl';
import { bundledLabelLayers, bundledMapLabel, bundledStopLabel, transitContextLayers } from '../../src/ui/mapStyle';
it('transit view preserves towns, water and named major roads without unrelated point/minor-street clutter', () => {
  const original = layers('protomaps', namedFlavor('light'), { lang: 'en' }), before = structuredClone(original);
  const ids = transitContextLayers(original).map(l => l.id);
  expect(ids).toEqual(expect.arrayContaining(['water', 'earth', 'places_locality', 'roads_highway', 'roads_major', 'roads_labels_major', 'roads_shields']));
  for (const id of ['pois', 'buildings', 'roads_minor', 'roads_labels_minor', 'roads_oneway', 'places_subplace']) expect(ids).not.toContain(id);
  expect(original).toEqual(before);
});

for (const flavor of ['light', 'dark'] as const) it(`${flavor} labels prefer English/Latin without local-script lines or unbundled fonts`, () => {
  const original = layers('protomaps', namedFlavor(flavor), { lang: 'en' }), before = structuredClone(original);
  const safe = bundledLabelLayers(original);
  expect(validateStyleMin({ version: 8, sources: { protomaps: { type: 'vector', tiles: ['https://example.invalid/{z}/{x}/{y}'] } }, layers: safe })).toEqual([]);
  for (const layer of safe) {
    if (layer.type !== 'symbol' || !layer.layout?.['text-field']) continue;
    const parsed = createExpression(layer.layout['text-field'], 'text-field');
    expect(parsed.result).toBe('success');
    if (parsed.result !== 'success') continue;
    const label = (properties: Record<string, string>) => parsed.value.evaluate({ zoom: 15 }, { type: 1, properties });
    if (['roads_shields', 'address_label'].includes(layer.id)) continue;
    expect(label({ name: '中文', script: 'Han', 'name:en': 'English name' })).toBe('English name');
    expect(label({ name: '中文', script: 'Han', 'name:latin': 'Latin name' })).toBe('Latin name');
    expect(label({ name: 'Calle José', name2: '中文', script2: 'Han' })).toBe('Calle José');
    expect(label({ name: '中文', script: 'Han', name2: 'Nueva York' })).toBe('Nueva York');
    expect(label({ name: '中文', script: 'Han', name2: 'देवनागरी', script2: 'Devanagari' })).toBe('');
    const fonts = JSON.stringify(layer.layout['text-font']).match(/Noto Sans[^\"]*/g);
    expect(fonts?.length).toBeGreaterThan(0);
    for (const font of fonts ?? []) expect(font).toMatch(/^Noto Sans (Regular|Medium|Italic)$/);
    expect(JSON.stringify(layer.layout['text-field'])).not.toContain('text-font');
  }
  for (const id of ['roads_shields', 'address_label']) expect(safe.find(l => l.id === id)).toEqual(original.find(l => l.id === id));
  expect(original).toEqual(before);
});

it('map stop labels retain Spanish accents and bundled punctuation but drop unshipped codepoints', () => {
  expect(bundledMapLabel('José · Āvila — 165T')).toBe('José · Āvila — 165T');
  expect(bundledMapLabel('中文 José Ω 🚍')).toBe('José');
  expect(bundledMapLabel('')).toBe('');
  for (const point of [0x1ff, 0x200, 0x1fff, 0x2000, 0x20ff, 0x2100]) {
    const character = String.fromCodePoint(point);
    expect(bundledMapLabel(`A${character}B`)).toBe(point <= 0x1ff || (point >= 0x2000 && point <= 0x20ff) ? `A${character}B` : 'AB');
  }
});

it('stop names and cities are filtered before joining, without dangling separators', () => {
  expect(bundledStopLabel('中文', 'San José')).toBe('San José');
  expect(bundledStopLabel('Central Station', '中文')).toBe('Central Station');
  expect(bundledStopLabel('中文', 'Москва')).toBe('');
  expect(bundledStopLabel('José', 'Āvila')).toBe('José · Āvila');
  expect(bundledStopLabel('Central Station')).toBe('Central Station');
  expect(bundledStopLabel('', 'San José')).toBe('San José');
});

it('layer identity preserves complex identifiers while direct name expressions get Latin fallbacks', () => {
  const original: LayerSpecification[] = [
    { id: 'places_locality', type: 'symbol', source: 'protomaps', layout: { 'text-field': ['get', 'name'] } },
    ...['roads_shields', 'address_label'].map((id): LayerSpecification => ({
      id, type: 'symbol', source: 'protomaps', layout: { 'text-field': ['coalesce', ['get', 'ref'], ['get', 'housenumber'], ''] },
    })),
  ];
  const safe = bundledLabelLayers(original);
  const place = safe[0];
  if (place?.type !== 'symbol') throw new Error('Missing place label');
  const parsed = createExpression(place.layout!['text-field'], 'text-field');
  expect(parsed.result).toBe('success');
  if (parsed.result === 'success') expect(parsed.value.evaluate({ zoom: 15 }, { type: 1, properties: { name: '中文', 'name:en': 'English name' } })).toBe('English name');
  expect(safe.slice(1)).toEqual(original.slice(1));
});
