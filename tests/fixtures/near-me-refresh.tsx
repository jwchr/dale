import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { demoDataset } from '../../src/data/demo';
import { NearMe } from '../../src/ui/NearMe';
import { strings } from '../../src/ui/i18n';
import type { Dataset } from '../../src/domain/types';

export type FixtureOptions = { lang: 'en' | 'es'; hasLocations: boolean; hidden?: boolean; autoAsk?: boolean; refresh?: boolean };

const root = createRoot(document.getElementById('fixture')!);
let dataset: Dataset | undefined;

// A new dataset object on each render models a schedule refresh without remounting NearMe.
// Only the project's invented demo stops are used, never device or feed data.
export function render({ lang, hasLocations, hidden = false, autoAsk = true, refresh = true }: FixtureOptions) {
  const ds = !refresh && dataset ? dataset : { ...demoDataset, stops: hasLocations ? [...demoDataset.stops]
    : demoDataset.stops.map(({ lat: _lat, lon: _lon, ...stop }) => stop) };
  dataset = ds;
  root.render(<StrictMode>
    <div hidden={hidden}><NearMe ds={ds} t={strings[lang]} onPick={() => {}} autoAsk={autoAsk} visible={!hidden} /></div>
    <label>{strings[lang].findStop}<input id="stop-search" type="search" /></label>
  </StrictMode>);
}
