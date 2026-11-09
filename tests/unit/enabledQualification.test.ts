import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
// @ts-expect-error native ESM control helper without declarations
import { qualificationInventory, MAX_QUALIFICATION_RECEIPT_BYTES } from '../../scripts/enabled-qualification.mjs';
import { liveDataset, NOW } from '../helpers/liveBus';
const ds = structuredClone(liveDataset); ds.meta.feedVersion = 'abcdef123456'; ds.meta.source = 'NJ Transit GTFS BUS G2';
const text = JSON.stringify(ds), context = ds.meta.feedVersion + ':' + createHash('sha256').update(text).digest('hex');
const entry = new URL('../../scripts/deploy-live-worker.mjs', import.meta.url).href;
function qualification(scenario: string) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    const scenario=${JSON.stringify(scenario)}, text=${JSON.stringify(text)}, now=${NOW};Date.now=()=>now;
    let reads=0,settingsReads=0;
    const read=fs.readFileSync;
    fs.readFileSync=(path,...args)=>{assert.ok(!String(path).includes('/generated/'),'FORBIDDEN_PREPARATION');return read(path,...args);};
    fs.writeFileSync=()=>{throw Error('FORBIDDEN_WRITE');};fs.mkdtempSync=()=>{throw Error('FORBIDDEN_TEMP');};cp.spawnSync=()=>{throw Error('FORBIDDEN_CLI');};syncBuiltinESMExports();
    globalThis.fetch=async(input,options={})=>{
      reads++;assert.ok(reads<=18,'UNBOUNDED_READS');const url=new URL(input);assert.equal(options.redirect,'error');
      assert.ok(!options.method||options.method==='GET');assert.equal(options.body,undefined);
      if(url.hostname==='dale-live.synthetic.workers.dev'){
        assert.equal(options.headers,undefined);
        if(url.pathname==='/v1/schedule')return new Response(scenario==='oversized'?new Uint8Array(16000001):scenario==='noncanonical'?text+' ':text);
        assert.equal(url.pathname,'/v1/collection');
        return Response.json({collection:{enabled:scenario!=='disabled',error:false,stale:false,reason:'collecting',scheduleVersion:scenario==='wrong-feed'?'other':'abcdef123456',scheduleContextStored:true,
          alarmAt:scenario==='old-alarm'?now-1:now+30000,effectiveIntervalMs:scenario==='wrong-rate'?5000:30000,lastSuccessAt:now-1000,lastAttemptAt:now-1000,completedAttempt:now-1000,
          observations:100,batches:20,bytes:1000,reservedWrites:scenario==='quota'?74999:100,databaseBytes:2000,pendingInterruptionCount:scenario==='unknown-counter'?undefined:0,privateRecord:'PRIVATE_ARCHIVE_KEY',
          byteLimit:250000000,databaseByteLimit:500000000,dailyWriteReservationLimit:75000,budgetDay:'2026-11-04',
          archive:{configured:true,reason:'ready',failures:0,verifiedObjects:21,lastSuccessAt:now-500,reservedBytes:5000,classAReserved32Days:30,classBReserved32Days:30,
            sqlWriteBudgetRemaining:74000,oldestUnarchivedAt:null,backlogAgeMs:scenario==='backlog'?180000:0,byteLimit:9000000000,classALimit32Days:800000,classBLimit32Days:8000000}}});
      }
      assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer PRIVATE_SENTINEL_TOKEN');
      if(scenario==='denied')return Response.json({success:false,message:'PRIVATE_SENTINEL_RAW_DENIAL'},{status:403});
      const path=url.pathname.split('/dale-live')[1],id=scenario==='identity-race'&&settingsReads>=2?'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee':'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const bindings=[{name:'FEED',type:'durable_object_namespace',namespace_id:'PRIVATE_NAMESPACE_DESCRIPTOR'},
        {name:'HISTORY_ARCHIVE',type:'r2_bucket',bucket_name:scenario==='wrong-bucket'?'other':'dale-history'},
        {name:'NJT_API_USERNAME',type:'secret_text',text:'PRIVATE_SENTINEL_USERNAME'},{name:'NJT_API_PASSWORD',type:'secret_text',text:'PRIVATE_SENTINEL_PASSWORD'},
        {name:'HISTORY_COLLECTION',type:'plain_text',text:'enabled'}];let result;
      if(path==='/deployments')result={deployments:[{versions:[{version_id:id,percentage:100}]}]};
      else if(path==='/versions')result={items:[{id}]};
      else if(path.startsWith('/versions/'))result={id,resources:{script:{etag:id},script_runtime:{compatibility_date:'2026-11-06',compatibility_flags:['nodejs_compat'],migration_tag:'v1'}}};
      else if(path==='/settings'){settingsReads++;result={bindings};}
      else if(path==='/content/v2'){
        const f=new FormData();f.set('index.js',new Blob([scenario==='content-race'&&settingsReads>2?'PRIVATE_MODULE_CHANGED':'export default {private:"PRIVATE_MODULE_BYTES"}'],{type:'application/javascript+module'}),'index.js');
        if(scenario==='auxiliary'){
          f.set('data.bin',new Blob([new Uint8Array([0,255,128,17])],{type:'application/octet-stream'}),'data.bin');
          f.set('helper.js',new Blob(['PRIVATE_AUXILIARY_PAYLOAD'],{type:'text/javascript+module'}),'helper.js');
        }
        if(scenario==='inventory-overflow')for(let i=0;i<40;i++){const name='module-'+String(i).padStart(3,'0')+'x'.repeat(100);f.set(name,new Blob(['PRIVATE_AUXILIARY_PAYLOAD'],{type:'text/plain'}),name);}
        const r=new Response(f);r.headers.set('cf-entrypoint','index.js');return r;
      }else throw Error('FORBIDDEN_ENDPOINT');return Response.json({success:true,result});
    };
    await import(${JSON.stringify(entry)});
    assert.ok(reads<=18);if(['ok','auxiliary'].includes(scenario))assert.equal(reads,18,'CHANGED_REQUEST_COUNT');
  `], { env: { NODE_NO_WARNINGS: '1', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: scenario === 'wrong-branch' ? 'refs/heads/unreviewed' : 'refs/heads/main', GITHUB_REPOSITORY: 'jwchr/dale', GITHUB_SHA: 'a'.repeat(40),
    HISTORY_COLLECTION_MODE: 'qualify-enabled', CLOUDFLARE_API_TOKEN: 'PRIVATE_SENTINEL_TOKEN', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), DALE_WORKER_URL: 'https://dale-live.synthetic.workers.dev' }, encoding: 'utf8', timeout: 10000 });
}
it('native GET-only qualification obtains ACTUAL current pins without prior pins/agency credentials and emits only bounded non-secret observations', () => {
  const r = qualification('ok'); expect(r.error).toBeUndefined(); expect(r.status, r.stderr).toBe(0);
  const line = r.stdout.split('\n').find(s => s.startsWith('Enabled qualification observation: '))!;
  const receipt = JSON.parse(line.slice('Enabled qualification observation: '.length));
  expect(receipt.pins).toEqual({ versionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', canonicalContext: context });
  expect(receipt.v).toBe(2); expect(receipt.moduleInventory).toEqual({ entrypoint: 'index.js', modules: [{ name: 'index.js', filename: 'index.js', type: 'application/javascript+module', bytes: Buffer.byteLength('export default {private:"PRIVATE_MODULE_BYTES"}'), sha256: createHash('sha256').update('export default {private:"PRIVATE_MODULE_BYTES"}').digest('hex') }] });
  expect(receipt.observerSourceCommit).toBe('a'.repeat(40)); expect(receipt.sourceCommit).toBeUndefined();
  expect(receipt.reference.context).toBe(context); expect(receipt.referenceSHA256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.checkpoint.observations).toBe(100); expect(receipt.actorVersionAttested).toBe(false); expect(receipt.actorContextHashAttested).toBe(false);
  expect(receipt.currentZIPVerified).toBe(false); expect(receipt.rollbackEligibilityVerified).toBe(false); expect(receipt.operationAuthorized).toBe(false);
  expect(Buffer.byteLength(line)).toBeLessThan(8192);
  expect(r.stdout + r.stderr).not.toMatch(/PRIVATE_SENTINEL|PRIVATE_MODULE|PRIVATE_AUXILIARY|PRIVATE_NAMESPACE|PRIVATE_ARCHIVE_KEY|MAIN ST|stopIds|namespace_id|NJT_API_PASSWORD|FORBIDDEN|AssertionError/);
});
it.each(['disabled', 'wrong-feed', 'old-alarm', 'wrong-rate', 'quota', 'backlog', 'noncanonical', 'identity-race', 'wrong-bucket', 'denied', 'oversized', 'unknown-counter', 'wrong-branch', 'inventory-overflow', 'content-race'])('native qualification refuses %s, never mutates/polls/prepares and never leaks raw data', scenario => {
  const r = qualification(scenario); expect(r.error).toBeUndefined(); expect(r.status).toBe(1);
  expect(r.stdout).not.toContain('Enabled qualification observation:');
  expect(r.stdout + r.stderr).not.toMatch(/PRIVATE_SENTINEL|PRIVATE_MODULE|PRIVATE_AUXILIARY|PRIVATE_NAMESPACE|FORBIDDEN|AssertionError|https:/);
});
it('existing manual workflow scopes qualification to CF GET evidence, without NJT credentials or guessed input pins', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/live-worker.yml', import.meta.url), 'utf8');
  const step = workflow.split(/\n      - /).find(s => s.includes('GET-only enabled qualification'))!;
  expect(step).toContain("if: inputs.history_collection == 'qualify-enabled'"); expect(step).toContain('node scripts/deploy-live-worker.mjs');
  expect(step).not.toMatch(/NJT_API_|worker:prepare|stop-history|rollback_reference|canonical_context_key|expected_worker_version/);
});

it('native qualification reports every auxiliary and binary module with original inventory fields/digests, without more requests or payloads', () => {
  const r = qualification('auxiliary'); expect(r.error).toBeUndefined(); expect(r.status, r.stderr).toBe(0);
  const receipt = JSON.parse(r.stdout.split('Enabled qualification observation: ')[1]!.split('\n')[0]!);
  expect(receipt.moduleInventory.entrypoint).toBe('index.js');
  expect(receipt.moduleInventory.modules).toHaveLength(3);
  expect(receipt.moduleInventory.modules.map((m: { name: string }) => m.name)).toEqual(['data.bin', 'helper.js', 'index.js']);
  expect(receipt.moduleInventory.modules[0]).toEqual({ name: 'data.bin', filename: 'data.bin', type: 'application/octet-stream', bytes: 4, sha256: createHash('sha256').update(new Uint8Array([0, 255, 128, 17])).digest('hex') });
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
  expect(createHash('sha256').update(JSON.stringify(stable(receipt.moduleInventory))).digest('hex')).toBe(receipt.reference.contentSHA256);
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(MAX_QUALIFICATION_RECEIPT_BYTES);
  expect(r.stdout + r.stderr).not.toMatch(/PRIVATE_SENTINEL|PRIVATE_MODULE|PRIVATE_AUXILIARY|PRIVATE_NAMESPACE|PRIVATE_ARCHIVE_KEY|stopIds|namespace_id|FORBIDDEN|AssertionError/);
});
const moduleFixture = () => ({ name: 'index.js', filename: 'index.js', type: 'application/javascript+module', bytes: 1, sha256: 'a'.repeat(64) });
const contentFixture = () => ({ entrypoint: 'index.js', modules: [moduleFixture()] });
it('sanitized inventory preserves exact full metadata and copies rather than exposing mutable identity objects', () => {
  const content = contentFixture(), result = qualificationInventory(content);
  expect(result).toEqual(content); expect(result).not.toBe(content); expect(result.modules[0]).not.toBe(content.modules[0]);
  result.modules[0].bytes = 2; expect(content.modules[0]!.bytes).toBe(1);
});
it.each([
  ['control name', (c: any) => { c.modules[0].name = 'bad\nname'; }],
  ['overlong name', (c: any) => { c.modules[0].name = 'x'.repeat(1025); }],
  ['empty filename', (c: any) => { c.modules[0].filename = ''; }],
  ['control entrypoint', (c: any) => { c.entrypoint = 'index.js\r'; }],
  ['unexpected payload field', (c: any) => { c.modules[0].payload = 'PRIVATE_MODULE_BYTES'; }],
  ['unexpected content field', (c: any) => { c.private = 'PRIVATE_DESCRIPTOR'; }],
  ['missing digest', (c: any) => { delete c.modules[0].sha256; }],
  ['nonstring digest', (c: any) => { c.modules[0].sha256 = { toString: () => 'a'.repeat(64) }; }],
  ['malformed digest', (c: any) => { c.modules[0].sha256 = 'Z'.repeat(64); }],
  ['unsupported type', (c: any) => { c.modules[0].type = 'text/html'; }],
  ['fractional bytes', (c: any) => { c.modules[0].bytes = 1.5; }],
  ['negative bytes', (c: any) => { c.modules[0].bytes = -1; }],
  ['oversized bytes', (c: any) => { c.modules[0].bytes = 16 * 1024 * 1024 + 1; }],
  ['zero entrypoint', (c: any) => { c.modules[0].bytes = 0; }],
  ['missing entrypoint', (c: any) => { c.entrypoint = 'other.js'; }],
  ['empty modules', (c: any) => { c.modules = []; }],
  ['duplicate name', (c: any) => { c.modules.push({ ...moduleFixture(), filename: 'other.js' }); }],
  ['duplicate filename', (c: any) => { c.modules.push({ ...moduleFixture(), name: 'other.js' }); }],
  ['unsorted modules', (c: any) => { c.modules.push({ ...moduleFixture(), name: 'a.js', filename: 'a.js' }); }],
  ['excess count', (c: any) => { c.modules = Array.from({ length: 129 }, (_, i) => ({ ...moduleFixture(), name: String(i), filename: String(i) })); }],
  ['aggregate bytes', (c: any) => { c.modules.push({ ...moduleFixture(), name: 'other.js', filename: 'other.js', bytes: 16 * 1024 * 1024 }); }],
])('inventory refuses %s without truncating, reordering or leaking extra values', (_label, mutate) => {
  const content: any = contentFixture(); mutate(content);
  expect(() => qualificationInventory(content)).toThrow('enabled-qualification-unverified');
});
