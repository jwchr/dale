import { expect, it } from 'vitest';
import { stripTimes } from '../../src/ui/StripMap';

const at = Date.UTC(2026, 10, 4, 13, 0);

it('a stop ahead of a late bus shows the expected time as an estimate over the timetable time', () => {
  expect(stripTimes({ at, estimated: false }, 600_000)).toEqual({ time: { at: at + 600_000, estimated: true }, sched: { at, estimated: false } });
});

it('a timetable time Dale estimated keeps its estimate mark on the "Sched." line', () => {
  expect(stripTimes({ at, estimated: true }, 600_000).sched).toEqual({ at, estimated: true });
  expect(stripTimes({ at, estimated: true }, -120_000).sched).toEqual({ at, estimated: true });
});

it('on schedule or already reached, there is no second line', () => {
  expect(stripTimes({ at, estimated: true }, 0)).toEqual({ time: { at, estimated: true } });
  expect(stripTimes({ at, estimated: false }, 600_000, at + 300_000)).toEqual({ time: { at: at + 300_000, estimated: false } });
});
