import { parseEarlierAnswer, type EarlierAnswer, type EarlierQuery } from '../domain/earlierBuses';

const cache = new Map<string, { at: number; pending: Promise<EarlierAnswer | undefined> }>();
export function loadEarlierBuses(api: string, query: EarlierQuery): Promise<EarlierAnswer | undefined> {
  const url = `${api}/v1/earlier-buses?${new URLSearchParams({ route: query.route, stop: query.stop, direction: String(query.direction) })}`;
  const hit = cache.get(url), now = Date.now();
  if (hit && now - hit.at < 60_000) return hit.pending;
  if (cache.size > 40) cache.clear();
  const pending = (async () => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: ctl.signal });
      if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 32_000) return;
      const body = await response.text();
      return body.length <= 32_000 ? parseEarlierAnswer(JSON.parse(body), query) : undefined;
    } catch { return undefined; }
    finally { clearTimeout(timer); }
  })();
  cache.set(url, { at: now, pending });
  return pending;
}
