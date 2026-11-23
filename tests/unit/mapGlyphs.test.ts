import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addProtocol, removeProtocol } from 'maplibre-gl';
import { mapGlyphs } from '../../src/ui/mapGlyphs';

vi.mock('maplibre-gl', () => ({ addProtocol: vi.fn(), removeProtocol: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const count = vi.fn(), glyphs = mapGlyphs('https://example.invalid/dale/', count);
  const [protocol, load] = vi.mocked(addProtocol).mock.calls.at(-1)!;
  const request = { url: glyphs.url.replace('{fontstack}', 'Noto Sans Medium').replace('{range}', '0-255') };
  return { count, glyphs, protocol, load, request };
}

it('loads the same first-party glyph bytes and forwards request cancellation', async () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const fetcher = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes });
  vi.stubGlobal('fetch', fetcher);
  const { count, glyphs, load, request } = setup(), controller = new AbortController();
  expect((await load(request, controller)).data).toBe(bytes);
  expect(fetcher).toHaveBeenCalledWith('https://example.invalid/dale/map/fonts/Noto Sans Medium/0-255.pbf', { signal: controller.signal });
  expect(count).not.toHaveBeenCalled();
  glyphs.dispose();
});

for (const failure of ['http', 'network', 'body'] as const) it(`counts a ${failure} failure once without exposing its details`, async () => {
  const detail = new Error('Private request detail');
  const fetcher = failure === 'network' ? vi.fn().mockRejectedValue(detail)
    : vi.fn().mockResolvedValue({ ok: failure !== 'http', arrayBuffer: async () => { throw detail; } });
  vi.stubGlobal('fetch', fetcher);
  const { count, glyphs, load, request } = setup();
  const error = await load(request, new AbortController()).catch(error => error as Error);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error('Expected a glyph failure');
  expect(error.message).toBe('Map font unavailable');
  expect(error.cause).toBeUndefined();
  expect(count).toHaveBeenCalledExactlyOnceWith();
  glyphs.dispose();
});

it('preserves AbortError for an already cancelled glyph request without counting a failure', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));
  const { count, glyphs, load, request } = setup(), controller = new AbortController();
  controller.abort();
  await expect(load(request, controller)).rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' });
  expect(count).not.toHaveBeenCalled();
  glyphs.dispose();
});

for (const phase of ['fetch', 'body'] as const) it(`preserves AbortError when cancelled during ${phase}, without exposing the abort reason`, async () => {
  const { count, glyphs, load, request } = setup(), controller = new AbortController();
  let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
    const pending = () => new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      ready();
    });
    if (phase === 'fetch') return pending();
    return { ok: true, arrayBuffer: pending };
  }));
  const pending = load(request, controller);
  await waiting;
  controller.abort(new Error('Private request detail'));
  const error = await pending.catch(error => error);
  expect(error).toBeInstanceOf(DOMException);
  expect(error).toMatchObject({ name: 'AbortError', message: 'Aborted' });
  expect(error.cause).toBeUndefined();
  expect(String(error)).not.toContain('Private request detail');
  expect(String(error)).not.toContain('example.invalid');
  expect(count).not.toHaveBeenCalled();
  glyphs.dispose();
});

it('keeps maps isolated and ignores late failures after disposal', async () => {
  let rejectRequest!: (error: Error) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise((_, reject) => { rejectRequest = reject; })));
  const first = setup(), second = setup();
  expect(first.protocol).not.toBe(second.protocol);
  const pending = first.load(first.request, new AbortController());
  first.glyphs.dispose();
  expect(removeProtocol).toHaveBeenCalledExactlyOnceWith(first.protocol);
  rejectRequest(new Error('Late network error'));
  await expect(pending).rejects.toThrow('Map font unavailable');
  expect(first.count).not.toHaveBeenCalled();
  expect(second.count).not.toHaveBeenCalled();
  second.glyphs.dispose();
});
