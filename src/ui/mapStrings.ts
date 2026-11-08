export const mapStrings = {
  en: { views: 'Map view', street: 'Street map', transit: 'Transit map', line: 'Line diagram', close: 'Zoom to bus', route: 'Whole route', marker: 'Bus marker · approximate diagram position', schematic: 'Schematic · spacing is not distance. Major roads and towns are in Transit map.', unplaced: 'The marker cannot be placed reliably on this diagram. Use the street or transit map.', here: 'Reported here', next: 'Boarding / next stop', yours: 'Your destination', listed: (n: number) => `All ${n} listed stops`, between: (n: number) => `${n} other listed stops`,
  },
  es: { views: 'Vista del mapa', street: 'Calles', transit: 'Mapa de transporte', line: 'Diagrama de línea', close: 'Acercar al autobús', route: 'Toda la ruta', marker: 'Autobús · posición aproximada en el diagrama', schematic: 'Esquema · la separación no representa distancia. Consulta calles principales y ciudades en Mapa de transporte.', unplaced: 'No se puede colocar el marcador con confianza en este diagrama. Usa el mapa de calles o transporte.', here: 'Posición reportada aquí', next: 'Subida / próxima parada', yours: 'Tu destino', listed: (n: number) => `Las ${n} paradas indicadas`, between: (n: number) => `${n} otras paradas indicadas`,
  },
};
export type MapStrings = typeof mapStrings.en;
