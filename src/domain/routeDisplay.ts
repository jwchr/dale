/** Rider labels only. Keep schedule, fare, history and saved route identities unchanged. */
export function routeNumber(shortName: string): string {
  return shortName === '165T' ? '165' : shortName;
}

/** Keep local and Turnpike choices distinct without inventing a route number. */
export function routeLabel(shortName: string): string {
  return shortName === '165T' ? '165 · Turnpike Exp' : shortName;
}

/** NJ Transit's destination name stays recognizable in either app language. */
export function routeHeadsign(headsign: string, shortName?: string): string {
  const express = shortName === '165T' || /^165T\b/i.test(headsign);
  const text = headsign.replace(/^165T\b/i, '165');
  return express && !/turnpike/i.test(text) ? `${text} · Turnpike Exp` : text;
}

export function routeList(shortNames: string[]): string {
  return [...new Set(shortNames.map(routeLabel))].join(', ');
}
