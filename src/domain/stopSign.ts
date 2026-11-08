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

