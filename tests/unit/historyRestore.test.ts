import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const entry=new URL('../../scripts/deploy-live-worker.mjs',import.meta.url).href;
function restore(scenario='ok') {
  return spawnSync(process.execPath,['--input-type=module','--eval',`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {join} from 'node:path';
    const scenario=${JSON.stringify(scenario)};
    let uploaded=0,patched=0,temporary;
    const code='export default {}';
    const originalRead=fs.readFileSync;
    fs.readFileSync=(path,...args)=>String(path).includes('generated/corridor')?JSON.stringify({meta:{source:'NJ Transit GTFS BUS G2',feedVersion:'abcdef123456',realtime:{provider:'njt-bus-g2'}}}):originalRead(path,...args);
    cp.spawnSync=(executable,args)=>{
      uploaded++;
      assert.equal(executable,process.execPath);
      assert.ok(args.includes('HISTORY_COLLECTION:disabled'));
      assert.ok(!args.includes('HISTORY_COLLECTION:enabled'));
      const out=args[args.indexOf('--outdir')+1];temporary=out.slice(0,-'/uploaded'.length);
      fs.mkdirSync(out,{recursive:true});fs.writeFileSync(join(out,'index.js'),code);
      fs.writeFileSync(join(out,'README.md'),scenario==='forged-readme'?'PRIVATE_SENTINEL':'This folder contains the built output assets for the worker \"dale-live\" generated at 2026-11-08T10:00:00.000Z.');
      if(scenario==='extra-artifact')fs.writeFileSync(join(out,'unknown.wasm'),'PRIVATE_SENTINEL');
      return {status:0};
    };
    syncBuiltinESMExports();
    const originalTimeout=globalThis.setTimeout;
    globalThis.setTimeout=(fn,ms,...args)=>originalTimeout(fn,ms>=1000?0:ms,...args);
    globalThis.fetch=async(input,options={})=>{
      const url=new URL(input);assert.equal(options.redirect,'error');
      if(url.hostname==='dale-live.synthetic.workers.dev'){
        assert.equal(options.headers,undefined);
        if(url.pathname==='/health')return Response.json({feedVersion:'abcdef123456'});
        assert.equal(url.pathname,'/v1/collection');
        return Response.json({collection:{enabled:scenario==='not-disabled' && !uploaded,reason:scenario==='not-disabled' && !uploaded?'collecting':'disabled',alarmAt:null,observations:1,batches:1,bytes:123,lastAttemptAt:100,completedAttempt:100,archive:scenario==='mixed-archive'?{configured:true,enabled:false,reason:'unknown'}:scenario==='active-archive'?{configured:true,enabled:true,verifiedObjects:2,reservedBytes:456}:scenario==='partial-archive'?{configured:true,enabled:false,verifiedObjects:2}:scenario==='unconfigured-archive'?{configured:false,enabled:false}:['full-counters','lost-known-counters','archive-regression'].includes(scenario)?uploaded && scenario==='lost-known-counters'?{configured:true,enabled:false}:{configured:true,verifiedObjects:uploaded && scenario==='archive-regression'?1:2,reservedBytes:456}:{configured:true,enabled:false}}});
      }
      assert.equal(url.origin,'https://api.cloudflare.com');
      assert.equal(options.headers.Authorization,'Bearer PRIVATE_SENTINEL_TOKEN');
      const path=url.pathname.split('/dale-live')[1];
      const id=patched?'v3':uploaded?'v2':'v1';
      const bindings=[{name:'FEED',type:'durable_object_namespace',namespace_id:'retained'},{name:'HISTORY_ARCHIVE',type:'r2_bucket',bucket_name:uploaded && scenario==='binding-change'?'changed':'dale-history'},{name:'NJT_API_USERNAME',type:'secret_text'},{name:'NJT_API_PASSWORD',type:'secret_text'},{name:'HISTORY_COLLECTION',type:'plain_text',text:'disabled'}];
      let result;
      if(path==='/deployments')result={deployments:[{versions:[{version_id:id,percentage:100}]}]};
      else if(path==='/versions')result={items:[{id}]};
      else if(path.startsWith('/versions/'))result={id,resources:{script:{etag:id},script_runtime:{compatibility_date:uploaded && scenario==='runtime-change'?'changed':'2026-11-06',compatibility_flags:['nodejs_compat'],migration_tag:scenario==='unapplied-migration'?'old-tag':'v1'},bindings}};
      else if(path==='/settings' && options.method==='PATCH'){
        patched++;assert.equal(uploaded,1);
        const settings=JSON.parse(options.body.get('settings'));
        assert.ok(settings.bindings.some(b=>b.name==='HISTORY_COLLECTION' && b.text==='disabled'));
        assert.ok(settings.bindings.filter(b=>b.name!=='HISTORY_COLLECTION').every(b=>b.type==='inherit'));
        result={};
      }else if(path==='/settings')result={bindings};
      else if(path==='/content/v2'){
        const f=new FormData();f.set('index.js',new Blob([uploaded && scenario==='artifact-mismatch'?'changed':patched && scenario==='stop-code-change'?'changed':code],{type:'application/javascript+module'}),'index.js');
        const response=new Response(f);response.headers.set('cf-entrypoint','index.js');return response;
      }else throw Error('FORBIDDEN_NETWORK');
      return Response.json({success:true,result});
    };
    await import(${JSON.stringify(entry)});
    if(temporary)assert.equal(fs.existsSync(temporary),false);
    assert.equal(uploaded,['not-disabled','unapplied-migration','partial-archive','mixed-archive','active-archive','unconfigured-archive','missing-credentials'].includes(scenario)?0:1);
    assert.equal(patched,['ok','full-counters','lost-known-counters','archive-regression','stop-code-change'].includes(scenario)?1:0);
  `],{env:{NODE_NO_WARNINGS:'1',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'jwchr/dale',GITHUB_SHA:'a'.repeat(40),HISTORY_COLLECTION_MODE:'restore-disabled',CLOUDFLARE_API_TOKEN:'PRIVATE_SENTINEL_TOKEN',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),DALE_WORKER_URL:'https://dale-live.synthetic.workers.dev',NJT_API_USERNAME:'PRIVATE_SENTINEL_USER',NJT_API_PASSWORD:scenario==='missing-credentials'?undefined:'PRIVATE_SENTINEL_PASSWORD'},encoding:'utf8',timeout:10000});
}
it.each(['ok','full-counters'])('actual native recovery accepts valid disabled health %s and binds reviewed artifact/strict stop with retained journal evidence',scenario=>{
  const r=restore(scenario);expect(r.error).toBeUndefined();expect(r.status).toBe(0);expect(r.stderr).toBe('');
  expect(r.stdout).toContain('Known reviewed code restored disabled');
  expect(r.stdout).toContain('completeModulesEqual=true metadataEtagEqual=false');
  expect(r.stdout).not.toContain('PRIVATE_SENTINEL');
});
it.each(['mixed-archive','active-archive','partial-archive','unconfigured-archive','missing-credentials','lost-known-counters','archive-regression','unapplied-migration','not-disabled','extra-artifact','forged-readme','artifact-mismatch','binding-change','runtime-change','stop-code-change'])('recovery refuses %s, cleans temporary secrets and never enables or retries',scenario=>{
  const r=restore(scenario);expect(r.error).toBeUndefined();expect(r.status).toBe(1);
  expect(r.stderr).toContain('Live Worker deployment or validation failed');
  expect(r.stdout+r.stderr).not.toMatch(/PRIVATE_SENTINEL|AssertionError|FORBIDDEN|https:/);
  expect(r.stdout).not.toContain('Known reviewed code restored disabled');
});
it('only explicit restore-disabled enters existing prepared deployment path; default disabled remains NJT-free',()=>{
  const workflow=readFileSync(new URL('../../.github/workflows/live-worker.yml',import.meta.url),'utf8');
  expect(workflow).toContain('options: [disabled, enabled, inspect, restore-disabled, cadence-test]');
  for(const step of workflow.split(/\n      - /).filter(s=>/run: (npm ci|npm run worker:prepare|node scripts\/deploy-live-worker|node -e)/.test(s)))expect(step).toContain("if: inputs.history_collection == 'enabled' || inputs.history_collection == 'restore-disabled'");
});

it.each([
 ['missing-credentials','configuration-invalid'],['not-disabled','restore-disabled-precondition'],
 ['partial-archive','disabled-archive-shape-invalid'],['lost-known-counters','restored-evidence-unverified'],
 ['archive-regression','restored-evidence-unverified'],
])('emits only a closed local preflight/evidence diagnostic for %s',(scenario,reason)=>{
 const result=restore(scenario);expect(result.status).toBe(1);
 expect(result.stderr).toContain('Worker proof diagnostic: reason='+reason+'.');
 expect(result.stderr).not.toMatch(/PRIVATE_SENTINEL|https:|AssertionError/);
});
