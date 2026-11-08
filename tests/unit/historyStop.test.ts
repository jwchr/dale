import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Execute the real unbundled Node entrypoints with NO NJT credentials. All I/O is
// synthetic; long waits are accelerated here, not in the production stop command.
const stop = new URL('../../scripts/stop-history-collection.mjs', import.meta.url).href;
const deploy = new URL('../../scripts/deploy-live-worker.mjs', import.meta.url).href;
function run(scenario = 'ok', entry = stop, inspect = false) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const originalRead = fs.readFileSync;
    fs.readFileSync = (...args) => { if (String(args[0]).includes('generated/corridor')) throw Error('FORBIDDEN_STATIC'); return originalRead(...args); };
    cp.spawnSync = () => { throw Error('FORBIDDEN_DEPLOY_OR_CONVERSION'); };
    syncBuiltinESMExports();
    const scenario = ${JSON.stringify(scenario)};
    const inspect = ${JSON.stringify(inspect)};
    let patched = false, healthReads = 0, patchCount = 0, versionReads = 0, captures = 0;
    const bindings = [
      {name:'FEED',type:'durable_object_namespace',namespace_id:'synthetic-namespace'},
      {name:'HISTORY_ARCHIVE',type:'r2_bucket',bucket_name:'dale-history'},
      {name:'NJT_API_PASSWORD',type:'secret_text'},
      {name:'OTHER',type:'plain_text',text:'preserved'},
      {name:'HISTORY_COLLECTION',type:'plain_text',text:'enabled'}
    ];
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn,ms,...args) => realTimeout(fn, ms >= 1000 ? 0 : ms, ...args);
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(input);
      assert.equal(options.redirect,'error');
      if (url.hostname === 'dale-live.synthetic.workers.dev') {
        assert.equal(url.pathname,'/v1/collection');
        assert.equal(options.headers,undefined);
        assert.ok(patched);
        healthReads++;
        return Response.json({collection:{enabled:scenario === 'enabled-health', reason:scenario === 'enabled-health'?'collecting':'disabled',alarmAt:scenario === 'alarm'?1:null,observations:healthReads > 1 && scenario === 'advancing'?2:1,batches:1,bytes:123,lastAttemptAt:100,completedAttempt:100}});
      }
      assert.equal(url.origin,'https://api.cloudflare.com');
      assert.equal(options.headers.Authorization,'Bearer synthetic-token');
      assert.equal(url.pathname.startsWith('/client/v4/accounts/'+'a'.repeat(32)+'/workers/scripts/dale-live/'),true);
      const path = url.pathname.split('/dale-live')[1];
      if (scenario === 'hostile') throw Error('PRIVATE_SENTINEL_token_url_body_stack');
      if (scenario === 'timeout') throw new DOMException('PRIVATE_SENTINEL_timeout','TimeoutError');
      if (scenario === 'non-json') return new Response('PRIVATE_SENTINEL_raw_response',{status:200});
      if (scenario === 'denied') return new Response('',{status:403});
      let result;
      if (path === '/deployments') result={deployments:[{versions:[{version_id:scenario==='capture-race' && captures>0?'draft':inspect || patched?'v2':'v1',percentage:scenario === 'split'?50:100}]}]};
      else if (path === '/versions') { versionReads++; result={items:inspect?[{id:scenario === 'staged' || (scenario === 'inspect-race' && versionReads > 1)?'draft':'v2'},{id:'v1'}]:[{id:scenario === 'staged' || (scenario==='capture-race' && captures>0)?'draft':patched?'v2':'v1'}]}; }
      else if (path.startsWith('/versions/')) {
        const current = inspect ? path.endsWith('/v2') : patched;
        result={id:scenario==='wrong-version-response'?'wrong':path.split('/').at(-1),resources:{bindings:scenario === 'malformed-bindings'?{}:bindings.filter(b=>!(current && scenario === 'binding-loss' && b.name==='FEED')).map(b=>b.name==='HISTORY_COLLECTION' && (current || scenario==='wrong-pair')?{...b,text:'disabled'}:b),script:{etag:current && scenario === 'code-change'?'changed':'original-code-hash'},script_runtime:{compatibility_date:current && scenario === 'runtime-change'?'2026-10-02':'2026-10-01',compatibility_flags:[]}}};
      }
      else if (path === '/content/v2') {
        assert.equal(inspect,false,'FORBIDDEN_HISTORICAL_CONTENT');
        captures++;
        const form=new FormData();
        if(scenario==='aux-change')form.set('data.bin',new Blob([patched?'changed':'original'],{type:'application/octet-stream'}),'data.bin');
        form.set('index.js',new Blob([patched && scenario==='module-change'?'export default {changed:true}':'export default {}'],{type:'application/javascript+module'}),patched && scenario==='filename-change'?'transport-name.js':'index.js');
        const response=new Response(form);response.headers.set('cf-entrypoint','index.js');return response;
      }
      else if (path === '/settings' && options.method === 'PATCH') {
        patchCount++;
        assert.equal(inspect,false,'FORBIDDEN_INSPECTION_MUTATION');
        assert.equal(patchCount,1);
        assert.ok(options.body instanceof FormData);
        assert.deepEqual([...options.body.keys()],['settings']);
        const body = JSON.parse(options.body.get('settings'));
        assert.deepEqual(body,{bindings:[...bindings.filter(b=>b.name!=='HISTORY_COLLECTION').sort((a,b)=>a.name.localeCompare(b.name)).map(b=>({name:b.name,type:'inherit'})),{name:'HISTORY_COLLECTION',type:'plain_text',text:'disabled'}]});
        patched=true; result={};
      } else if (path === '/settings' && !inspect) result={bindings:bindings.filter(b=>!(patched && scenario==='binding-loss' && b.name==='FEED')).map(b=>b.name==='HISTORY_COLLECTION' && patched?{...b,text:'disabled'}:b)};
      else throw Error('FORBIDDEN_UPSTREAM_OR_OTHER_IO');
      return Response.json({success:true,result});
    };
    process.argv[1] = new URL(${JSON.stringify(entry)}).pathname;
    if (inspect) process.argv[2]='--inspect';
    await import(${JSON.stringify(entry)});
    if (inspect) { assert.equal(patchCount,0); assert.equal(healthReads,0); }
    else if (!process.exitCode) { assert.equal(patchCount,1); assert.equal(healthReads,2); }
  `], { env: { NODE_NO_WARNINGS:'1', GITHUB_EVENT_NAME:'workflow_dispatch', GITHUB_REF:'refs/heads/main', GITHUB_REPOSITORY:'jwchr/dale', HISTORY_COLLECTION_MODE:'disabled', CLOUDFLARE_API_TOKEN:'synthetic-token', CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32), DALE_WORKER_URL:'https://dale-live.synthetic.workers.dev' }, encoding:'utf8', timeout:10_000 });
}
it.each([stop, deploy])('native disabled entrypoint %s stops without NJT, static preparation or deployment', entry => {
  const result = run('ok',entry);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  expect(result.stderr).toBe(''); expect(result.stdout).toContain('counters unchanged across 35 seconds');
});
it.each(['denied','staged','split','binding-loss','module-change','runtime-change','enabled-health','alarm','advancing','hostile','timeout','non-json'])('stop fails closed for %s without raw diagnostics or rollback', scenario => {
  const result=run(scenario);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
  expect(result.stdout).toBe(''); expect(result.stderr).toContain('Cloudflare-only stop was not fully verified');
  expect(result.stderr).not.toMatch(/synthetic-token|FORBIDDEN|AssertionError|PRIVATE_SENTINEL|https:/);
});
it('disabled workflow reaches native stop before every enabled-only dependency', () => {
  const workflow=readFileSync(new URL('../../.github/workflows/live-worker.yml',import.meta.url),'utf8');
  const steps=workflow.split(/\n      - /);
  const stopStep=steps.find(s=>s.includes('run: node scripts/stop-history-collection.mjs\n'))!;
  expect(stopStep).toContain("if: inputs.history_collection == 'disabled'");
  expect(stopStep).not.toMatch(/NJT_API_|npm|worker:prepare/);
  for (const step of steps.filter(s=>/run: (npm ci|npm run worker:prepare|node scripts\/deploy-live-worker|node -e)/.test(s))) {
    expect(step).toContain("if: inputs.history_collection == 'enabled'");
  }
  expect(workflow.indexOf('run: node scripts/stop-history-collection.mjs')).toBeLessThan(workflow.indexOf('run: npm run worker:prepare'));
});

it.each([
  ['denied','stage=capture-before-content reason=worker-identity-request-failed http=403'],
  ['non-json','stage=capture-before-content reason=invalid-json'],
  ['timeout','stage=capture-before-content reason=request-timeout'],
  ['hostile','stage=capture-before-content reason=unexpected-failure'],
  ['binding-loss','stage=verify-preservation reason=stop-other-bindings-changed'],
  ['module-change','stage=verify-preservation reason=stop-module-content-changed'],
  ['runtime-change','stage=verify-preservation reason=stop-runtime-changed'],
])('emits a closed safe diagnostic for %s', (scenario, diagnostic) => {
  const result=run(scenario);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Stop diagnostic: '+diagnostic+'.');
  expect(result.stderr).not.toMatch(/PRIVATE_SENTINEL|synthetic-token|https:/);
});

it('rejects foreign and tampered error fields at the final logging boundary', () => {
  const result=spawnSync(process.execPath,['--input-type=module','--eval',`
    import assert from 'node:assert/strict';
    const {stopHistoryCollection,safeStopFailure}=await import(${JSON.stringify(stop)});
    assert.equal(safeStopFailure(Error('PRIVATE_SENTINEL')), 'stage=unknown reason=unexpected-failure');
    try { await stopHistoryCollection({}); } catch(error) {
      assert.equal(safeStopFailure(error),'stage=authorization reason=manual-main-required');
      error.status='PRIVATE_SENTINEL';
      assert.equal(safeStopFailure(error),'stage=authorization reason=manual-main-required');
      error.reason='PRIVATE_SENTINEL';
      assert.equal(safeStopFailure(error),'stage=unknown reason=unexpected-failure');
    }
  `],{env:{NODE_NO_WARNINGS:'1'},encoding:'utf8',timeout:10000});
  expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout).toBe('');
});

it('actual inspect entrypoint compares the original adjacent transition without mutation', () => {
  const result=run('ok',stop,true);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe('');
  expect(result.stdout).toBe('Original adjacent stop comparison: codeEqual=true runtimeEqual=true bindingsEqual=true enabledToDisabled=true activeLatest=true.\n');
  expect(result.stdout).not.toMatch(/v1|v2|synthetic|namespace|dale-history/);
});
it.each(['wrong-pair','malformed-bindings','inspect-race','staged','split','binding-loss','code-change','runtime-change','hostile','non-json','timeout','denied'])('GET-only inspection refuses %s without any mutation or raw values', scenario => {
  const result=run(scenario,stop,true);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
  const reason=['binding-loss','code-change','runtime-change'].includes(scenario)?'stop-original-preservation-unverified':scenario==='hostile'?'unexpected-failure':scenario==='non-json'?'invalid-json':scenario==='timeout'?'request-timeout':scenario==='denied'?'cloudflare-stop-request-failed':'stop-original-transition-unavailable';
  expect(result.stderr).toContain('reason='+reason);
  expect(result.stderr+result.stdout).not.toMatch(/PRIVATE_SENTINEL|synthetic-token|FORBIDDEN|AssertionError|original-code-hash|https:/);
});
it('inspection workflow supplies no NJT credentials and uses only the GET-only command', () => {
  const workflow=readFileSync(new URL('../../.github/workflows/live-worker.yml',import.meta.url),'utf8');
  const step=workflow.split(/\n      - /).find(s=>s.includes('run: node scripts/stop-history-collection.mjs --inspect'))!;
  expect(step).toContain("if: inputs.history_collection == 'inspect'");
  expect(step).not.toMatch(/NJT_API_|npm|worker:prepare|deploy-live-worker/);
});

it('does not confuse an etag-only change with executable equality: complete exact modules are required', () => {
  const result=run('code-change');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('completeModulesEqual=true metadataEtagEqual=false');
});

it.each([
  ['capture-race','worker-identity-state-changed'],
  ['wrong-version-response','worker-identity-metadata-invalid'],
  ['aux-change','stop-module-content-changed'],
])('strict current content proof refuses %s', (scenario, reason)=>{
  const result=run(scenario);expect(result.error).toBeUndefined();expect(result.status).toBe(1);
  expect(result.stderr).toContain('reason='+reason);expect(result.stdout).toBe('');
  expect(result.stderr).not.toMatch(/synthetic-token|PRIVATE_SENTINEL|AssertionError|FORBIDDEN/);
});

it('actual stop reports filename-only mismatch as booleans and still refuses it',()=>{
  const r=run('filename-change');expect(r.status).toBe(1);
  expect(r.stderr).toContain('"filenamesEqual":false');
  expect(r.stderr).toContain('"byteDigestsEqual":true');expect(r.stderr).toContain('"lengthsEqual":true');
  expect(r.stderr).toContain('reason=stop-module-content-changed');
  expect(r.stderr).not.toMatch(/transport-name|synthetic-token|index\.js|original-code-hash/);
});
