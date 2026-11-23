/** A basemap metadata/archive failure leaves no geographic map to draw, even after
 * style.load. Individual tile/glyph failures can still leave a usable map. */
export function isFatalMapError(event: { error: unknown; sourceId?: string; tile?: unknown }, styleLoaded: boolean): boolean {
  if (event.sourceId === 'protomaps' && event.tile === undefined) return true;
  return !styleLoaded && event.sourceId === undefined && event.tile === undefined;
}
