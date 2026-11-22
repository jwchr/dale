import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { departuresOn } from '../../src/domain/schedule';
import { MyBusFallback } from '../../src/ui/MyBusFallback';
import { myBusStrings } from '../../src/ui/myBusStrings';
import { liveDataset } from '../helpers/liveBus';

it.each(['en', 'es'] as const)('MyBus shows Turnpike service without a headsign prefix (%s)', lang => {
  const ds = structuredClone(liveDataset);
  ds.routes.find(r => r.id === '10')!.shortName = '165T';
  ds.stops.find(s => s.id === '2')!.code = '00302';
  const dep = departuresOn(ds, { stopId: '2', toStopId: '3', routeIds: ['10'], date: '20261104' })[0]!;
  expect(dep.pattern.headsign).toBe('165 NEW YORK');
  const before = JSON.stringify(dep);
  const html = renderToStaticMarkup(createElement(MyBusFallback, { ds, dep, lang }));
  expect(html).toContain(`${myBusStrings[lang].direction}: 165 NEW YORK · Turnpike Exp`);
  expect(html).not.toContain('165T');
  expect(html).toContain('00302');
  expect(JSON.stringify(dep)).toBe(before);
});
