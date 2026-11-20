import { confidenceQueryString, parseConfidenceAnswer, type ConfidenceAnswer, type ConfidenceKey } from '../domain/arrivalConfidence';

/** `off`: the Worker does not offer public counts (404). `unavailable`: no answer or one that failed the strict check. */
export type ConfidenceResult = { state: 'answer'; answer: ConfidenceAnswer; fetchedAt: number } | { state: 'off' } | { state: 'unavailable' };

const TIMEOUT_MS = 8000, KEEP_MS = 10 * 60 * 1000;
const kept = new Map<string, { at: number; result: ConfidenceResult }>();

/** Read-only and aggregate-only: one GET, no credentials, kept in memory for the Worker's own 10-minute cache time. */
export async function loadArrivalConfidence(api: string, key: ConfidenceKey, now = Date.now()): Promise<ConfidenceResult> {
  const url = `${api}/v1/arrival-confidence?${confidenceQueryString(key)}`;
  const hit = kept.get(url);
  if (hit && now - hit.at < KEEP_MS) return hit.result;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let result: ConfidenceResult = { state: 'unavailable' };
  try {
    const response = await fetch(url, { signal: ctl.signal, credentials: 'omit', redirect: 'error' });
    if (response.status === 404) result = { state: 'off' };
    else if (response.ok) {
      const answer = parseConfidenceAnswer(await response.json(), key);
      if (answer) result = { state: 'answer', answer, fetchedAt: now };
    }
  } catch { /* Timeouts and network errors stay "unavailable"; nothing is guessed. */ }
  finally { clearTimeout(timer); }
  if (result.state !== 'unavailable') kept.set(url, { at: now, result });
  return result;
}

export const clearArrivalConfidenceCache = () => kept.clear();
