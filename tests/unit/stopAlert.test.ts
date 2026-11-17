import { describe, expect, it } from 'vitest';
import { ALERT_STAGES, stageMessage, stopAlertStep } from '../../src/domain/stopAlert';
import { STAGE_RANK, type RideStage } from '../../src/domain/rideGuide';
import { strings } from '../../src/ui/i18n';

describe('stop alerts (#176)', () => {
  it('opening ride mode only sets a baseline, whatever the stage', () => {
    for (const stage of [undefined, 'riding', 'three', 'two', 'one', 'request', 'arrived'] as (RideStage | undefined)[]) {
      expect(stopAlertStep(undefined, stage)).toEqual({ handled: stage ? STAGE_RANK[stage] : -1, alert: false });
    }
  });

  it('alerts once at each forward step to 3, 2, 1 and "ask now"', () => {
    let handled = stopAlertStep(undefined, 'riding').handled;
    const fired: RideStage[] = [];
    for (const stage of ['three', 'two', 'one', 'request', 'arrived'] as RideStage[]) {
      const step = stopAlertStep(handled, stage);
      handled = step.handled;
      if (step.alert) fired.push(stage);
    }
    expect(fired).toEqual(['three', 'two', 'one', 'request']);
  });

  it('GPS jitter back and forth never repeats an alert', () => {
    let handled = stopAlertStep(undefined, 'riding').handled;
    const seen = (['three', 'riding', 'three', 'two', 'three', 'two'] as RideStage[]).map((stage) => {
      const step = stopAlertStep(handled, stage);
      handled = step.handled;
      return step.alert;
    });
    expect(seen).toEqual([true, false, false, true, false, false]);
  });

  it('losing GPS never alerts, and coming back alerts only for a newer stage', () => {
    let step = stopAlertStep(stopAlertStep(undefined, 'riding').handled, 'two');
    expect(step.alert).toBe(true);
    step = stopAlertStep(step.handled, undefined);
    expect(step).toEqual({ handled: STAGE_RANK.two, alert: false });
    expect(stopAlertStep(step.handled, 'two').alert).toBe(false);
    expect(stopAlertStep(step.handled, 'one').alert).toBe(true);
  });

  it('the end of the line next is an alert; arriving or passing is not', () => {
    expect(stopAlertStep(STAGE_RANK.two, 'last_next').alert).toBe(true);
    expect(stopAlertStep(STAGE_RANK.request, 'arrived').alert).toBe(false);
    expect(stopAlertStep(STAGE_RANK.request, 'passed').alert).toBe(false);
    expect([...ALERT_STAGES].sort()).toEqual(['last_next', 'one', 'request', 'three', 'two']);
  });

  it('every alert line exists in English and Spanish and names the stop', () => {
    for (const lang of ['en', 'es'] as const) {
      const r = strings[lang].ride;
      for (const stage of ALERT_STAGES) {
        const line = stageMessage(r, stage, stage === 'three' ? 3 : stage === 'two' ? 2 : 1, 'Main St');
        expect(line).toContain('Main St');
      }
      expect(stageMessage(r, 'three', 3, 'Main St')).toBe(r.stopsTo(3, 'Main St'));
      expect(r.notifyTitle.length).toBeGreaterThan(0);
    }
  });
});
