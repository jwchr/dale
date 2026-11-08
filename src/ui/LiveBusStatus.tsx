import { LiveIndicator } from './LiveIndicator';
import { LIVE_MAX_AGE_MS, type LiveBusSnapshot } from '../domain/liveBus';
import type { Departure } from '../domain/types';
import type { Strings, Lang } from './i18n';
import { localYmd, formatTime12 } from '../domain/time';
import type { LiveRequestState } from './useLiveBus';
export function LiveBusStatus({ state, snapshot, dep, now, t, lang, tz, lockStatus, skippedKnown, hasStopChanges }: { state: LiveRequestState; snapshot?: LiveBusSnapshot; dep: Departure; now: number; t: Strings; lang: Lang; tz: string; lockStatus: string; skippedKnown?: boolean; hasStopChanges?: boolean }) {
  const l = t.live;
  const newest = snapshot?.observations.filter((o) => o.tripInstanceId === dep.tripInstanceId).sort((a, b) => b.observedAt - a.observedAt)[0];
  const fresh = state === 'available' && newest && now - newest.observedAt <= LIVE_MAX_AGE_MS;
  const shown = lockStatus === 'cancelled' ? 'cancelled' : lockStatus === 'needs_confirmation' ? 'confirmation' : state === 'checking' ? 'checking' : state === 'ambiguous' ? 'ambiguous' : fresh ? 'available' : 'missing';
  const updateFresh = snapshot?.updates.state === 'ok' && now - snapshot.receivedAt <= LIVE_MAX_AGE_MS;
  const prediction = updateFresh && !['cancelled', 'confirmation', 'ambiguous'].includes(shown) ? snapshot.predictions.find((p) => p.stopIndex === dep.stopIndex && p.kind === 'departure' && p.observedAt <= now && now - p.observedAt <= LIVE_MAX_AGE_MS) : undefined;
  const predictionTime = prediction ? formatTime12(prediction.at, tz, lang) + (localYmd(prediction.at, tz) !== localYmd(now, tz) ? ' · ' + new Intl.DateTimeFormat(lang, { timeZone: tz, dateStyle: 'medium' }).format(prediction.at) : '') : '';
  const skipped = skippedKnown || (updateFresh && snapshot.updatedAt && now - snapshot.updatedAt <= LIVE_MAX_AGE_MS && snapshot.skippedStops.includes(dep.stopIndex));
  if (shown === 'missing' && !skipped && !hasStopChanges) return <aside className="card live-bus-status warn" data-testid="live-bus-status">
    <span className="sr-only" role="status">{prediction ? l.gpsMissing : l.missing}</span><strong>{prediction ? l.gpsMissing : l.missing}</strong>
    {prediction && <p><strong>{l.prediction(predictionTime)}</strong><br />{l.predictionAge(Math.max(0, Math.floor((now - prediction.observedAt) / 1000)))}</p>}
  </aside>;
  return <aside className={`card live-bus-status ${['missing', 'ambiguous', 'confirmation', 'cancelled'].includes(shown) ? 'warn' : ''}`} data-testid="live-bus-status">
    <span className="sr-only" role="status">{l[shown]}</span>
    <strong className={shown === 'available' ? 'live-glow' : undefined}>{shown !== 'checking' && <LiveIndicator live={shown === 'available'} />}{l[shown]}</strong>
    {newest && <p>{l.age(Math.max(0, Math.floor((now - newest.observedAt) / 1000)))}</p>}
    {!fresh && shown !== 'checking' && <p>{l.fallback}</p>}
    {skipped ? <p className="warn" role="alert">{l.skipped}</p> : prediction && !snapshot?.cancelledAt
      ? <p><strong>{l.prediction(predictionTime)}</strong><br />{l.predictionAge(Math.max(0, Math.floor((now - prediction.observedAt) / 1000)))}{prediction.at < now && <><br />{l.predictionPast}</>}</p>
      : <p>{l.predictionMissing}</p>}
    {hasStopChanges && !skipped && <p className="warn">{t.ride.uncertain.service_change}</p>}
    <p className="small">{l.source}</p>
  </aside>;
}
