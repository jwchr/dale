// Stop alerts (issue #176): when the ride countdown moves forward, which alert to give.
// Pure rules only; the screen, sound, speech and notification code lives in src/ui.
import { STAGE_RANK, type RideStage } from './rideGuide';

/** Stages that alert the rider: 3, 2 and 1 stops to go (or the end of the line next), and "ask now". */
export const ALERT_STAGES: readonly RideStage[] = ['three', 'two', 'one', 'last_next', 'request'];

/**
 * Decide whether a newly computed stage alerts. `before` is the highest rank already handled for this
 * ride (undefined when ride mode has just opened). The stage showing when the view opens is only a
 * baseline, so opening the view never alerts. When it opens without GPS (rank -1), the first GPS stage
 * that arrives later is a countdown the rider has not been told yet, so it alerts; afterwards an alert fires once per forward step into an alerting stage, and
 * GPS jitter that moves the stage back and forth never repeats one.
 */
export function stopAlertStep(before: number | undefined, stage: RideStage | undefined): { handled: number; alert: boolean } {
  const rank = stage ? STAGE_RANK[stage] : -1;
  if (before === undefined) return { handled: rank, alert: false };
  if (rank <= before) return { handled: before, alert: false };
  return { handled: rank, alert: stage !== undefined && ALERT_STAGES.includes(stage) };
}

export interface StageText {
  stopsTo: (n: number, stop: string) => string;
  one: (stop: string) => string;
  request: (stop: string) => string;
  lastNext: (stop: string) => string;
  arrived: (stop: string) => string;
  passed: (stop: string) => string;
}

/** The words for a counted stage: the same line is shown, spoken and used for the notification. */
export function stageMessage(r: StageText, stage: RideStage, stopsAway: number, stop: string): string {
  switch (stage) {
    case 'arrived': return r.arrived(stop);
    case 'passed': return r.passed(stop);
    case 'request': return r.request(stop);
    case 'last_next': return r.lastNext(stop);
    case 'one': return r.one(stop);
    default: return r.stopsTo(stopsAway, stop);
  }
}
