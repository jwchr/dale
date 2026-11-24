import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EarlierAnswer, EarlierQuery } from '../../src/domain/earlierBuses';

const query: EarlierQuery = { route: '165', stop: '1', direction: 0 };
const api = 'https://synthetic.test';
let load: typeof import('../../src/data/earlierBuses').loadEarlierBuses;
beforeEach(async () => {
  vi.resetModules();
  load = (await import('../../src/data/earlierBuses')).loadEarlierBuses;
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-11-04T23:59:40-05:00'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function answer(): EarlierAnswer {
  const now = Date.now();
  return { v: 1, query, generatedAt: now, coverageStart: now - 30_000, through: now, gap: false, items: [] };
}

it('shares healthy requests within the minute but refetches immediately after Eastern midnight', async () => {
  const fetcher = vi.fn(async () => Response.json(answer())); vi.stubGlobal('fetch', fetcher);
  const first = load(api, query);
  expect(load(api, query)).toBe(first);
  const old = await first;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await load(api, query)).toEqual(old);
  await vi.advanceTimersByTimeAsync(10_000);
  const next = await load(api, query);
  expect(next!.generatedAt).toBe(Date.now());
  expect(next!.generatedAt).not.toBe(old!.generatedAt);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('expires a healthy same-day response after 60 seconds', async () => {
  vi.setSystemTime(Date.parse('2026-11-04T12:00:00-05:00'));
  const fetcher = vi.fn(async () => Response.json(answer())); vi.stubGlobal('fetch', fetcher);
  await load(api, query);
  await vi.advanceTimersByTimeAsync(60_000);
  await load(api, query);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

for (const failure of ['503', 'network', 'timeout', 'malformed'] as const) it(`immediately retries after a ${failure} failure`, async () => {
  const fetcher = vi.fn().mockImplementationOnce((_url: string, init: RequestInit) => {
    if (failure === '503') return Promise.resolve(new Response('', { status: 503 }));
    if (failure === 'malformed') return Promise.resolve(Response.json({ invalid: true }));
    if (failure === 'timeout') return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(Error('synthetic timeout'))));
    return Promise.reject(Error('synthetic network failure'));
  }).mockImplementation(async () => Response.json(answer()));
  vi.stubGlobal('fetch', fetcher);
  const pending = load(api, query);
  if (failure === 'timeout') await vi.advanceTimersByTimeAsync(8000);
  expect(await pending).toBeUndefined();
  expect(await load(api, query)).toEqual(answer());
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('does not let a late failed request evict a newer healthy entry', async () => {
  vi.setSystemTime(Date.parse('2026-11-04T12:00:00-05:00'));
  let fail!: (e: Error) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
    .mockImplementation(async () => Response.json(answer()));
  vi.stubGlobal('fetch', fetcher);
  const first = load(api, query);
  await vi.advanceTimersByTimeAsync(60_000);
  const next = load(api, query); await next;
  fail(Error('synthetic late failure')); await first;
  expect(load(api, query)).toBe(next);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
