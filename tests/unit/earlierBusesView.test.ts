import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { EarlierBuses } from '../../src/ui/EarlierBuses';
import { strings } from '../../src/ui/i18n';
import { localYmd } from '../../src/domain/time';
import { routeLabel } from '../../src/domain/routeDisplay';
import type { EarlierAnswer, EarlierQuery } from '../../src/domain/earlierBuses';
import { liveDataset as ds, NOW } from '../helpers/liveBus';

vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(), useState: vi.fn() }));

const queries: EarlierQuery[] = ['165', '165T'].map(route => ({ route, stop: '1', direction: 0 }));
const today = localYmd(NOW, ds.meta.timezone);
const answer = (query: EarlierQuery, generatedAt = NOW): EarlierAnswer => ({
  v: 1, query, generatedAt, coverageStart: NOW - 60_000, through: NOW, gap: false, items: [],
});
function render(lang: 'en' | 'es', answers: (EarlierAnswer | undefined)[]) {
  vi.mocked(useState).mockReturnValue([{ key: `${today}|${JSON.stringify(queries)}`, answers }, vi.fn()]);
  return renderToStaticMarkup(createElement(EarlierBuses, {
    ds, stop: '1', routeIds: ds.routes.filter(r => ['165', '165T'].includes(r.shortName)).map(r => r.id),
    direction: 0, lang, now: NOW, api: 'https://worker.test',
  }));
}

for (const lang of ['en', 'es'] as const) {
  for (const failedIndex of [0, 1]) {
    for (const failure of ['missing', 'stale', 'yesterday'] as const) {
      it(`keeps route ${queries[failedIndex]!.route} visible when ${failure} beside a successful route (${lang})`, () => {
        const answers: (EarlierAnswer | undefined)[] = queries.map(q => answer(q));
        answers[failedIndex] = failure === 'missing' ? undefined
          : answer(queries[failedIndex]!, NOW - (failure === 'stale' ? 600_000 : 86400_000));
        const html = render(lang, answers), s = strings[lang].earlierBuses;
        expect(html).toContain(`${routeLabel(queries[failedIndex]!.route, strings[lang].gateTurnpikeExpress)} · ${s.unavailable}`);
        expect(html).toContain(`${routeLabel(queries[1 - failedIndex]!.route, strings[lang].gateTurnpikeExpress)} · ${s.coverage}`);
        expect(html).toContain(s.empty);
      });
    }
  }
  it(`shows each route's unavailability when both fail (${lang})`, () => {
    const html = render(lang, [undefined, undefined]);
    for (const q of queries) expect(html).toContain(`${routeLabel(q.route, strings[lang].gateTurnpikeExpress)} · ${strings[lang].earlierBuses.unavailable}`);
  });
}

for (const lang of ['en', 'es'] as const) {
  for (const placement of ['after', 'before', 'unrelated'] as const) {
    it(`matches equivalent destinations only after the origin: ${placement} (${lang})`, () => {
      const data = structuredClone(ds);
      data.stops.find(s => s.id === '3')!.terminal = 'PABT';
      data.stops.push({ id: 'other-pabt', name: 'Synthetic terminal', terminal: 'PABT' });
      for (const p of data.patterns) p.stopIds = placement === 'after' ? ['1', '2', '3']
        : placement === 'before' ? ['3', '1', '2'] : ['1', '2'];
      vi.mocked(useState).mockReturnValue([{ key: `${today}|${JSON.stringify(placement === 'after' ? queries : [])}`, answers: queries.map(q => answer(q)) }, vi.fn()]);
      const html = renderToStaticMarkup(createElement(EarlierBuses, {
        ds: data, stop: '1', routeIds: data.routes.map(r => r.id), toStop: 'other-pabt', direction: 0, lang, now: NOW,
      }));
      expect(html.includes(strings[lang].earlierBuses.empty)).toBe(placement === 'after');
      expect(html.includes(strings[lang].earlierBuses.unavailable)).toBe(placement !== 'after');
    });
  }
}
