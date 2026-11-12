import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { liveDataset, NOW } from '../helpers/liveBus';
const old = structuredClone(liveDataset); old.meta.feedVersion = 'abcdef123456'; old.meta.source = 'NJ Transit GTFS BUS G2';
const next = structuredClone(old); next.meta.feedVersion = 'fedcba654321'; next.trips[0]!.times[0]! += 60;
const keyOf = (text: string, feed: string) => feed + ':' + createHash('sha256').update(text).digest('hex');
const text = JSON.stringify(old), context = keyOf(text, old.meta.feedVersion);
const nextText = JSON.stringify(next), nextContext = keyOf(nextText, next.meta.feedVersion);
const entry = new URL('../../scripts/deploy-live-worker.mjs', import.meta.url).href;
const identityModule = new URL('../../scripts/worker-content-identity.mjs', import.meta.url).href;
const continuityModule = new URL('../../scripts/enabled-continuity.mjs', import.meta.url).href;
function deployment(scenario: string) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs'; import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module'; import { join } from 'node:path';
    const scenario = ${JSON.stringify(scenario)}, text = ${JSON.stringify(text)}, context = ${JSON.stringify(context)};
    const nextText = ${JSON.stringify(nextText)}, nextContext = ${JSON.stringify(nextContext)}, start = ${NOW};
    const oldVersion = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', newVersion = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
    let uploaded = 0, temporary, clock = start, receipt, acknowledgedAt, scheduleReadsAfter = 0, collectionReadsAfter = 0; const actorReads = [];
    Date.now = () => clock;
    const originalRead = fs.readFileSync;
    fs.readFileSync = (path, ...args) => String(path).includes('generated/corridor') ? (scenario === 'local-equals-served' ? text : nextText)
      : String(path).includes('generated/rollover') ? JSON.stringify(receipt)
      : String(path).includes('generated/preservation') ? (()=>{ throw Error('FORBIDDEN_PRESERVATION_RECEIPT'); })() : originalRead(path, ...args);
    cp.spawnSync = (exe, args) => {
      assert.equal(exe, process.execPath); assert.ok(args.includes('HISTORY_COLLECTION:enabled')); assert.ok(!args.includes('--secrets-file')); assert.equal(args[args.indexOf('--durable-objects-code-update-mode')+1], 'deferred 300s');
      uploaded++; clock += 10000; acknowledgedAt = clock;
      const out = args[args.indexOf('--outdir') + 1]; temporary = out.slice(0, -'/uploaded'.length);
      fs.mkdirSync(out, {recursive:true}); fs.writeFileSync(join(out, 'index.js'), 'export default {}'); return {status:0};
    };
    syncBuiltinESMExports();
    const timeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => { if (ms === 5000) { clock += ms; return timeout(fn, 0, ...args); } return timeout(fn, ms, ...args); };
    const archive = (verifiedObjects, lastSuccessAt) => ({configured:true,reason:'ready',failures:0,verifiedObjects,lastSuccessAt,reservedBytes:5000+verifiedObjects,classAReserved32Days:30,classBReserved32Days:30,
      sqlWriteBudgetRemaining:74000,oldestUnarchivedAt:null,backlogAgeMs:0,byteLimit:9000000000,classALimit32Days:800000,classBLimit32Days:8000000});
    function collection() {
      const progress = uploaded ? Math.floor((clock - acknowledgedAt) / 30000) + 1 : 0, boundary = acknowledgedAt + 300000;
      const base = {enabled:true,error:false,stale:false,reason:'collecting',scheduleVersion:'abcdef123456',scheduleContextStored:true,
        alarmAt:clock+30000,effectiveIntervalMs:30000,lastSuccessAt:clock-500,lastAttemptAt:clock-1000,completedAttempt:clock-1000,
        observations:100+progress,batches:20+progress,bytes:1000,reservedWrites:(scenario==='quota'?74500:100)+progress*12,databaseBytes:2000,pendingInterruptionCount:0,
        byteLimit:250000000,databaseByteLimit:500000000,dailyWriteReservationLimit:75000,budgetDay:'2026-11-04',archive:archive(21+progress,clock-100)};
      if (!uploaded || clock <= boundary) return base; // The old actor keeps collecting through the deferral.
      if (scenario === 'admission-failed') return {...base, error:true, scheduleVersion:'fedcba654321', scheduleContextStored:false};
      // The new actor stored its context and has not completed a batch yet.
      if (clock < boundary + 20000) return {...base, reason:'starting', scheduleVersion:'fedcba654321', lastSuccessAt:boundary-500, lastAttemptAt:boundary-1000, completedAttempt:boundary-1000, archive:archive(21+progress,boundary-100)};
      return {...base, scheduleVersion:'fedcba654321', ...(scenario==='regression'?{batches:5}:{})};
    }
    const calls=[];
    globalThis.fetch=async(input, options={})=>{
      const url=new URL(input); calls.push(url.pathname); assert.equal(options.redirect,'error');
      assert.ok(!options.method || options.method==='GET');
      if(url.hostname==='dale-live.synthetic.workers.dev'){
        if(url.pathname==='/v1/schedule'){
          if(!uploaded)return new Response(scenario==='served-not-old'?nextText:text);
          scheduleReadsAfter++; return new Response(scenario==='propagation'&&scheduleReadsAfter===1?text:nextText);
        }
        if(url.pathname==='/v1/collection'){
          if(uploaded){actorReads.push(clock);collectionReadsAfter++;if(scenario==='transient-read'&&collectionReadsAfter<=2)return new Response('busy',{status:503});}
          return Response.json({collection:collection()});
        }
        throw Error('FORBIDDEN_PUBLIC_ENDPOINT');
      }
      assert.equal(url.origin,'https://api.cloudflare.com'); assert.equal(options.headers.Authorization,'Bearer PRIVATE_SENTINEL_TOKEN');
      const path=url.pathname.split('/dale-live')[1], id=uploaded?newVersion:oldVersion;
      const bindings=[{name:'FEED',type:'durable_object_namespace',namespace_id:'retained'},
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
    const c=collection(); c.reservedWrites=100;
    receipt={v:1,kind:'rollover',fromContext:context,toFeedVersion:'fedcba654321',toContext:nextContext,identity:await readActiveWorkerIdentity(process.env),checkpoint:enabledCheckpoint(c,'abcdef123456',clock)};
    if(scenario==='receipt-other-context')receipt.fromContext='0'.repeat(12)+':'+'0'.repeat(64);
    await import(${JSON.stringify(entry)});
    if(temporary)assert.equal(fs.existsSync(temporary),false);
    assert.ok(actorReads.every(at=>at>acknowledgedAt+300000),'READ_DURING_DEFERRAL');
    if(scenario==='admission-failed')assert.ok(clock<acknowledgedAt+330000,'NOT_FAIL_FAST');
    assert.equal(uploaded,['served-not-old','local-equals-served','quota','receipt-other-context'].includes(scenario)?0:1);
    assert.ok(!calls.some(p=>/authenticate|getGTFS|VehiclePositions|TripUpdates|v1\\/status|v1\\/live|health/.test(p)));
  `], { env: { NODE_NO_WARNINGS: '1', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'jwchr/dale', GITHUB_SHA: 'a'.repeat(40),
    HISTORY_COLLECTION_MODE: 'rollover-enabled', HISTORY_CANONICAL_CONTEXT: context, HISTORY_EXPECTED_WORKER_VERSION: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    CLOUDFLARE_API_TOKEN: 'PRIVATE_SENTINEL_TOKEN', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), DALE_WORKER_URL: 'https://dale-live.synthetic.workers.dev' }, encoding: 'utf8', timeout: 15000 });
}
const LEAK = /PRIVATE_SENTINEL|FORBIDDEN|AssertionError|https:/;
it.each(['ok', 'propagation', 'transient-read'])('rolls the enabled collector onto the new schedule and prints the next pins: %s', scenario => {
  const r = deployment(scenario); expect(r.error).toBeUndefined(); expect(r.status, r.stderr).toBe(0);
  const proofLine = r.stdout.split('\n').find(line => line.startsWith('Post-deferral proof:'))!;
  const proof = Object.fromEntries([...proofLine.matchAll(/(\w+)=(\d+)/g)].map(m => [m[1]!, Number(m[2])]));
  expect(proof.boundaryAt! - proof.acknowledgedAt!).toBe(300000);
  expect(proof.nativeAttemptAt).toBeGreaterThan(proof.boundaryAt!); expect(proof.archiveSuccessAt).toBeGreaterThan(proof.boundaryAt!);
  expect(r.stdout).toContain('Schedule rollover proven: abcdef123456 to fedcba654321.');
  expect(r.stdout.trim().split('\n').pop()).toBe(`Next rollover pins: expected_worker_version=bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee canonical_context_key=${nextContext}`);
  expect(r.stdout + r.stderr).not.toMatch(LEAK);
});
it.each([
  ['admission-failed', 'rollover-context-admission-failed'], ['regression', 'enabled-continuity-unverified'],
  ['served-not-old', 'enabled-continuity-unverified'], ['local-equals-served', 'rollover-schedule-invalid'],
  ['quota', 'rollover-capacity-refused'], ['receipt-other-context', 'rollover-receipt-unverified'],
])('refuses %s with %s, no automatic rollback or stop, and names the recovery', (scenario, reason) => {
  const r = deployment(scenario); expect(r.error).toBeUndefined(); expect(r.status).toBe(1);
  const lines = r.stderr.trim().split('\n');
  expect(lines[0]).toBe(`Worker proof diagnostic: reason=${reason}.`);
  expect(lines).toContain('Schedule rollover not proven; no automatic rollback or stop was attempted. Recovery is a reviewed re-run (rollover-enabled while the old schedule is still served, otherwise preserve-enabled with the pins qualify-enabled reports), or the existing disabled choice, which stops collection and preserves all evidence.');
  expect(r.stdout).not.toContain('Next rollover pins');
  expect(r.stdout + r.stderr).not.toMatch(LEAK);
});
it('workflow runs rollover through the same secret check, install, preparation and deployment steps as preserve, never schedule-check or stop', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/live-worker.yml', import.meta.url), 'utf8');
  expect(workflow).toContain('timeout-minutes: 20');
  const steps = workflow.split(/\n      - /);
  const rolloverSteps = steps.filter(s => s.includes("inputs.history_collection == 'rollover-enabled'"));
  expect(rolloverSteps).toHaveLength(4);
  for (const step of rolloverSteps) {
    expect(step).toContain("inputs.history_collection == 'preserve-enabled'");
    expect(step).not.toMatch(/stop-history|check-schedule|test-history-cadence/);
  }
  const prepare = rolloverSteps.find(s => s.includes('run: npm run worker:prepare'))!, deploy = rolloverSteps.find(s => s.includes('run: node scripts/deploy-live-worker.mjs'))!;
  for (const step of [prepare, deploy]) for (const key of ['HISTORY_COLLECTION_MODE', 'HISTORY_CANONICAL_CONTEXT', 'HISTORY_EXPECTED_WORKER_VERSION', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'NJT_API_USERNAME', 'NJT_API_PASSWORD', 'DALE_WORKER_URL'])
    expect(step).toContain(key + ':');
  for (const s of steps.filter(x => /stop-history-collection|check-schedule/.test(x))) expect(s).not.toContain('rollover');
});
