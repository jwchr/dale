import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { EarlierBusDetails } from '../../src/ui/EarlierBuses';
import { strings } from '../../src/ui/i18n';
import type { EarlierBus } from '../../src/domain/earlierBuses';
import { liveDataset as ds, NOW } from '../helpers/liveBus';

for (const lang of ['en', 'es'] as const) {
  const s = strings[lang].earlierBuses;
  const bus: EarlierBus = { route: '165', direction: 1,
    stop: { scheduledAt: NOW - 60_000, evidence: { at: NOW, sourceAt: NOW, kind: 'gps', minutesLate: 1 } }, portAuthority: null };
  it(`omits an inapplicable terminal from both summary and details (${lang})`, () => {
    const html = renderToStaticMarkup(createElement(EarlierBusDetails, { bus, ds, lang, now: NOW }));
    expect(html).not.toContain(s.terminal);
    expect(html.match(/<dt>/g)).toHaveLength(1);
    expect(html).toContain(s.atStop);
    expect(html).toContain(s.observed);
    expect(html).toContain(`${s.actual}: ${s.unknown}`);
  });
  it(`still shows a relevant terminal with unknown evidence and its scheduled time (${lang})`, () => {
    const inbound = { ...bus, direction: 0 as const, portAuthority: { scheduledAt: NOW + 60_000, evidence: null } };
    const html = renderToStaticMarkup(createElement(EarlierBusDetails, { bus: inbound, ds, lang, now: NOW }));
    expect(html.match(/<dt>/g)).toHaveLength(2);
    expect(html).toContain(`${s.terminal}: <span class="muted">${s.unknown}</span>`);
    expect(html).toContain(`<dt>${s.terminal}</dt><dd>${s.scheduled}: 7:21`);
  });
}
