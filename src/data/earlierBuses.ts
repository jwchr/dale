import { parseEarlierAnswer, type EarlierAnswer, type EarlierQuery } from '../domain/earlierBuses';
import { localYmd } from '../domain/time';

const cache = new Map<string, { at: number; pending: Promise<EarlierAnswer | undefined> }>();
export function loadEarlierBuses(api: string, query: EarlierQuery, day = localYmd(Date.now(), 'America/New_York')): Promise<EarlierAnswer | undefined> {
  const url = `${api}/v1/earlier-buses?${new URLSearchParams({ route: query.route, stop: query.stop, direction: String(query.direction) })}`;
  const key = `${day}|${url}`, hit = cache.get(key), now = Date.now();
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
  cache.set(key, { at: now, pending });
  void pending.then(result => {
    // An older failed request must not evict a newer in-flight replacement.
    if (!result && cache.get(key)?.pending === pending) cache.delete(key);
  });
  return pending;
}
