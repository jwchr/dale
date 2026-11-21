export const earlierBusStrings = {
  en: {
    title: 'Earlier buses today', loading: 'Checking earlier buses…', unavailable: 'Earlier bus history is unavailable right now.',
    empty: 'No earlier buses confirmed passing this stop in the available history.', atStop: 'Your stop', terminal: 'Port Authority',
    scheduled: 'Scheduled', actual: 'Exact actual time', observed: 'Observed stop sample', expected: 'Expected', scheduleSource: 'NJ Transit schedule', unknown: 'Unknown', gps: 'NJ Transit GPS · first stopped sample', prediction: 'NJ Transit prediction',
    explain: 'GPS is the first reported stop sample, not the exact arrival instant. Predictions are estimates. Missing reports never mean cancelled.',
    coverage: 'History available from', through: 'Checked through', gap: 'There are gaps in this history.',
    late: (n: number) => n === 0 ? 'On time' : n > 0 ? `${n} min late` : `${-n} min early`,
    age: (n: number) => `${n} min ago`, details: 'Times and sources',
  },
  es: {
    title: 'Autobuses anteriores de hoy', loading: 'Consultando autobuses anteriores…', unavailable: 'El historial no está disponible en este momento.',
    empty: 'No hay autobuses anteriores confirmados después de esta parada en el historial disponible.', atStop: 'Tu parada', terminal: 'Port Authority',
    scheduled: 'Programado', actual: 'Hora real exacta', observed: 'Muestra observada en parada', expected: 'Previsto', scheduleSource: 'Horario de NJ Transit', unknown: 'Desconocido', gps: 'GPS de NJ Transit · primera muestra detenido', prediction: 'Predicción de NJ Transit',
    explain: 'El GPS indica la primera muestra en la parada, no el instante exacto de llegada. Las predicciones son estimaciones. La falta de informes nunca significa cancelado.',
    coverage: 'Historial disponible desde', through: 'Consultado hasta', gap: 'Hay intervalos sin datos en este historial.',
    late: (n: number) => n === 0 ? 'A tiempo' : n > 0 ? `${n} min de retraso` : `${-n} min antes`,
    age: (n: number) => `hace ${n} min`, details: 'Horas y fuentes',
  },
};
