import { expect, it } from 'vitest';
import { agoEn, agoEs } from '../../src/ui/ago';
import { earlierBusStrings } from '../../src/ui/earlierBusStrings';
import { commuteBriefingStrings } from '../../src/ui/commuteBriefingStrings';

it('says minutes, then hours, then days, in both languages', () => {
  expect([0, 59, 60, 1439, 1440, 2880, 6520].map(agoEn)).toEqual(['0 min ago', '59 min ago', '1 hr ago', '23 hr ago', '1 day ago', '2 days ago', '4 days ago']);
  expect([0, 59, 60, 1439, 1440, 2880, 6520].map(agoEs)).toEqual(['hace 0 min', 'hace 59 min', 'hace 1 h', 'hace 23 h', 'hace 1 día', 'hace 2 días', 'hace 4 días']);
});
it('a schedule file four and a half days old never reads "6520 min ago" (Earlier buses and the commute briefing)', () => {
  for (const s of [earlierBusStrings, commuteBriefingStrings]) {
    expect(s.en.age(6520)).toBe('4 days ago');
    expect(s.es.age(6520)).toBe('hace 4 días');
  }
});
