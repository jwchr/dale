import type { NormalizedFeed } from './normalize';
export interface CadenceSummary {
  polls: number; upstreamVehicleAttempts: number; feedGaps: number; staleFeeds: number; reports: number;
  firstFreshReports: number; unchangedFreshClocks: number; advancedFreshClocks: number; regressedClocks: number;
  missingClocks: number; staleReports: number; futureClocks: number; contextChanges: number; disappearances: number;
  trackingLimitOmissions: number; unmatchedReports: number; sourceDeltaSecondsHistogram: Record<string, number>;
}
export interface CadenceClock { at: number; trip: string; poll: number }
export type CadenceClocks = Record<string, CadenceClock>;
const counts = ['polls','upstreamVehicleAttempts','feedGaps','staleFeeds','reports','firstFreshReports','unchangedFreshClocks','advancedFreshClocks','regressedClocks','missingClocks','staleReports','futureClocks','contextChanges','disappearances','trackingLimitOmissions','unmatchedReports'] as const;
export function emptyCadenceSummary(): CadenceSummary {
  return { ...Object.fromEntries(counts.map(k=>[k,0])), sourceDeltaSecondsHistogram: {} } as CadenceSummary;
}
/** Explicit public whitelist: never return the per-vehicle clocks, IDs or source payload. */
export function publicCadenceSummary(summary: CadenceSummary) {
  if (!summary || counts.some(k=>!Number.isSafeInteger(summary[k]) || summary[k]<0)) throw new Error('cadence-summary-invalid');
  return { ...Object.fromEntries(counts.map(k=>[k,summary[k]])),
    sourceDeltaSecondsHistogram: Object.fromEntries(Object.entries(summary.sourceDeltaSecondsHistogram).filter(([k,v])=>
      (k==='over300'||/^(?:[1-9][0-9]?|[12][0-9]{2}|300)$/.test(k)) && Number.isSafeInteger(v) && v>=0)) };
}
/** Count only actual collector completions; public health/cache reads never call this. */
export function recordCadencePoll(summary: CadenceSummary, clocks: CadenceClocks, feed: NormalizedFeed, receivedAt: number, upstreamAttempted: boolean) {
  summary.polls++; if(upstreamAttempted)summary.upstreamVehicleAttempts++;
  if(feed.feed.state==='stale')summary.staleFeeds++;
  if(!feed.presence || !['ok','stale'].includes(feed.feed.state))summary.feedGaps++;
  const present=new Set<string>();
  let trackedCount=Object.keys(clocks).length;
  for(const report of feed.presence ?? []) {
    summary.reports++;const key='v:'+report.vehicleId;present.add(key);
    const previous=clocks[key], at=report.observedAt, trip=report.tripInstanceId;
    if(!trip){summary.unmatchedReports++;continue;}
    if(at===undefined || !Number.isSafeInteger(at) || at<=0){summary.missingClocks++;continue;}
    if(at>receivedAt){summary.futureClocks++;continue;}
    if(feed.feed.state!=='ok' || receivedAt-at>120000){summary.staleReports++;continue;}
    if(!previous){
      if(trackedCount>=1000){summary.trackingLimitOmissions++;continue;}
      summary.firstFreshReports++;trackedCount++;
    } else if(previous.trip!==trip)summary.contextChanges++;
    else if(at===previous.at)summary.unchangedFreshClocks++;
    else if(at<previous.at){summary.regressedClocks++;continue;}
    else {
      summary.advancedFreshClocks++;
      const seconds=Math.ceil((at-previous.at)/1000), bin=seconds>300?'over300':String(seconds);
      summary.sourceDeltaSecondsHistogram[bin]=(summary.sourceDeltaSecondsHistogram[bin]??0)+1;
    }
    clocks[key]={at,trip,poll:summary.polls};
  }
  for(const [id,last] of Object.entries(clocks))if(last.poll===summary.polls-1 && !present.has(id))summary.disappearances++;
}
