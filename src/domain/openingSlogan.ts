export const OPENING_SLOGAN_KEY = 'arriba.openingSlogan.v1';
type SloganStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

/** Pick once at a fresh page start. Storage holds only the last public slogan index. */
export function chooseOpeningSlogan(storage: SloganStorage | undefined, count: number, random = Math.random): number {
  if (!Number.isSafeInteger(count) || count < 2 || count > 100) return 0;
  let previous: number | undefined;
  try {
    const raw = storage?.getItem(OPENING_SLOGAN_KEY);
    if (raw && /^(0|[1-9][0-9]*)$/.test(raw) && Number(raw) < count) previous = Number(raw);
  } catch { /* A blocked preference never prevents showing departures. */ }
  let sample = 0;
  try { sample = random(); } catch { /* Deterministic first choice if randomness is unavailable. */ }
  const value = Number.isFinite(sample) && sample >= 0 && sample < 1 ? sample : 0;
  const slot = Math.floor(value * (previous === undefined ? count : count - 1));
  const chosen = previous !== undefined && slot >= previous ? slot + 1 : slot;
  try { storage?.setItem(OPENING_SLOGAN_KEY, String(chosen)); } catch { /* The choice still lasts for this page. */ }
  return chosen;
}
