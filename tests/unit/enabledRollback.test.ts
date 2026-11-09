import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { liveDataset, NOW } from '../helpers/liveBus';
const ds = structuredClone(liveDataset); ds.meta.feedVersion = 'abcdef123456'; ds.meta.source = 'NJ Transit GTFS BUS G2';
const text = JSON.stringify(ds), context = ds.meta.feedVersion + ':' + createHash('sha256').update(text).digest('hex');
const entry = new URL('../../scripts/deploy-live-worker.mjs', import.meta.url).href;
const identityModule = new URL('../../scripts/worker-content-identity.mjs', import.meta.url).href;
const rollbackModule = new URL('../../scripts/enabled-rollback.mjs', import.meta.url).href;
function rollback(scenario: string) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    const scenario=${JSON.stringify(scenario)}, text=${JSON.stringify(text)}, context=${JSON.stringify(context)}, start=${NOW};
    const prior='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', current='bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
    let phase='capture', posts=0, clock=start, versionReads=0;
    Date.now=()=>clock;
    const timeout=globalThis.setTimeout;
    globalThis.setTimeout=(fn,ms,...args)=>{if(ms===5000){clock+=ms;return timeout(fn,0,...args);}return timeout(fn,ms,...args);};
    const read=fs.readFileSync;
    fs.readFileSync=(path,...args)=>{assert.ok(!String(path).includes('/generated/'),'FORBIDDEN_PREPARATION');return read(path,...args);};
    cp.spawnSync=()=>{throw Error('FORBIDDEN_CLI_UPLOAD');}; syncBuiltinESMExports();
    function runtime(id){return {compatibility_date:'2026-11-06',compatibility_flags:['nodejs_compat'],migration_tag:phase!=='capture'&&scenario==='migration-change'&&id===prior?'v2':'v1'};}
    function bindings(id){return [{name:'FEED',type:'durable_object_namespace',namespace_id:phase!=='capture'&&scenario==='namespace-change'&&id===prior?'other':'retained'},
      {name:'HISTORY_ARCHIVE',type:'r2_bucket',bucket_name:phase!=='capture'&&scenario==='bucket-change'&&id===prior?'other':'dale-history'},
      {name:'NJT_API_USERNAME',type:'secret_text'},{name:'NJT_API_PASSWORD',type:'secret_text'},{name:'HISTORY_COLLECTION',type:'plain_text',text:phase!=='capture'&&scenario==='disabled-target'&&id===prior?'disabled':'enabled'}];}
    function collection(){const n=posts&&scenario!=='no-progress'?1:0;return {enabled:true,error:false,stale:false,reason:'collecting',scheduleVersion:'abcdef123456',scheduleContextStored:true,
      alarmAt:clock+30000,effectiveIntervalMs:30000,lastSuccessAt:start-1000+n*6000,lastAttemptAt:start-1000+n*6000,completedAttempt:start-1000+n*6000,
      observations:posts&&scenario==='evidence-regression'?0:100+n,batches:20+n,bytes:1000,reservedWrites:100+n*12,databaseBytes:2000,pendingInterruptionCount:n,
      byteLimit:250000000,databaseByteLimit:500000000,dailyWriteReservationLimit:75000,budgetDay:'2026-11-04',
      archive:{configured:true,reason:'ready',failures:0,verifiedObjects:21+n,lastSuccessAt:start-500+n*6500,reservedBytes:5000+n*500,classAReserved32Days:30,classBReserved32Days:30,
        sqlWriteBudgetRemaining:74000,oldestUnarchivedAt:null,backlogAgeMs:0,byteLimit:9000000000,classALimit32Days:800000,classBLimit32Days:8000000}};}
    globalThis.fetch=async(input,options={})=>{
      const url=new URL(input);assert.equal(options.redirect,'error');
      if(url.hostname==='dale-live.synthetic.workers.dev'){
        assert.ok(!options.method||options.method==='GET');
        if(url.pathname==='/v1/schedule')return new Response(posts&&scenario==='context-change'?text+' ':text);
        assert.equal(url.pathname,'/v1/collection');return Response.json({collection:collection()});
      }
      assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(options.headers.Authorization,'Bearer PRIVATE_SENTINEL_CF');
      const path=url.pathname.split('/dale-live')[1], active=phase==='capture'||posts?prior:current;
      let result;
      if(options.method==='POST'){
        assert.equal(path,'/deployments');assert.equal(url.search,'');assert.equal(posts,0);
        const body=JSON.parse(options.body);assert.deepEqual(body.versions,[{version_id:prior,percentage:100}]);assert.equal(body.strategy,'percentage');
        assert.deepEqual(body.code_update_strategy,{mode:'deferred',max_delay:300});assert.ok(!('force' in body));posts++;
        if(scenario==='secret-refusal')return Response.json({success:false,errors:[{code:10220,message:'PRIVATE_SENTINEL_SECRET_CHANGED'}]},{status:400});
        phase='rolled';clock+=10000;return Response.json({success:true,result:{id:'rollback-deployment'}});
      }
      assert.equal(options.method,'GET');
      if(path==='/deployments')result={deployments:[{versions:[{version_id:active,percentage:100}]}]};
      else if(path==='/versions'&&url.searchParams.get('deployable')==='true')result={items:scenario==='unavailable-target'?[{id:current}]:[{id:current},{id:prior}]};
      else if(path==='/versions'){versionReads++;result={items:[{id:phase==='capture'?prior:current}]};}
      else if(path.startsWith('/versions/')){const id=path.split('/').pop();result={id,resources:{bindings:bindings(id),script:{etag:id},script_runtime:runtime(id)}};}
      else if(path==='/settings')result={bindings:bindings(active)};
      else if(path==='/content/v2'){
        const code=active===prior?(posts&&['content-change','latest-content'].includes(scenario)?'export default {new:true}':'export default {old:true}'):'export default {new:true}';
        const f=new FormData();f.set('index.js',new Blob([code],{type:'application/javascript+module'}),'index.js');const r=new Response(f);r.headers.set('cf-entrypoint','index.js');return r;
      }else throw Error('FORBIDDEN_ENDPOINT');return Response.json({success:true,result});
    };
    const {readActiveWorkerIdentity}=await import(${JSON.stringify(identityModule)});
    const {makeRollbackReference,referenceDigest}=await import(${JSON.stringify(rollbackModule)});
    const reference=makeRollbackReference(await readActiveWorkerIdentity(process.env),context);
    phase='current';
    if(scenario==='reference-context')reference.context='other';
    process.env.HISTORY_ROLLBACK_REFERENCE=JSON.stringify(reference);
    process.env.HISTORY_ROLLBACK_REFERENCE_SHA256=scenario==='reference-digest'?'0'.repeat(64):referenceDigest(reference);
    if(scenario==='current-pin')process.env.HISTORY_EXPECTED_WORKER_VERSION='cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
    await import(${JSON.stringify(entry)});
    assert.equal(posts,['ok','secret-refusal','content-change','latest-content','context-change','evidence-regression','no-progress'].includes(scenario)?1:0);
    // Latest remains NEW even after OLD is active: only the explicit pinned proof
    // may accept that active rollback target; the default latest-version gate stays strict.
    if(posts&&scenario==='ok')await assert.rejects(()=>readActiveWorkerIdentity(process.env));
  `], { env: { NODE_NO_WARNINGS: '1', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'jwchr/dale', GITHUB_SHA: 'a'.repeat(40),
    HISTORY_COLLECTION_MODE: 'rollback-enabled', HISTORY_CANONICAL_CONTEXT: context, HISTORY_EXPECTED_WORKER_VERSION: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
    CLOUDFLARE_API_TOKEN: 'PRIVATE_SENTINEL_CF', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), DALE_WORKER_URL: 'https://dale-live.synthetic.workers.dev' }, encoding: 'utf8', timeout: 10000 });
}
it('native existing entrypoint performs exactly one pinned version rollback and verifies enabled context/content/resources/native archive progress without credentials or resource mutation', () => {
  const r = rollback('ok'); expect(r.error).toBeUndefined(); expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain('Pinned enabled rollback checked'); expect(r.stdout).toContain('zero-gap and every-object durability are not inferred');
  expect(r.stdout + r.stderr).not.toMatch(/PRIVATE_SENTINEL|FORBIDDEN|AssertionError|https:/);
});
it.each(['reference-context', 'reference-digest', 'current-pin', 'unavailable-target', 'namespace-change', 'bucket-change', 'migration-change', 'disabled-target', 'secret-refusal', 'content-change', 'latest-content', 'context-change', 'evidence-regression', 'no-progress'])('native rollback refuses %s with no retries, force-secret acceptance, prepare/upload, settings or evidence mutation', scenario => {
  const r = rollback(scenario); expect(r.error).toBeUndefined(); expect(r.status).toBe(1);
  expect(r.stdout).not.toContain('Pinned enabled rollback checked'); expect(r.stdout + r.stderr).not.toMatch(/PRIVATE_SENTINEL|FORBIDDEN|AssertionError|https:/);
});
it('manual rollback mode shares the existing owner workflow and never enters preparation/auth or exposes NJT credentials', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/live-worker.yml', import.meta.url), 'utf8');
  const step = workflow.split(/\n      - /).find(s => s.includes('Explicit pinned enabled rollback'))!;
  expect(step).toContain("if: inputs.history_collection == 'rollback-enabled'"); expect(step).toContain('node scripts/deploy-live-worker.mjs');
  expect(step).not.toMatch(/NJT_API_|worker:prepare|stop-history|--force|--yes/);
});
