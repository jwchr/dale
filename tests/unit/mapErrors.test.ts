import { expect, it } from 'vitest';
import { isFatalMapError } from '../../src/ui/mapErrors';

it('a style startup failure is fatal', () => {
  expect(isFatalMapError({ error: new Error('Invalid style') }, false)).toBe(true);
});

for (const styleLoaded of [false, true]) it(`individual tile errors are recoverable (style loaded: ${styleLoaded})`, () => {
  for (const message of ['404 glyph range', '404 tile', 'Archive unavailable']) {
    expect(isFatalMapError({ error: new Error(message), sourceId: 'protomaps', tile: {} }, styleLoaded)).toBe(false);
    expect(isFatalMapError({ error: new Error(message), tile: {} }, styleLoaded)).toBe(false);
  }
});

for (const styleLoaded of [false, true]) it(`a failed basemap archive shows the fallback (style loaded: ${styleLoaded})`, () => {
  expect(isFatalMapError({ error: new Error('Archive unavailable'), sourceId: 'protomaps' }, styleLoaded)).toBe(true);
});

it('asset errors after style.load never hide a usable map', () => {
  for (const message of ['404 glyph range', '404 sprite', 'Tile decode failed']) {
    expect(isFatalMapError({ error: new Error(message) }, true)).toBe(false);
  }
});
