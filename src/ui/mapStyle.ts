import type { ExpressionSpecification, LayerSpecification } from 'maplibre-gl';

const IDENTIFIER_LAYERS = new Set(['roads_shields', 'address_label']);

/** The basemap's default English style also adds local-script lines and font overrides.
 * Use one English/Latin name with the fonts/ranges already bundled on our own site. */
export function bundledLabelLayers(layers: LayerSpecification[]): LayerSpecification[] {
  const latinName: ExpressionSpecification = ['case', ['has', 'name:en'], ['get', 'name:en'], ['has', 'name:latin'], ['get', 'name:latin'],
    ...(['name', 'name2', 'name3'] as const).flatMap((name, i): ExpressionSpecification[] => {
      const script = i === 0 ? 'script' : `script${i + 1}`;
      // Protomaps omits the script property for Latin segments.
      return [['all', ['has', name], ['any', ['!', ['has', script]], ['==', ['get', script], 'Latin']]], ['get', name]];
    }), ''];
  return layers.map(layer => {
    if (layer.type !== 'symbol' || !layer.layout?.['text-field']) return layer;
    // House numbers and road shields are identifiers, not multilingual names.
    if (IDENTIFIER_LAYERS.has(layer.id)) return layer;
    return { ...layer, layout: { ...layer.layout, 'text-field': layer.id === 'places_region'
      ? ['step', ['zoom'], ['coalesce', ['get', 'ref:en'], ['get', 'ref'], ''], 6, latinName] : latinName } };
  });
}

/** Limit our map overlay labels to the three Noto ranges shipped in public/map/fonts.
 * The original stop names elsewhere in the app are unchanged, including Spanish text. */
export function bundledMapLabel(value: string): string {
  return value.replace(/[^\u0000-\u01ff\u2000-\u20ff]/gu, '').trim();
}
/** Join only surviving label parts so an unavailable name never leaves a separator. */
export function bundledStopLabel(name: string, city?: string): string {
  return [bundledMapLabel(name), bundledMapLabel(city ?? '')].filter(Boolean).join(' · ');
}
/** Keep geographic bearings while removing minor-road, building and POI clutter. */
export function transitContextLayers(layers: LayerSpecification[]): LayerSpecification[] {
  return layers.filter(l => ['background', 'earth', 'water', 'water_river', 'water_label_lakes', 'water_label_ocean', 'water_waterway_label', 'landuse_park', 'places_locality', 'roads_labels_major', 'roads_shields'].includes(l.id)
    || /^roads_.*(major|highway)/.test(l.id));
}
