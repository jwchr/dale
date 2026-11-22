import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { demoDataset } from '../../src/data/demo';
import { NearMe } from '../../src/ui/NearMe';
import { strings } from '../../src/ui/i18n';

export type FixtureOptions = { lang: 'en' | 'es'; hasLocations: boolean; hidden?: boolean; autoAsk?: boolean };

const root = createRoot(document.getElementById('fixture')!);

// A new dataset object on each render models a schedule refresh without remounting NearMe.
// Only the project's invented demo stops are used, never device or feed data.
export function render({ lang, hasLocations, hidden = false, autoAsk = true }: FixtureOptions) {
  const ds = { ...demoDataset, stops: hasLocations ? [...demoDataset.stops]
    : demoDataset.stops.map(({ lat: _lat, lon: _lon, ...stop }) => stop) };
  root.render(<StrictMode>
    <div hidden={hidden}><NearMe ds={ds} t={strings[lang]} onPick={() => {}} autoAsk={autoAsk} /></div>
    <label>{strings[lang].findStop}<input id="stop-search" type="search" /></label>
  </StrictMode>);
}
