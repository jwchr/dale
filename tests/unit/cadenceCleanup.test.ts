import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
const entry=new URL('../../scripts/test-history-cadence.mjs',import.meta.url).href;
function run(scenario:string){return spawnSync(process.execPath,['--input-type=module','--eval',`
 import assert from 'node:assert/strict';
 const {cleanupExpiredCadenceFlag,safeCadenceFailure}=await import(${JSON.stringify(entry)});
 const scenario=${JSON.stringify(scenario)},now=1794144000000;
 let patched=0;
 const expiry=String(now+(scenario==='future'?10000:-10000));
 const base=[{name:'FEED',type:'durable_object_namespace',namespace_id:'retained'},{name:'HISTORY_ARCHIVE',type:'r2_bucket',bucket_name:'dale-history'},{name:'HISTORY_COLLECTION',type:'plain_text',text:'enabled'}];
 const consumed=scenario==='consumed'?{expiresAt:Number(expiry),attempts:36}:undefined;
 const env={GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'jwchr/dale',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'private-sentinel',DALE_WORKER_URL:'https://dale-live.synthetic.workers.dev'};
 const fetchImpl=async(input,options={})=>{
  const url=new URL(input);assert.equal(options.redirect,'error');
  if(url.hostname==='dale-live.synthetic.workers.dev'){
   assert.equal(url.pathname,'/v1/collection');assert.equal(options.headers,undefined);
   return Response.json({collection:{enabled:true,error:false,effectiveIntervalMs:30000,alarmAt:now+30000,scheduleContextStored:true,observations:100,batches:20,...(consumed?{cadenceTest:consumed}:{})}});
  }
  assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(options.headers.Authorization,'Bearer private-sentinel');
  const path=url.pathname.split('/dale-live')[1],id='v'+patched;
  if(options.method==='PATCH'){
   assert.equal(path,'/settings');patched++;assert.equal(patched,1);
   const bindings=JSON.parse(options.body.get('settings')).bindings;
   assert.deepEqual(bindings,base.map(b=>({name:b.name,type:'inherit'})).sort((a,b)=>a.name.localeCompare(b.name)));
   return Response.json({success:true,result:{}});
  }
  assert.notEqual(options.method,'POST','cleanup must never adopt/activate a version');
  const bindings=[...base,...(!patched&&scenario!=='absent'?[{name:'HISTORY_CADENCE_TEST_UNTIL',type:'plain_text',text:expiry}]:[])];
  if(path==='/content/v2'){
   const form=new FormData();form.set('index.js',new Blob([patched&&scenario==='code-change'?'changed':'export default {}'],{type:'application/javascript+module'}),'index.js');
   const response=new Response(form);response.headers.set('cf-entrypoint','index.js');return response;
  }
  const result=path==='/deployments'?{deployments:[{versions:[{version_id:id,percentage:100}]}]}:path==='/versions'?{items:[{id}]}:path==='/settings'?{bindings}:path.startsWith('/versions/')?{id,resources:{script:{etag:id},script_runtime:{compatibility_date:'2026-11-06',compatibility_flags:['nodejs_compat'],migration_tag:'v1'}}}:undefined;
  if(!result)throw Error('FORBIDDEN');return Response.json({success:true,result});
 };
 let failed=false;
 try{await cleanupExpiredCadenceFlag(env,{fetchImpl,clock:()=>now,sleep:async()=>{throw Error('unexpected wait');}});}catch(error){failed=true;assert.doesNotMatch(safeCadenceFailure(error),/private-sentinel|FORBIDDEN|https:/);}
 assert.equal(failed,!['ok','consumed'].includes(scenario));assert.equal(patched,['future','absent'].includes(scenario)?0:1);
`],{encoding:'utf8',timeout:10000});}
it.each(['ok','consumed','future','absent','code-change'])('native expired-binding cleanup %s preserves consumed state and never stops or starts a test',scenario=>{
 const r=run(scenario);expect(r.error).toBeUndefined();expect(r.status,r.stderr).toBe(0);expect(r.stdout+r.stderr).not.toContain('private-sentinel');
});
