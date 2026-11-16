import { describe, expect, it } from 'vitest';
import { leadPadding } from '../../src/ui/leadPadding';

describe('following the bus', () => {
  it('pads the side the route heads toward, so the bus sits back from the centre', () => {
    expect(leadPadding({ x: 100, y: 100 }, { x: 100, y: 300 }, 400, 600)).toEqual({ top: 0, bottom: 300, left: 0, right: 0 });
    expect(leadPadding({ x: 100, y: 100 }, { x: 0, y: 100 }, 400, 600)).toEqual({ top: 0, bottom: 0, left: 200, right: 0 });
    const diagonal = leadPadding({ x: 0, y: 0 }, { x: 30, y: -40 }, 400, 600);
    expect(diagonal.top).toBeCloseTo(240); expect(diagonal.right).toBeCloseTo(120); expect(diagonal.bottom).toBe(0); expect(diagonal.left).toBe(0);
  });
  it('stays centred when there is no direction or no size', () => {
    const none = { top: 0, bottom: 0, left: 0, right: 0 };
    expect(leadPadding({ x: 5, y: 5 }, { x: 5, y: 5 }, 400, 600)).toEqual(none);
    expect(leadPadding({ x: 0, y: 0 }, { x: 0, y: 50 }, 0, 600)).toEqual(none);
    expect(leadPadding({ x: 0, y: 0 }, { x: NaN, y: 50 }, 400, 600)).toEqual(none);
  });
});
