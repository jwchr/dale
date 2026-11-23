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

for (const lang of ['en', 'es'] as const) {
  const s = strings[lang].earlierBuses;
  const dates = lang === 'en' ? ['Nov 3', 'Nov 5', 'Dec 31', 'Mar 8', 'Nov 1'] : ['3 nov', '5 nov', '31 dic', '8 mar', '1 nov'];
  const cases = [
    ['2026-11-04T00:05:00-05:00', '2026-11-03T23:55:00-05:00', '11:55'],
    ['2026-11-04T23:55:00-05:00', '2026-11-05T00:05:00-05:00', '12:05'],
    ['2027-01-01T00:05:00-05:00', '2026-12-31T23:55:00-05:00', '11:55'],
    ['2026-03-09T00:05:00-04:00', '2026-03-08T01:55:00-05:00', '1:55'],
    ['2026-11-02T00:05:00-05:00', '2026-11-01T01:55:00-04:00', '1:55'],
  ];
  for (const [i, [current, event, clock]] of cases.entries()) {
    it(`dates terminal schedules and all off-day evidence across boundary ${i} (${lang})`, () => {
      const now = Date.parse(current!), at = Date.parse(event!);
      const bus: EarlierBus = { route: '165', direction: 0,
        stop: { scheduledAt: now, evidence: { at, sourceAt: now, kind: 'gps', minutesLate: null } },
        portAuthority: { scheduledAt: at, evidence: { at, sourceAt: now, kind: 'prediction', minutesLate: null } } };
      const html = renderToStaticMarkup(createElement(EarlierBusDetails, { bus, ds, lang, now }));
      expect(html).toContain(`${s.observed}: ${dates[i]}`);
      expect(html).toContain(`${s.expected}: ${dates[i]}`);
      expect(html).toContain(`<dt>${s.terminal}</dt><dd>${s.scheduled}: ${dates[i]}`);
      expect(html).toContain(clock!);
      expect(html).toMatch(/AM|PM|a\.\s*m\.|p\.\s*m\./);
      expect(html).toContain(`${s.scheduled} ${i === 1 ? '11:55' : '12:05'}`); // Today's stop remains time-only.
    });
  }
  it(`keeps unknown times unknown (${lang})`, () => {
    const bus: EarlierBus = { route: '165', direction: 0, stop: { scheduledAt: null, evidence: null },
      portAuthority: { scheduledAt: null, evidence: null } };
    const html = renderToStaticMarkup(createElement(EarlierBusDetails, { bus, ds, lang, now: NOW }));
    expect(html).toContain(`${s.scheduled} ${s.unknown}`);
    expect(html).toContain(`<dt>${s.terminal}</dt><dd>${s.scheduled}: ${s.unknown}`);
  });
}
