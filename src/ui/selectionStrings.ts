export const selectionStrings = {
  en: { about: 'About live data', towards: 'Toward', stopNumber: (code: string) => `Stop #${code}`, numberUnknown: 'Stop number not supplied', noBoarding: 'No boarding route is listed here.',
    cities: 'Other destinations by city', unknownCity: 'Other stops · city not supplied', save: 'Save trip', selected: 'Selected destination', choose: 'Choose a destination before saving.', change: 'Choose another boarding stop', citySource: 'City labels: NJ Transit GIS Department; retrieved',
  },
  es: { about: 'Sobre los datos en vivo', towards: 'Hacia', stopNumber: (code: string) => `Parada #${code}`, numberUnknown: 'No se proporcionó el número de parada', noBoarding: 'No hay una ruta de subida indicada aquí.',
    cities: 'Otros destinos por ciudad', unknownCity: 'Otras paradas · ciudad no indicada', save: 'Guardar viaje', selected: 'Destino elegido', choose: 'Elige un destino antes de guardar.', change: 'Elegir otra parada de salida', citySource: 'Ciudades: Departamento GIS de NJ Transit; consultado',
  },
};
