import { describe, expect, it } from 'vitest';
import { liveStrings } from '../../src/ui/liveStrings';

describe('live age strings', () => {
  it('use the singular for one second in English and Spanish', () => {
    expect(liveStrings.en.age(1)).toBe('Last bus report: 1 second ago');
    expect(liveStrings.en.predictionAge(1)).toBe('Prediction updated 1 second ago');
    expect(liveStrings.es.age(1)).toBe('Último reporte del autobús: hace 1 segundo');
    expect(liveStrings.es.predictionAge(1)).toBe('Predicción actualizada hace 1 segundo');
    expect(liveStrings.en.age(5)).toBe('Last bus report: 5 seconds ago');
    expect(liveStrings.es.age(0)).toBe('Último reporte del autobús: hace 0 segundos');
  });
  it('give cancelled and skipped reports an age in both languages', () => {
    expect(liveStrings.en.rows.reportAge(20)).toBe('NJ Transit report 20s ago');
    expect(liveStrings.es.rows.reportAge(20)).toBe('Reporte de NJ Transit hace 20s');
  });
});
