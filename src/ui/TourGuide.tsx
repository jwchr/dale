import { useId } from 'react';
import { tourPlaces } from '../data/tourPlaces';
import type { Lang, Strings } from './i18n';
import './tourGuide.css';

const dates = { en: new Intl.DateTimeFormat('en', { timeZone: 'UTC', dateStyle: 'medium' }), es: new Intl.DateTimeFormat('es', { timeZone: 'UTC', dateStyle: 'medium' }) };

export function TourGuide({ t, lang }: { t: Strings; lang: Lang }) {
  const g = t.tour;
  const id = useId();
  return <details className="card tour-guide">
    <summary>{g.open}<span>{g.area}</span></summary>
    <section aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{g.title}</h2>
      <p>{g.intro}</p>
      <p className="small muted">{g.note}</p>
      <ol className="tour-cards">
        {tourPlaces.map(place => <li key={place.id}>
          <article className="tour-card" aria-labelledby={`${id}-${place.id}`}>
            <h3 id={`${id}-${place.id}`}>{place.name[lang]}</h3>
            <div>
              <p className="small muted">{place.town} · {place.location[lang]}</p>
              <p>{place.fact[lang]}</p>
            </div>
            <footer>
              <a href={place.source.url} target="_blank" rel="noopener noreferrer">{g.source}<span className="sr-only"> · {place.name[lang]}</span></a>
              <p className="small muted">{place.source.title[lang]}<br />{g.checked}: <time dateTime={place.source.checkedAt}>{dates[lang].format(new Date(place.source.checkedAt + 'T12:00:00Z'))}</time></p>
            </footer>
          </article>
        </li>)}
      </ol>
      <p className="small muted">{g.links}</p>
    </section>
  </details>;
}
