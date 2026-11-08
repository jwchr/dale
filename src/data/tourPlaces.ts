/** Manually verified public places around the household's Hackensack corridor.
 * These are a reading catalog, not GPS triggers, walking directions or bus sightings. */
type Bilingual = { en: string; es: string };
export interface TourPlace {
  id: string;
  town: string;
  name: Bilingual;
  location: Bilingual;
  fact: Bilingual;
  source: { title: Bilingual; url: string; checkedAt: string };
}

export const tourPlaces: readonly TourPlace[] = [
  {
    id: 'hackensack-green', town: 'Hackensack', name: { en: 'The Green', es: 'The Green' },
    location: { en: 'Main Street, north of the courthouse', es: 'Main Street, al norte del palacio de justicia' },
    fact: {
      en: 'Washington’s soldiers camped on the Green during the November 1776 retreat across New Jersey. This downtown square also served as a militia training ground in the 1700s.',
      es: 'Los soldados de Washington acamparon en The Green durante la retirada por Nueva Jersey en noviembre de 1776. Esta plaza del centro también fue un lugar de entrenamiento de milicias en el siglo XVIII.',
    },
    source: {
      title: { en: 'Bergen County · Revolutionary War sites', es: 'Condado de Bergen · Sitios de la Guerra de Independencia' },
      url: 'https://bergencountynj.gov/tourism/discovering-history/revolutionary-war-sites-in-bergen-county/', checkedAt: '2026-11-07',
    },
  },
  {
    id: 'bergen-courthouse', town: 'Hackensack',
    name: { en: 'Bergen County Courthouse', es: 'Palacio de Justicia del Condado de Bergen' },
    location: { en: '10 Main Street', es: '10 Main Street' },
    fact: {
      en: 'Completed in 1912, this courthouse brings Roman and Italian Renaissance influences to Main Street. Architect James Riely Gordon used marble and bronze in its Beaux-Arts design.',
      es: 'Terminado en 1912, este palacio de justicia lleva influencias romanas y del Renacimiento italiano a Main Street. El arquitecto James Riely Gordon utilizó mármol y bronce en su diseño Beaux-Arts.',
    },
    source: {
      title: { en: 'Bergen County · Cultural and historic sites', es: 'Condado de Bergen · Sitios culturales e históricos' },
      url: 'https://bergencountynj.gov/tourism/discovering-history/cultural-and-historic-sites/', checkedAt: '2026-11-07',
    },
  },
  {
    id: 'church-on-the-green', town: 'Hackensack',
    name: { en: 'Church on the Green', es: 'Church on the Green' },
    location: { en: '42 Court Street · First Reformed Church', es: '42 Court Street · First Reformed Church' },
    fact: {
      en: 'A New York connection in Hackensack: Revolutionary War general Enoch Poor and former New York City mayor Richard Varick are both buried in this church’s cemetery.',
      es: 'Una conexión con Nueva York en Hackensack: el general de la Guerra de Independencia Enoch Poor y Richard Varick, antiguo alcalde de Nueva York, están enterrados en el cementerio de esta iglesia.',
    },
    source: {
      title: { en: 'National Register of Historic Places · Record (PDF)', es: 'Registro Nacional de Lugares Históricos · Documento (PDF)' },
      url: 'https://npgallery.nps.gov/GetAsset/0c05460d-9030-4c0d-9dd2-2ff0643ad6d5#page=10', checkedAt: '2026-11-07',
    },
  },
];
