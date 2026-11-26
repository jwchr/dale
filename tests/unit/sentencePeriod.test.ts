import { describe, expect, it } from 'vitest';
import { strings } from '../../src/ui/i18n';

// A Spanish time ("8:50 a. m.") or a stop name ("Irvington St.") at the end of a sentence must not print "..".
const TIME = '8:50 a. m.', STOP = 'Irvington St.';
const doubled = /\.\.(?=\s|$)/;

function messages(node: unknown, path: string, out: [string, (...a: unknown[]) => unknown][] = []) {
  if (typeof node === 'function') out.push([path, node as (...a: unknown[]) => unknown]);
  else if (node && typeof node === 'object' && !Array.isArray(node)) for (const [k, v] of Object.entries(node)) messages(v, `${path}.${k}`, out);
  return out;
}

describe('one period at the end of a sentence', () => {
  it('reads right in the examples riders see', () => {
    expect(strings.es.boarding.notServed(STOP)).toBe('Este viaje programado no incluye Irvington St. Elige otro viaje o pregúntale al chofer.');
    expect(strings.en.boarding.notServed(STOP)).toBe('This scheduled trip does not list Irvington St. Pick another trip or ask the driver.');
    expect(strings.es.boarding.serves('Lodi', TIME)).toBe('Este viaje programado se detiene en Lodi, a las 8:50 a. m.');
  });
  it('never prints ".." for any message in either language', () => {
    for (const lang of ['en', 'es'] as const) {
      const bad: string[] = [];
      for (const [path, fn] of messages(strings[lang], lang)) {
        for (const args of [[TIME], [STOP], [STOP, TIME], [TIME, TIME], ['165', TIME, STOP]]) {
          let text: unknown; try { text = fn(...args); } catch { continue; }
          if (typeof text === 'string' && doubled.test(text)) bad.push(`${path}: ${text}`);
        }
      }
      expect(bad).toEqual([]);
    }
  });
});
