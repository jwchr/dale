import { describe, expect, it } from 'vitest';
import { chooseOpeningSlogan, OPENING_SLOGAN_KEY } from '../../src/domain/openingSlogan';
import { openingSloganStrings } from '../../src/ui/openingSloganStrings';

describe('one optional slogan per fresh start', () => {
  it('preserves the eight exact owner candidates and a Spanish equivalent for each', () => {
    expect(openingSloganStrings.en.candidates).toEqual([
      'Transit, but simple', 'Public transit, but simple', 'Not NJ Transit, your transit',
      'Transit that makes sense', 'Making transit make sense', 'Making public transit make sense',
      'Making NJ Transit make sense', 'Making NJ Transit make more sense',
    ]);
    expect(openingSloganStrings.es.candidates).toHaveLength(8);
    expect(openingSloganStrings.es.candidates.every(s => s.length > 0)).toBe(true);
  });
  it('never repeats the last choice when its preference is readable, across every choice', () => {
    for (let previous = 0; previous < 9; previous++) {
      const next = new Set<number>();
      for (let slot = 0; slot < 8; slot++) {
        const writes: [string, string][] = [];
        const chosen = chooseOpeningSlogan({ getItem: () => String(previous), setItem: (k, v) => { writes.push([k, v]); } }, 9, () => (slot + .5) / 8);
        expect(chosen).not.toBe(previous); expect(chosen).toBeGreaterThanOrEqual(0); expect(chosen).toBeLessThan(9);
        expect(writes).toEqual([[OPENING_SLOGAN_KEY, String(chosen)]]);
        next.add(chosen);
      }
      expect(next.size).toBe(8);
    }
  });
  it.each(['bad', '-1', '9', '01', '', '9007199254740993'])('ignores malformed last-choice preference %j', raw => {
    const chosen = chooseOpeningSlogan({ getItem: () => raw, setItem: () => {} }, 9, () => .99);
    expect(chosen).toBe(8);
  });
  it('works without storage or randomness and ignores invalid random results', () => {
    for (const value of [NaN, Infinity, -1, 1]) expect(chooseOpeningSlogan(undefined, 9, () => value)).toBe(0);
    expect(chooseOpeningSlogan(undefined, 9, () => { throw Error('unavailable'); })).toBe(0);
    expect(chooseOpeningSlogan({ getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } }, 9, () => .5)).toBe(4);
    expect(chooseOpeningSlogan(undefined, 1)).toBe(0);
  });
});
