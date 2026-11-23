import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { demoDataset } from '../../src/data/demo';
import { NearMe } from '../../src/ui/NearMe';
import { strings } from '../../src/ui/i18n';
import type { Dataset } from '../../src/domain/types';

export type FixtureOptions = { lang: 'en' | 'es'; hasLocations: boolean; hidden?: boolean; autoAsk?: boolean; refresh?: boolean; duplicates?: boolean };

const root = createRoot(document.getElementById('fixture')!);
let dataset: Dataset | undefined;

// A new dataset object on each render models a schedule refresh without remounting NearMe.
// Only the project's invented demo stops are used, never device or feed data.
export function render({ lang, hasLocations, hidden = false, autoAsk = true, refresh = true, duplicates = false }: FixtureOptions) {
  const ds: Dataset = !refresh && dataset ? dataset : { ...demoDataset, stops: hasLocations ? [...demoDataset.stops]
    : demoDataset.stops.map(({ lat: _lat, lon: _lon, ...stop }) => stop) };
  if (duplicates && refresh) {
    // Two platform entries of one terminal, like Port Authority's twelve entries sharing stop number 26229.
    ds.stops = ds.stops.map(s => s.id === 'D2' ? { ...s, terminal: 'PABT' as const } : s);
    ds.stops.push({ ...ds.stops.find(s => s.id === 'D2')!, id: 'D2-copy', lat: 40.87004 });
    ds.routes = [...demoDataset.routes, { id: 'R164', shortName: '164', longName: 'Invented duplicate-source route' }];
    ds.patterns = [...demoDataset.patterns, { ...demoDataset.patterns[0]!, id: 'copy', routeId: 'R164', stopIds: ['D2-copy', 'PABT'] }];
  }
  dataset = ds;
  root.render(<StrictMode>
    <div hidden={hidden}><NearMe ds={ds} t={strings[lang]} onPick={() => {}} autoAsk={autoAsk} visible={!hidden} /></div>
    <label>{strings[lang].findStop}<input id="stop-search" type="search" /></label>
  </StrictMode>);
}
