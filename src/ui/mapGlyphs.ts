import { addProtocol, removeProtocol } from 'maplibre-gl';

let nextProtocol = 0;

/** Observe glyph HTTP/network failures that MapLibre handles by drawing locally.
 * Each map owns its handler and keeps only a count, never request/error details. */
export function mapGlyphs(base: string, countFailure: () => void) {
  const protocol = `dale-glyphs-${++nextProtocol}`, prefix = `${protocol}://`;
  let active = true;
  addProtocol(protocol, async (request, controller) => {
    try {
      const response = await fetch(request.url.slice(prefix.length), { signal: controller.signal });
      if (!response.ok) throw new Error('Map font unavailable');
      return { data: await response.arrayBuffer() };
    } catch {
      if (active && !controller.signal.aborted) countFailure();
      // MapLibre may warn with this error. Do not attach the URL or original cause.
      throw new Error('Map font unavailable');
    }
  });
  return {
    url: `${prefix}${base}map/fonts/{fontstack}/{range}.pbf`,
    dispose: () => { active = false; removeProtocol(protocol); },
  };
}
