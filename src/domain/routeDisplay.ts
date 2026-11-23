/** Rider labels only. Keep schedule, fare, history and saved route identities unchanged. */
export function routeNumber(shortName: string): string {
  return shortName === '165T' ? '165' : shortName;
}

/** Both split schedules and unsplit agency headsigns identify Turnpike service. */
export function isTurnpikeExpress(routeShortName: string | undefined, headsign = ''): boolean {
  return routeShortName === '165T' || /^165T\b/i.test(headsign);
}

/** Keep local and Turnpike choices distinct, using the caller's existing i18n label. */
export function routeLabel(shortName: string, expressLabel: string): string {
  return isTurnpikeExpress(shortName) ? `165 · ${expressLabel}` : shortName;
}

/** NJ Transit's destination name stays recognizable in either app language. */
export function routeHeadsign(headsign: string, shortName: string | undefined, expressLabel: string): string {
  const express = isTurnpikeExpress(shortName, headsign);
  const text = headsign.replace(/^165T\b/i, '165');
  return express && !/turnpike/i.test(text) ? `${text} · ${expressLabel}` : text;
}

export function routeList(shortNames: string[], expressLabel: string): string {
  return [...new Set(shortNames.map(name => routeLabel(name, expressLabel)))].join(', ');
}
