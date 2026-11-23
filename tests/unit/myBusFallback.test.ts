import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { departuresOn } from '../../src/domain/schedule';
import { MyBusFallback } from '../../src/ui/MyBusFallback';
import { strings } from '../../src/ui/i18n';
import { myBusStrings } from '../../src/ui/myBusStrings';
import { liveDataset } from '../helpers/liveBus';

it.each([
  ['en', '165T', '165 NEW YORK', 'Turnpike express'],
  ['es', '165T', '165 NEW YORK', 'Expreso por Turnpike'],
  ['en', '165', '165T NEW YORK', 'Turnpike express'],
  ['es', '165', '165T NEW YORK', 'Expreso por Turnpike'],
] as const)('MyBus shows localized split and unsplit Turnpike service (%s, %s)', (lang, shortName, headsign, expected) => {
  const ds = structuredClone(liveDataset);
  ds.routes.find(r => r.id === '10')!.shortName = shortName;
  ds.stops.find(s => s.id === '2')!.code = '00302';
  const dep = departuresOn(ds, { stopId: '2', toStopId: '3', routeIds: ['10'], date: '20261104' })[0]!;
  dep.pattern.headsign = headsign;
  const before = JSON.stringify(dep);
  const html = renderToStaticMarkup(createElement(MyBusFallback, { ds, dep, lang }));
  expect(strings[lang].gateTurnpikeExpress).toBe(expected);
  expect(html).toContain(`${myBusStrings[lang].direction}: 165 NEW YORK · ${expected}`);
  expect(html).not.toContain('165T');
  expect(html).toContain('00302');
  expect(JSON.stringify(dep)).toBe(before);
});
