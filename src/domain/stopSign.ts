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
export const SIGN_VIEW = { x: 395, y: 85, width: 340, height: 860 } as const;
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
/**
 * Lettering for the route rows, in the sign's own printed style ("164 To New York").
 * Physical sign wording stays English in both app languages. More routes than rows end in "+N more".
 */
export function signRowTexts(routes: string[], destination: string): string[] {
  const lines = routes.map(route => `${route} To ${destination}`);
  return lines.length <= SIGN_ROWS ? lines : [...lines.slice(0, SIGN_ROWS - 1), `+${lines.length - SIGN_ROWS + 1} more`];
}
