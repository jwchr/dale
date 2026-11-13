export const stopSignStrings = {
  en: {
    open: 'See bus stop sign', yourBus: 'Your bus', title: 'Your boarding stop', stop: 'STOP', routes: 'Buses boarding here',
    unknownRoutes: 'No Dale buses in the loaded schedule board at this stop.',
    note: 'Match the number and direction on the real sign. These routes are in the loaded schedule; check departures for when they run.',
    illustration: 'A real NJ Transit stop sign, pictured by season. Dale writes in your stop number and the Dale routes that board here, and highlights your bus. The real sign may list more routes, and the weather is not live.',
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
    open: 'Ver letrero de la parada', yourBus: 'Tu autobús', title: 'Tu parada de salida', stop: 'PARADA', routes: 'Autobuses que salen de aquí',
    unknownRoutes: 'Ningún autobús de Dale en el horario cargado sale de esta parada.',
    note: 'Comprueba el número y la dirección en la señal real. Estas rutas aparecen en el horario cargado; consulta las salidas para saber cuándo pasan.',
    illustration: 'Una señal real de parada de NJ Transit, según la estación. Dale escribe el número de tu parada y las rutas de Dale que salen de aquí, y resalta tu autobús. La señal real puede tener más rutas y el tiempo no es en vivo.',
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
