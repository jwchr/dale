import { gpsLost } from '../domain/alternatives';
import type { BusSession } from '../domain/busLock';
import type { Strings } from './i18n';

export function SignalWarning({ session, now, t, estimated = false }: { session: BusSession; now: number; t: Strings; estimated?: boolean }) {
  const lost = gpsLost(session, now);
  const last = session.lock.last;
  const source = session.history.find((p) => p.observedAt === last?.observedAt && p.vehicleId === last?.vehicleId)?.source;
  // Keep the live region mounted before its text changes so loss is announced.
  return <><span className="sr-only" role="status">{lost ? (source === 'demo' ? t.confidence.demoLost : t.live.missing) : ''}</span>
    {(lost || estimated) && <aside className="signal-warning" role="note" data-testid="signal-warning">
      <strong>{source === 'demo' ? (lost ? t.confidence.demoLost : t.confidence.estimated) : t.live.missing}</strong>
      {source === 'demo' && lost && estimated && <strong>{t.confidence.estimated}</strong>}
    </aside>}</>;
}
