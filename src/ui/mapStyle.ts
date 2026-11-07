import type { LayerSpecification } from 'maplibre-gl';
/** Keep geographic bearings while removing minor-road, building and POI clutter. */
export function transitContextLayers(layers: LayerSpecification[]): LayerSpecification[] {
  return layers.filter(l => ['background', 'earth', 'water', 'water_river', 'water_label_lakes', 'water_label_ocean', 'water_waterway_label', 'landuse_park', 'places_locality', 'roads_labels_major', 'roads_shields'].includes(l.id)
    || /^roads_.*(major|highway)/.test(l.id));
}
