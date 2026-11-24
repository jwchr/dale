import { describe, expect, it } from 'vitest';
import { cleanBackupPlan, loadBackupPlans, MAX_NOTE, MAX_PLANS, removeBackupPlan, saveBackupPlans, upsertBackupPlan } from '../../src/domain/backupPlans';
import { strings } from '../../src/ui/i18n';

describe('saved backup plans (issue #62)', () => {
  it('trims, limits and requires the plan text', () => {
    expect(cleanBackupPlan({ id: 'a', plan: '  167 to Hackensack ', place: ' ', note: 'Call Sam' })).toEqual({ id: 'a', plan: '167 to Hackensack', note: 'Call Sam' });
    expect(cleanBackupPlan({ id: 'a', plan: '   ' })).toBeUndefined();
    expect(cleanBackupPlan({ plan: 'no id' })).toBeUndefined();
    expect(cleanBackupPlan({ id: 'a', plan: 'x', note: 'n'.repeat(MAX_NOTE + 50) })!.note).toHaveLength(MAX_NOTE);
  });

  it('keeps the rider order, edits in place, and removes', () => {
    let l = upsertBackupPlan([], { id: 'a', plan: 'A' });
    l = upsertBackupPlan(l, { id: 'b', plan: 'B' });
    l = upsertBackupPlan(l, { id: 'a', plan: 'A2' });
    expect(l.map((p) => p.plan)).toEqual(['A2', 'B']);
    expect(removeBackupPlan(l, 'a')).toEqual([{ id: 'b', plan: 'B' }]);
    const full = Array.from({ length: MAX_PLANS }, (_, i) => ({ id: `p${i}`, plan: 'x' }));
    expect(upsertBackupPlan(full, { id: 'new', plan: 'y' })).toHaveLength(MAX_PLANS);
  });

  it('survives damaged or missing storage', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(loadBackupPlans(store)).toEqual([]);
    saveBackupPlans(store, [{ id: 'a', plan: 'A' }]);
    expect(loadBackupPlans(store)).toEqual([{ id: 'a', plan: 'A' }]);
    mem.set('arriba.backups.v1', JSON.stringify([{ id: 'a', plan: 'A' }, { id: 'a', plan: 'dup' }, { plan: 'no id' }, 7, null]));
    expect(loadBackupPlans(store)).toEqual([{ id: 'a', plan: 'A' }]);
    mem.set('arriba.backups.v1', '{not json');
    expect(loadBackupPlans(store)).toEqual([]);
    expect(loadBackupPlans({ getItem: () => { throw new Error('blocked'); } })).toEqual([]);
    expect(() => saveBackupPlans({ setItem: () => { throw new Error('full'); } }, [])).not.toThrow();
  });

  it('has every string in both languages', () => {
    expect(Object.keys(strings.es.backups).sort()).toEqual(Object.keys(strings.en.backups).sort());
  });
});
