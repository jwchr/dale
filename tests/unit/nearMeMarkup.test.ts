import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { demoDataset } from '../../src/data/demo';
import { NearMe } from '../../src/ui/NearMe';
import { strings } from '../../src/ui/i18n';

// Markup can be checked in Node; browser focus and geolocation effects are covered in Playwright.
for (const lang of ['en', 'es'] as const) describe(`nearby focus targets (${lang})`, () => {
  it('provides a focusable, translated unavailable note when coordinates are absent', () => {
    const ds = { ...demoDataset, stops: demoDataset.stops.map(({ lat: _lat, lon: _lon, ...stop }) => stop) };
    const html = renderToStaticMarkup(createElement(NearMe, { ds, t: strings[lang], onPick: () => {}, visible: true, autoAsk: true }));
    expect(html).toMatch(/<p[^>]*tabindex="-1"[^>]*role="note"/);
    expect(html).toContain(strings[lang].nearMe.unavailable);
    expect(html).not.toContain('<button');
  });

  it('provides the nearby heading only for a location shortcut', () => {
    const props = { ds: demoDataset, t: strings[lang], onPick: () => {}, visible: true };
    const shortcut = renderToStaticMarkup(createElement(NearMe, { ...props, autoAsk: true }));
    expect(shortcut).toContain(`<h2 tabindex="-1">${strings[lang].nearMe.button}</h2>`);
    const plainSearch = renderToStaticMarkup(createElement(NearMe, props));
    expect(plainSearch).not.toContain('<h2');
  });
});
