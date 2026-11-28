// Backup deadlines while waiting (issue #59): once the locked bus is late past the rider's chosen
// threshold, it passed them by, or NJ Transit cancelled it, list the scheduled alternatives and how long until each leaves.
// It offers a choice only; the Bus Lock never switches buses (src/domain/lock.ts). Schedule only:
// Dale has no walking data, so time to cross the street or reach another gate is the rider's to add.
import type { BusSession } from './busLock';
import { rescueOptions, type RescueOption } from './rescue';
import type { Dataset } from './types';

export const LATE_CHOICES = [5, 10, 15] as const;
export type LateChoice = (typeof LATE_CHOICES)[number];
export const DEFAULT_LATE: LateChoice = 10;
/** How far ahead backups are looked for. */
export const BACKUP_HORIZON_MS = 2 * 3600_000;
export const MAX_BACKUPS = 4;

export interface BackupDeadline {
  option: RescueOption;
  /** Whole minutes until it leaves, rounded down; 0 means it is due now. */
  minutesLeft: number;
}

export type BackupState =
  /** Not waiting, not late enough yet, or no destination to search to. */
  | { show: false }
  | { show: true; reason: 'late' | 'passed' | 'cancelled'; lateMin: number; backups: BackupDeadline[] };

/**
 * Scheduled alternatives from the rider's stop (or across the street) to where they get off (or
 * across from it), excluding the locked trip and anything already gone, soonest departure first.
 */
export function backupDeadlines(ds: Dataset, session: BusSession, alightIndex: number, now: number, lateAfterMin: number): BackupState {
  const dep = session.departure;
  if (dep.stopIndex === null || !['waiting', 'passed'].includes(session.phase) || session.lock.status === 'ended') return { show: false };
  if (!(alightIndex > dep.stopIndex) || alightIndex >= dep.pattern.stopIds.length) return { show: false };
  const passed = session.phase === 'passed' || session.reports.some((r) => r.kind === 'passed_without_stopping' && r.stopIndex === dep.stopIndex);
  // Only NJ Transit's own cancellation counts; a bus that stops reporting is just late (never "cancelled").
  const cancelled = session.lock.status === 'cancelled';
  const lateMin = Math.max(0, Math.floor((now - dep.departs) / 60_000));
  if (!passed && !cancelled && (now < dep.departs || lateMin < lateAfterMin)) return { show: false };
  const from = dep.pattern.stopIds[dep.stopIndex]!;
  const to = dep.pattern.stopIds[alightIndex]!;
  // rescueOptions ranks by arrival; take them all and rank by departure here, so a slow trip that
  // leaves soon is never cut before a faster later one.
  const found = rescueOptions(ds, from, to, now, dep.route.id, Number.POSITIVE_INFINITY, BACKUP_HORIZON_MS).options;
  const backups = found
    .filter((o) => o.dep.tripInstanceId !== dep.tripInstanceId && o.dep.departs >= now && o.dep.departs <= now + BACKUP_HORIZON_MS)
    .sort((a, b) => a.dep.departs - b.dep.departs || a.arrives - b.arrives)
    .slice(0, MAX_BACKUPS)
    .map((option) => ({ option, minutesLeft: Math.floor((option.dep.departs - now) / 60_000) }));
  return { show: true, reason: cancelled ? 'cancelled' : passed ? 'passed' : 'late', lateMin, backups };
}
