import { useEffect, useMemo, useRef, useState } from 'react';
import { parseLiveRailBoard, railBoardAt, type LiveRailBoard, type RailBoardCode } from '../domain/railLive';

/** Live train boards from Dale's Worker, once a minute while the page is visible. Undefined while checking or off. */
export function useLiveRail(api: string | undefined, codes: RailBoardCode[], now: number, enabled: boolean) {
  const key = codes.join(',');
  const clock = useRef(now); clock.current = now;
  const [boards, setBoards] = useState<{ key: string; list: LiveRailBoard[] }>();
  useEffect(() => {
    if (!enabled || !api || !key) return;
    let stopped = false, running = false, ctl: AbortController | undefined, next: ReturnType<typeof setTimeout> | undefined;
    const list = key.split(',') as RailBoardCode[];
    const visible = () => document.visibilityState !== 'hidden';
    async function one(code: RailBoardCode, signal: AbortSignal): Promise<LiveRailBoard> {
      try {
        const url = new URL('/v1/rail', api); url.searchParams.set('station', code);
        const response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
        if (!response.ok) return { state: 'unavailable', station: code };
        return parseLiveRailBoard(await response.json(), code, clock.current);
      } catch { return { state: 'unavailable', station: code }; }
    }
    async function poll() {
      if (stopped || running || !visible()) return;
      running = true; ctl = new AbortController(); const timeout = setTimeout(() => ctl?.abort(), 12_000);
      try {
        const result = await Promise.all(list.map((code) => one(code, ctl!.signal)));
        if (!stopped && visible()) setBoards({ key, list: result });
      } finally { clearTimeout(timeout); running = false; if (!stopped && visible()) next = setTimeout(() => void poll(), 60_000); }
    }
    const onVisibility = () => { clearTimeout(next); if (!visible()) ctl?.abort(); else void poll(); };
    document.addEventListener('visibilitychange', onVisibility); void poll();
    return () => { stopped = true; clearTimeout(next); ctl?.abort(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [enabled, api, key]);
  const current = enabled && api && boards?.key === key ? boards.list : undefined;
  return useMemo(() => current?.map((b) => railBoardAt(b, now)), [current, now]);
}
