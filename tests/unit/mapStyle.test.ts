import { expect, it } from 'vitest';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { transitContextLayers } from '../../src/ui/mapStyle';
it('transit view preserves towns, water and named major roads without unrelated point/minor-street clutter', () => {
  const original = layers('protomaps', namedFlavor('light'), { lang: 'en' }), before = structuredClone(original);
  const ids = transitContextLayers(original).map(l => l.id);
  expect(ids).toEqual(expect.arrayContaining(['water', 'earth', 'places_locality', 'roads_highway', 'roads_major', 'roads_labels_major', 'roads_shields']));
  for (const id of ['pois', 'buildings', 'roads_minor', 'roads_labels_minor', 'roads_oneway', 'places_subplace']) expect(ids).not.toContain(id);
  expect(original).toEqual(before);
});
