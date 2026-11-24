// Saved backup plans (issue #62): the rider's own alternate routes, drop-off or pickup places and
// notes, shown on the rescue screen as their notes. Dale never checks, ranks or schedules them, and
// they stay on this phone. Order is the rider's (as with favorites, D26).

export interface BackupPlan {
  id: string;
  /** What to do, in the rider's words ("167 to Hackensack, then Sam picks me up"). */
  plan: string;
  /** Where they can be dropped off or picked up. */
  place?: string;
  /** Anything else: who to call, where to wait. */
  note?: string;
}

export const MAX_PLAN = 120;
export const MAX_PLACE = 120;
export const MAX_NOTE = 500;
export const MAX_PLANS = 20;
// Storage keys keep the app's first name (Arriba), like the others.
const KEY = 'arriba.backups.v1';

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** A plan from the form or from storage, trimmed and limited; undefined without a plan text. */
export function cleanBackupPlan(x: unknown): BackupPlan | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const p = x as Record<string, unknown>;
  const id = typeof p.id === 'string' && p.id ? p.id.slice(0, 64) : undefined;
  const plan = clip(p.plan, MAX_PLAN);
  if (!id || !plan) return undefined;
  const place = clip(p.place, MAX_PLACE);
  const note = clip(p.note, MAX_NOTE);
  return { id, plan, ...(place ? { place } : {}), ...(note ? { note } : {}) };
}

export function loadBackupPlans(storage: Pick<Storage, 'getItem'> | undefined): BackupPlan[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.map(cleanBackupPlan).filter((p): p is BackupPlan => !!p && !seen.has(p.id) && !!seen.add(p.id)).slice(0, MAX_PLANS);
  } catch { return []; }
}

export function saveBackupPlans(storage: Pick<Storage, 'setItem'> | undefined, list: BackupPlan[]): void {
  try { storage?.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable: kept for this visit only */ }
}

/** Adds a new plan at the end, or replaces the one with the same id in place. */
export function upsertBackupPlan(list: BackupPlan[], p: BackupPlan): BackupPlan[] {
  if (list.some((x) => x.id === p.id)) return list.map((x) => (x.id === p.id ? p : x));
  return list.length >= MAX_PLANS ? list : [...list, p];
}

export function removeBackupPlan(list: BackupPlan[], id: string): BackupPlan[] {
  return list.filter((x) => x.id !== id);
}
