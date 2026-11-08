import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
const summaryModule=new URL('../../worker/cadence-summary.ts',import.meta.url).href;
const entry=new URL('../../scripts/test-history-cadence.mjs',import.meta.url).href;
function run(scenario:string){return spawnSync(process.execPath,['--input-type=module','--eval',`
 import assert from 'node:assert/strict';
 const {emptyCadenceSummary}=await import(${JSON.stringify(summaryModule)});
 const {testHistoryCadence}=await import(${JSON.stringify(entry)});
 const scenario=${JSON.stringify(scenario)};
 const start=1794140000000;let now=start,patches=0,until=0;
 const original=[{name:'FEED',type:'durable_object_namespace',namespace_id:'retained'},{name:'HISTORY_ARCHIVE',type:'r2_bucket',bucket_name:'dale-history'},{name:'HISTORY_COLLECTION',type:'plain_text',text:'enabled'}];
 const env={GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'jwchr/dale',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'private-test',DALE_WORKER_URL:'https://dale-live.synthetic.workers.dev'};
 const fetchImpl=async(input,options={})=>{
  const url=new URL(input);assert.equal(options.redirect,'error');
  if(url.hostname==='dale-live.synthetic.workers.dev'){
   assert.equal(url.pathname,'/v1/collection');assert.equal(options.headers,undefined);
   return Response.json({collection:{enabled:true,error:false,scheduleContextStored:true,alarmAt:now+5000,archive:{reason:'ready',failures:0,backlogAgeMs:0},effectiveIntervalMs:until&&now<until&&scenario!=='never-ready'&&!(scenario==='delayed-health'&&now<start+30000)?5000:30000,...(until||scenario==='consumed'?{cadenceTest:{expiresAt:until||now-1000,attempts:now<until?0:35,summary:{...emptyCadenceSummary(),polls:35,upstreamVehicleAttempts:35}}}:{})}});
  }
  assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(options.headers.Authorization,'Bearer private-test');
  const phase=patches===1&&scenario==='delayed-identity'&&now<start+30000?0:patches;
  const path=url.pathname.split('/dale-live')[1],id='v'+phase;
  if(options.method==='PATCH'){
   assert.equal(path,'/settings');patches++;
   const b=JSON.parse(options.body.get('settings')).bindings;
   assert.ok(b.filter(x=>x.name!=='HISTORY_CADENCE_TEST_UNTIL').every(x=>x.type==='inherit'));
   const temporary=b.find(x=>x.name==='HISTORY_CADENCE_TEST_UNTIL');
   if(patches===1){assert.ok(temporary);until=Number(temporary.text);assert.equal(until-now,180000);}else{assert.equal(patches,2);assert.equal(temporary,undefined);assert.ok(now>=until);}
   return Response.json({success:true,result:{}});
  }
  const bindings=[...original,...(phase===1?[{name:'HISTORY_CADENCE_TEST_UNTIL',type:'plain_text',text:String(until)}]:[])];
  if(path==='/content/v2'){
   const form=new FormData();form.set('index.js',new Blob([scenario==='code-change'&&patches?'changed':'export default {}'],{type:'application/javascript+module'}),'index.js');
   const response=new Response(form);response.headers.set('cf-entrypoint','index.js');return response;
  }
  const result=path==='/deployments'?{deployments:[{versions:[{version_id:id,percentage:100}]}]}:path==='/versions'?{items:[{id}]}:path==='/settings'?{bindings}:path.startsWith('/versions/')?{id,resources:{script:{etag:id},script_runtime:{compatibility_date:'2026-11-06',compatibility_flags:['nodejs_compat'],migration_tag:'v1'}}}:undefined;
  if(!result)throw Error('forbidden endpoint');return Response.json({success:true,result});
 };
 let failed=false;
 try{await testHistoryCadence(env,{fetchImpl,clock:()=>now,sleep:async ms=>{assert.ok(ms>0);assert.ok(now+ms<=until+1000);now+=ms;}});}catch{failed=true;}
 assert.equal(failed,!['ok','delayed-health','delayed-identity'].includes(scenario));if(scenario==='never-ready')assert.equal(now,until);
 assert.equal(patches,scenario==='consumed'?0:['code-change','never-ready'].includes(scenario)?1:2);
`],{encoding:'utf8',timeout:10000});}
it.each(['ok','consumed','code-change','delayed-health','delayed-identity','never-ready'])('native protected cadence control %s never polls upstream or stops recording',scenario=>{
 const r=run(scenario);expect(r.error).toBeUndefined();expect(r.status,r.stderr).toBe(0);expect(r.stdout+r.stderr).not.toContain('private-test');
 if(['ok','delayed-health','delayed-identity'].includes(scenario))expect(r.stdout).toContain('Test expired automatically; recording remains ON at30seconds');
});
