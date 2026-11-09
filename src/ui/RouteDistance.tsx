import type { ReportedRouteDistance } from '../domain/routeDistance';
import { strings, type Lang } from './i18n';
/** Compact observed distance, independent of the boarding/destination clocks. No live region on ticks. */
export function RouteDistance({ value, lang, now, onboard = false }: { value?: ReportedRouteDistance; lang: Lang; now: number; onboard?: boolean }) {
  if (!value) return null;
  const t = strings[lang].distance, miles = (value.meters / 1609.344).toFixed(1);
  const age = Math.max(0, Math.floor((now - value.observedAt) / 1000));
  return <span className="route-distance" data-stale={value.stale} data-observed-at={value.observedAt}>
    <span>≈ {miles} <span aria-hidden="true">mi</span><span className="sr-only">{t.units}</span> {onboard ? t.remaining : t.away}</span>
    {' · '}<span>{value.stale ? t.stale : t.gps} {age}s</span>
  </span>;
}
