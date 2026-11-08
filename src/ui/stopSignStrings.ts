export const stopSignStrings = {
  en: {
    open: 'See stop sign', title: 'Your boarding stop', stop: 'STOP', routes: 'Routes for this trip',
    unknownRoutes: 'No boarding route confirmed for this destination.',
    note: 'Match the number and direction on the real sign. These routes are in the loaded schedule; check departures for when they run.',
    illustration: 'Seasonal illustration — not a photo of this stop or current weather.',
    artwork: 'Picture style', automatic: 'Automatic season',
    automaticNote: 'Automatic follows the season in New Jersey. Weather data is not connected.',
    failed: 'Picture unavailable. Your stop details are still shown.',
    more: (n: number) => `+${n} more`,
    scenes: {
      'spring-clear': 'Spring · clear', 'spring-rain': 'Spring · rain',
      'summer-clear': 'Summer · clear', 'summer-storm': 'Summer · storm',
      'autumn-clear': 'Autumn · clear', 'autumn-mist': 'Autumn · mist',
      'winter-clear': 'Winter · clear', 'winter-snow': 'Winter · snow',
    },
  },
  es: {
    open: 'Ver señal de parada', title: 'Tu parada de salida', stop: 'PARADA', routes: 'Rutas para este viaje',
    unknownRoutes: 'No hay una ruta de salida confirmada para este destino.',
    note: 'Comprueba el número y la dirección en la señal real. Estas rutas aparecen en el horario cargado; consulta las salidas para saber cuándo pasan.',
    illustration: 'Ilustración de temporada — no es una foto de esta parada ni del tiempo actual.',
    artwork: 'Estilo de imagen', automatic: 'Automática',
    automaticNote: 'La opción automática sigue la estación del año en Nueva Jersey. No hay datos meteorológicos conectados.',
    failed: 'Imagen no disponible. Los datos de tu parada siguen visibles.',
    more: (n: number) => `+${n} más`,
    scenes: {
      'spring-clear': 'Primavera · despejado', 'spring-rain': 'Primavera · lluvia',
      'summer-clear': 'Verano · despejado', 'summer-storm': 'Verano · tormenta',
      'autumn-clear': 'Otoño · despejado', 'autumn-mist': 'Otoño · niebla',
      'winter-clear': 'Invierno · despejado', 'winter-snow': 'Invierno · nieve',
    },
  },
};
