import { expect, it } from 'vitest';
import { emptyCadenceSummary, publicCadenceSummary, recordCadencePoll, type CadenceClocks } from '../../worker/cadence-summary';
import type { NormalizedFeed, VehiclePresence } from '../../worker/normalize';
const T=1794140000000;
const report=(at=T,trip='private-trip',id='private-bus'):VehiclePresence=>({vehicleId:id,tripInstanceId:trip,observedAt:at,qualification:'matched'});
const feed=(presence:VehiclePresence[],state:'ok'|'stale'|'unavailable'='ok'):NormalizedFeed=>({feed:{state,timestamp:T},observations:[],updates:[],presence});
it('five-second samples distinguish duplicate clocks from30second source advances and missing presence',()=>{
 const s=emptyCadenceSummary(),clocks:CadenceClocks={};
 for(let i=0;i<=12;i++)recordCadencePoll(s,clocks,feed([report(T+Math.floor(i/6)*30000)]),T+i*5000,true);
 expect(s).toMatchObject({polls:13,upstreamVehicleAttempts:13,firstFreshReports:1,unchangedFreshClocks:10,advancedFreshClocks:2,sourceDeltaSecondsHistogram:{'30':2}});
 recordCadencePoll(s,clocks,feed([]),T+65000,true);expect(s.disappearances).toBe(1);
 recordCadencePoll(s,clocks,feed([]),T+70000,true);expect(s.disappearances).toBe(1);
 const text=JSON.stringify(publicCadenceSummary(s));expect(text).not.toMatch(/private-bus|private-trip|vehicleId|tripInstanceId|lat|lon/);
});
it('does not mix stale/future/missing/regressed clocks or different trips into valid cadence deltas',()=>{
 const s=emptyCadenceSummary(),clocks:CadenceClocks={};
 recordCadencePoll(s,clocks,feed([report()]),T,true);
 recordCadencePoll(s,clocks,feed([report(T-1000)]),T+5000,true);
 recordCadencePoll(s,clocks,feed([report(T+100000)]),T+10000,true);
 recordCadencePoll(s,clocks,feed([{...report(),observedAt:undefined}]),T+15000,true);
 recordCadencePoll(s,clocks,feed([report(T-200000)]),T+20000,true);
 recordCadencePoll(s,clocks,feed([report(T+25000,'other-private-trip')]),T+25000,true);
 recordCadencePoll(s,clocks,feed([],'unavailable'),T+30000,false);
 expect(s).toMatchObject({polls:7,upstreamVehicleAttempts:6,regressedClocks:1,futureClocks:1,missingClocks:1,staleReports:1,contextChanges:1,advancedFreshClocks:0,feedGaps:1});
});
it('bounds private tracking and whitelists only aggregate fields',()=>{
 const s=emptyCadenceSummary(),clocks:CadenceClocks={};
 for(let i=0;i<1000;i++)clocks['v:'+i]={at:T,trip:'private',poll:0};
 recordCadencePoll(s,clocks,feed([report()]),T,true);
 expect(Object.keys(clocks)).toHaveLength(1000);expect(s.trackingLimitOmissions).toBe(1);
 const malicious={...s,raw:'private-coordinate',sourceDeltaSecondsHistogram:{'30':1,'private-bus':99}};
 expect(publicCadenceSummary(malicious)).not.toHaveProperty('raw');
 expect(publicCadenceSummary(malicious).sourceDeltaSecondsHistogram).toEqual({'30':1});
 expect(()=>publicCadenceSummary({...s,polls:-1})).toThrow('cadence-summary-invalid');
});
