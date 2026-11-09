import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { liveDataset, NOW } from '../helpers/liveBus';
const ds = structuredClone(liveDataset); ds.meta.feedVersion = 'abcdef123456'; ds.meta.source = 'NJ Transit GTFS BUS G2';
const text = JSON.stringify(ds), context = ds.meta.feedVersion + ':' + createHash('sha256').update(text).digest('hex');
const entry = new URL('../../scripts/deploy-live-worker.mjs', import.meta.url).href;
const identityModule = new URL('../../scripts/worker-content-identity.mjs', import.meta.url).href;
const continuityModule = new URL('../../scripts/enabled-continuity.mjs', import.meta.url).href;
function deployment(scenario: string) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs'; import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module'; import { join } from 'node:path';
    const scenario = ${JSON.stringify(scenario)}, text = ${JSON.stringify(text)}, context = ${JSON.stringify(context)}, start = ${NOW};
    const oldVersion = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', newVersion = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
    let uploaded = 0, temporary, clock = start, receipt;
    Date.now = () => clock;
    const originalRead = fs.readFileSync;
    fs.readFileSync = (path, ...args) => String(path).includes('generated/corridor') ? (scenario === 'local-context-change' ? JSON.stringify({...JSON.parse(text), meta:{...JSON.parse(text).meta,builtAt:'changed'}}) : text)
      : String(path).includes('generated/preservation') ? JSON.stringify(receipt) : originalRead(path, ...args);
    cp.spawnSync = (exe, args) => {
      assert.equal(exe, process.execPath); assert.ok(args.includes('HISTORY_COLLECTION:enabled')); assert.ok(!args.includes('HISTORY_COLLECTION:disabled'));
      uploaded++; clock += 10000;
      const out = args[args.indexOf('--outdir') + 1]; temporary = out.slice(0, -'/uploaded'.length);
      fs.mkdirSync(out, {recursive:true}); fs.writeFileSync(join(out, 'index.js'), 'export default {}'); return {status:0};
    };
    syncBuiltinESMExports();
    const timeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => { if (ms === 5000) { clock += ms; return timeout(fn, 0, ...args); } return timeout(fn, ms, ...args); };
    function collection() {
      const progress = uploaded && scenario !== 'no-native-progress' ? 1 : 0;
      return {enabled:scenario !== 'disabled',error:false,stale:false,reason:'collecting',scheduleVersion:'abcdef123456',scheduleContextStored:true,
        alarmAt:clock+30000,effectiveIntervalMs:30000,lastSuccessAt:start-1000+progress*5000,lastAttemptAt:start-1000+progress*5000,completedAttempt:start-1000+progress*5000,
        observations:100+progress,batches:20+progress,bytes:1000,reservedWrites:scenario==='quota'?74999:100+progress*12,databaseBytes:2000,pendingInterruptionCount:progress,
        byteLimit:250000000,databaseByteLimit:500000000,dailyWriteReservationLimit:75000,budgetDay:'2026-11-04',
        archive:{configured:true,reason:'ready',failures:0,verifiedObjects:uploaded&&scenario==='archive-regression'?20:21+progress,lastSuccessAt:start-500+progress*6000,
          reservedBytes:5000+progress*500,classAReserved32Days:30,classBReserved32Days:30,sqlWriteBudgetRemaining:74000,oldestUnarchivedAt:null,backlogAgeMs:0,
          byteLimit:9000000000,classALimit32Days:800000,classBLimit32Days:8000000}};
    }
    const calls=[];
    globalThis.fetch=async(input, options={})=>{
      const url=new URL(input); calls.push(url.pathname); assert.equal(options.redirect,'error');
      assert.ok(!options.method || options.method==='GET');
      if(url.hostname==='dale-live.synthetic.workers.dev'){
        if(url.pathname==='/health')return Response.json({feedVersion:'abcdef123456'});
        if(url.pathname==='/v1/schedule')return new Response(uploaded&&scenario==='served-context-change'?text+' ':text);
        if(url.pathname==='/v1/collection')return Response.json({collection:collection()});
        throw Error('FORBIDDEN_PUBLIC_ENDPOINT');
      }
      assert.equal(url.origin,'https://api.cloudflare.com'); assert.equal(options.headers.Authorization,'Bearer PRIVATE_SENTINEL_TOKEN');
      const path=url.pathname.split('/dale-live')[1], id=uploaded?newVersion:oldVersion;
      const bindings=[{name:'FEED',type:'durable_object_namespace',namespace_id:uploaded&&scenario==='namespace-change'?'changed':'retained'},
        {name:'HISTORY_ARCHIVE',type:'r2_bucket',bucket_name:'dale-history'},{name:'NJT_API_USERNAME',type:'secret_text'},{name:'NJT_API_PASSWORD',type:'secret_text'},
        {name:'HISTORY_COLLECTION',type:'plain_text',text:'enabled'}];
      let result;
      if(path==='/deployments')result={deployments:[{versions:[{version_id:id,percentage:100}]}]};
      else if(path==='/versions')result={items:[{id}]};
      else if(path.startsWith('/versions/'))result={id,resources:{script:{etag:id},script_runtime:{compatibility_date:'2026-11-06',compatibility_flags:['nodejs_compat'],migration_tag:'v1'}}};
      else if(path==='/settings')result={bindings};
      else if(path==='/content/v2'){
        const form=new FormData();form.set('index.js',new Blob(['export default {}'],{type:'application/javascript+module'}),'index.js');
        const response=new Response(form);response.headers.set('cf-entrypoint','index.js');return response;
      }else throw Error('FORBIDDEN_CLOUDFLARE_ENDPOINT');
      return Response.json({success:true,result});
    };
    const {readActiveWorkerIdentity}=await import(${JSON.stringify(identityModule)});
    const {enabledCheckpoint}=await import(${JSON.stringify(continuityModule)});
    // Build a valid dated receipt independently of the deliberately failing scenario.
    const c=collection(); c.enabled=true;c.reservedWrites=100;
    receipt={v:1,context,identity:await readActiveWorkerIdentity(process.env),checkpoint:enabledCheckpoint(c,'abcdef123456',clock)};
    if(scenario==='wrong-version')process.env.HISTORY_EXPECTED_WORKER_VERSION=newVersion;
    await import(${JSON.stringify(entry)});
    if(temporary)assert.equal(fs.existsSync(temporary),false);
    assert.equal(uploaded,['wrong-version','local-context-change','disabled','quota'].includes(scenario)?0:1);
    assert.ok(!calls.some(p=>/authenticate|getGTFS|VehiclePositions|TripUpdates|v1\\/status|v1\\/live/.test(p)));
  `], { env: { NODE_NO_WARNINGS: '1', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'jwchr/dale', GITHUB_SHA: 'a'.repeat(40),
    HISTORY_COLLECTION_MODE: 'preserve-enabled', HISTORY_CANONICAL_CONTEXT: context, HISTORY_EXPECTED_WORKER_VERSION: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    CLOUDFLARE_API_TOKEN: 'PRIVATE_SENTINEL_TOKEN', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), DALE_WORKER_URL: 'https://dale-live.synthetic.workers.dev', NJT_API_USERNAME: 'PRIVATE_SENTINEL_USER', NJT_API_PASSWORD: 'PRIVATE_SENTINEL_PASSWORD' }, encoding: 'utf8', timeout: 10000 });
}
it('actual native preservation deployment retains enabled bindings/context and proves native archive progress without NJT/demand/stop calls', () => {
  const r = deployment('ok'); expect(r.error).toBeUndefined(); expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain('Existing enabled collector preserved'); expect(r.stdout).toContain('not proof of zero interruption');
  expect(r.stdout + r.stderr).not.toMatch(/PRIVATE_SENTINEL|FORBIDDEN|AssertionError/);
});
it.each(['wrong-version', 'local-context-change', 'disabled', 'quota', 'served-context-change', 'archive-regression', 'namespace-change', 'no-native-progress'])('actual native preservation refuses %s without any stop/activation/automatic rollback or secret leak', scenario => {
  const r = deployment(scenario); expect(r.error).toBeUndefined(); expect(r.status).toBe(1);
  expect(r.stdout).not.toContain('Existing enabled collector preserved');
  expect(r.stdout + r.stderr).not.toMatch(/PRIVATE_SENTINEL|FORBIDDEN|AssertionError|https:/);
});
