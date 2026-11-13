import type { Dataset } from './types';
import { localYmd } from './time';

export const STOP_SCENES = ['spring-clear', 'spring-rain', 'summer-clear', 'summer-storm', 'autumn-clear', 'autumn-mist', 'winter-clear', 'winter-snow'] as const;
export type StopScene = typeof STOP_SCENES[number];
export type StopSceneChoice = 'auto' | StopScene;
export function stopSceneChoice(value: unknown): StopSceneChoice {
  return STOP_SCENES.includes(value as StopScene) ? value as StopScene : 'auto';
}

/** New Jersey's season, never a weather observation. Unknown weather uses clear artwork. */
export function resolveStopScene(choice: StopSceneChoice, now: number): StopScene | undefined {
  if (choice !== 'auto') return choice;
  if (!Number.isFinite(now) || Math.abs(now) > 8.64e15) return undefined;
  const month = Number(localYmd(now, 'America/New_York').slice(4, 6));
  return (['winter-clear', 'spring-clear', 'summer-clear', 'autumn-clear'] as const)[Math.floor(month % 12 / 3)];
}

/** Only routes with ordinary boarding and later ordinary alighting for this exact saved leg. */
export function stopSignRoutes(ds: Dataset, fromId: string, toId: string, routeIds: string[]): string[] {
  const served = new Set(ds.patterns.filter(p => {
    const from = p.stopIds.indexOf(fromId), to = p.stopIds.indexOf(toId);
    return from >= 0 && to > from && !p.noPickup?.includes(from) && !p.noDropOff?.includes(to)
      && (!routeIds.length || routeIds.includes(p.routeId));
  }).map(p => p.routeId));
  return [...new Set(ds.routes.filter(r => served.has(r.id)).map(r => r.shortName))];
}


/**
 * The stop-sign photo (D69) in source-scene pixels: scripts/stop-sign-photos.py crops each
 * scene to this box, and the app overlays text in the same coordinates.
 */
export const SIGN_VIEW = { x: 300, y: 50, width: 530, height: 1030 } as const;
/** Blank ruled rows under "Board Here For". */
export const SIGN_ROWS = 7;
const RULE_LEFT = 450, RULE_RIGHT = 677;
/** Top of ruled line k (0..7) at source column x; measured on all eight scenes within 1 px. */
function ruleY(k: number, x: number): number {
  const left = 597.5 + 20.83 * k, right = 577.6 + 22.01 * k;
  return left + (right - left) * (x - RULE_LEFT) / (RULE_RIGHT - RULE_LEFT);
}
/** Where one line of sign lettering goes, in crop coordinates: baseline start, slope and room. */
export interface SignPlacement { x: number; y: number; slope: number; maxWidth: number }
/** Row r of the route list. The photo's perspective tilts each row a little differently. */
export function signRowPlacement(row: number): SignPlacement {
  const r = Math.min(Math.max(Math.trunc(row), 0), SIGN_ROWS - 1), x = 453;
  const slope = (ruleY(r, RULE_RIGHT) - ruleY(r, RULE_LEFT)) / (RULE_RIGHT - RULE_LEFT);
  return { x: x - SIGN_VIEW.x, y: ruleY(r, x) + 16.6 - SIGN_VIEW.y, slope, maxWidth: RULE_RIGHT - 4 - x };
}
/** The stop number on the mybus plate, after "This stop #". */
export const SIGN_NUMBER: SignPlacement = { x: 602 - SIGN_VIEW.x, y: 841.6 - SIGN_VIEW.y, slope: -0.006, maxWidth: 70 };
/** Corners of ruled row r (inside its two lines), for the highlight behind the rider's own bus. */
export function signRowBand(row: number): Array<[number, number]> {
  const r = Math.min(Math.max(Math.trunc(row), 0), SIGN_ROWS - 1), left = RULE_LEFT + 1, right = RULE_RIGHT - 1;
  const at = (k: number, x: number, dy: number): [number, number] => [x - SIGN_VIEW.x, ruleY(k, x) + dy - SIGN_VIEW.y];
  return [at(r, left, 2), at(r, right, 2), at(r + 1, right, -.5), at(r + 1, left, -.5)];
}

/** One printed line of the sign's route list; `yours` marks the bus for this saved trip. */
export interface SignLine { text: string; yours: boolean }

/**
 * Every route in the loaded schedule that picks up at this stop, lettered the way the real sign
 * prints it ("164 To New York": route, then where that bus ends). Lines for buses that serve this
 * saved trip are marked `yours`. Physical sign wording stays English in both app languages. When
 * there are more lines than rows, the rider's own lines are always kept and the last row says "+N more".
 */
export function stopSignLines(ds: Dataset, fromId: string, toId: string, routeIds: string[]): SignLine[] {
  const routeName = new Map(ds.routes.map(r => [r.id, r.shortName]));
  const stops = new Map(ds.stops.map(s => [s.id, s]));
  const lines = new Map<string, SignLine & { route: string }>();
  for (const p of ds.patterns) {
    const from = p.stopIds.indexOf(fromId), lastId = p.stopIds.at(-1);
    if (from < 0 || from >= p.stopIds.length - 1 || p.noPickup?.includes(from) || !lastId) continue;
    const route = routeName.get(p.routeId), last = stops.get(lastId);
    if (!route || !last) continue;
    const text = `${route} To ${last.terminal === 'PABT' ? 'New York' : last.name}`;
    const to = p.stopIds.indexOf(toId, from + 1);
    const yours = to > from && !p.noDropOff?.includes(to) && (!routeIds.length || routeIds.includes(p.routeId));
    const line = lines.get(text) ?? { text, route, yours: false };
    line.yours ||= yours;
    lines.set(text, line);
  }
  const all = [...lines.values()].sort((a, b) => a.route.localeCompare(b.route, 'en', { numeric: true }) || a.text.localeCompare(b.text));
  if (all.length <= SIGN_ROWS) return all.map(({ text, yours }) => ({ text, yours }));
  const kept = new Set(all.filter(l => l.yours).slice(0, SIGN_ROWS - 1));
  for (const l of all) if (kept.size < SIGN_ROWS - 1) kept.add(l);
  return [...all.filter(l => kept.has(l)).map(({ text, yours }) => ({ text, yours })), { text: `+${all.length - kept.size} more`, yours: false }];
}
