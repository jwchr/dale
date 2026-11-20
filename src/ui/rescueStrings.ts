// Strings for the wider official schedule on the "Get me home" screen (#32). English and Spanish.
import type { WiderMissing } from '../data/rescueSchedule';

/** Ends a sentence once, so a time ending in "p.m." never reads "p.m..". */
const end = (text: string) => text.endsWith('.') ? text : `${text}.`;

export const rescueStrings = {
  en: {
    loading: 'Loading other routes from NJ Transit’s schedule…',
    widerIncluded: (routes: string) => `Also searched: routes that share a stop with your line (${routes}). Scheduled times only; Dale has no live tracking for these routes.`,
    savedCopy: (when: string) => `Other routes are from a copy saved at ${when}.`,
    missing: {
      not_official: 'Other routes were not searched: they come only with NJ Transit’s official schedule, not the printed timetable or the demo.',
      not_configured: 'Other routes were not searched: Dale’s server is not set up on this copy of the app.',
      not_offered: 'Other routes were not searched: Dale’s server does not offer them yet.',
      feed_mismatch: 'Other routes were not searched: the app’s schedule and the server’s schedule are different versions. Close and reopen Dale to update.',
      offline: 'Other routes were not searched: no connection, and no saved copy on this phone.',
      invalid: 'Other routes were not searched: the data did not pass Dale’s checks.',
    } satisfies Record<WiderMissing, string>,
    nearTitle: 'Stops near home (not at it)',
    near: (stop: string, meters: number) => `Gets off at ${stop}, ${meters} m from your stop in a straight line. Not a verified walk.`,
    widerTag: 'Other route · scheduled, not tracked',
    walkNote: 'Distances near home are straight lines between stops, not verified walking routes. A change of bus is suggested only at the same stop, with at least 3 minutes to make it, and only when it gets home before every direct bus.',
    transfersTitle: 'With one change of bus',
    transferRide: (stop: string, at: string) => end(`Ride to ${stop}, arrives ${at}`),
    transferChange: (route: string, at: string, wait: number) => `Change to the ${route} at ${at}, same stop (${wait} min to change).`,
  },
  es: {
    loading: 'Cargando otras rutas del horario de NJ Transit…',
    widerIncluded: (routes: string) => `También se buscaron rutas que comparten una parada con tu línea (${routes}). Solo horarios programados; Dale no sigue en vivo estas rutas.`,
    savedCopy: (when: string) => `Las otras rutas son de una copia guardada a las ${when}.`,
    missing: {
      not_official: 'No se buscaron otras rutas: solo vienen con el horario oficial de NJ Transit, no con el horario impreso ni con la demostración.',
      not_configured: 'No se buscaron otras rutas: el servidor de Dale no está configurado en esta copia de la app.',
      not_offered: 'No se buscaron otras rutas: el servidor de Dale todavía no las ofrece.',
      feed_mismatch: 'No se buscaron otras rutas: el horario de la app y el del servidor son versiones distintas. Cierra y vuelve a abrir Dale para actualizar.',
      offline: 'No se buscaron otras rutas: no hay conexión ni copia guardada en este teléfono.',
      invalid: 'No se buscaron otras rutas: los datos no pasaron las verificaciones de Dale.',
    } satisfies Record<WiderMissing, string>,
    nearTitle: 'Paradas cerca de casa (no en ella)',
    near: (stop: string, meters: number) => `Bájate en ${stop}, a ${meters} m de tu parada en línea recta. No es un camino a pie verificado.`,
    widerTag: 'Otra ruta · programada, sin seguimiento',
    walkNote: 'Las distancias cerca de casa son líneas rectas entre paradas, no caminos a pie verificados. Un transbordo se sugiere solo en la misma parada, con al menos 3 minutos para hacerlo, y solo cuando llega a casa antes que cualquier autobús directo.',
    transfersTitle: 'Con un transbordo',
    transferRide: (stop: string, at: string) => end(`Viaja hasta ${stop}, llega a las ${at}`),
    transferChange: (route: string, at: string, wait: number) => `Cambia al ${route} a las ${at}, en la misma parada (${wait} min para cambiar).`,
  },
};
export type RescueStrings = typeof rescueStrings.en;
