import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommutePicker } from '../../src/ui/CommutePicker';
import { strings } from '../../src/ui/i18n';
import { cityDataset } from '../helpers/cityStops';

describe('saved-stop recovery', () => {
  for (const lang of ['en', 'es'] as const) for (const end of ['from', 'to'] as const) {
    it(`${lang}/${end}: opens city choices when the saved stop is absent`, () => {
      const ds = cityDataset(), t = strings[lang];
      const html = renderToStaticMarkup(createElement(CommutePicker, {
        ds, t, lang, initialFrom: end === 'from' ? 'absent' : '1', initialTo: end === 'to' ? 'absent' : '3',
        routeIds: [], end, level: 'stop', onSave: () => false, onCancel: () => {},
      }));
      expect(html).toContain(`${end === 'from' ? t.commuteFrom : t.commuteToLabel}: ${t.cityPicker.city}`);
      expect(html).toContain('city-choice');
      expect(html).toContain(t.cityPicker.cancel);
    });
  }
});
