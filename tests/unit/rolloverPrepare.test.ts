import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import { miniFiles, NOW } from '../helpers/liveBus';
// @ts-expect-error established pure GTFS converter
import { buildDataset } from '../../scripts/gtfs-lib.mjs';
const entry = new URL('../../scripts/prepare-live-worker.mjs', import.meta.url).href;
const zip = (input: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, strToU8(v)])));
function rollover(scenario: string) {
  const files: Record<string, string> = { ...miniFiles,
    'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n' + Array.from({ length: 12 }, (_, i) => `${i === 11 ? '11' : '10'},WK,T${i},${i === 11 ? '165T' : '165'} NEW YORK,0,s\n`).join(''),
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,shape_dist_traveled\n' + Array.from({ length: 12 }, (_, i) => `T${i},07:00:00,07:00:00,1,1,0\nT${i},07:20:00,07:20:00,2,2,10\nT${i},07:40:00,07:40:00,3,3,20\n`).join(''),
    'shapes.txt': 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\ns,40.88,-74.045,1,0\ns,40.87,-74.04,2,10\ns,40.757,-73.991,3,20\n',
  };
  const source = zip(files), sha = createHash('sha256').update(source).digest('hex');
  const ds = buildDataset(files, { routeShortNames: ['165', '165T'], splitVariants: true, scheduledOnly: true, feedVersion: sha.slice(0, 12), source: 'NJ Transit GTFS BUS G2', builtAt: '2026-11-01T00:00:00Z' });
  ds.meta.realtime = { provider: 'njt-bus-g2' };
  const text = JSON.stringify(ds), context = ds.meta.feedVersion + ':' + createHash('sha256').update(text).digest('hex');
  // NJ Transit's next rolling window: every day through Nov 30 and one retimed trip.
  const next: Record<string, string> = { ...files,
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,1,1,20261101,' + (scenario === 'coverage-gap' ? '20261106' : '20261130') + '\n',
    'stop_times.txt': files['stop_times.txt']!.replace('T0,07:40:00,07:40:00', 'T0,07:45:00,07:45:00') };
  if (scenario === 'no-geometry') next['shapes.txt'] = '';
  const downloaded = scenario === 'unchanged' ? source : zip(next);
  const nextFeed = createHash('sha256').update(downloaded).digest('hex').slice(0, 12);
  return { feed: ds.meta.feedVersion, nextFeed, context, result: spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {createHash} from 'node:crypto';
    const scenario=${JSON.stringify(scenario)}, text=${JSON.stringify(text)}, feed=${JSON.stringify(ds.meta.feedVersion)}, context=${JSON.stringify(context)}, nextFeed=${JSON.stringify(nextFeed)}, now=${NOW};
    Date.now=()=>now;
    const writes=new Map(), modes=new Map(), actualMkdir=fs.mkdirSync;
    fs.writeFileSync=(path,value,options)=>{assert.ok(String(path).includes('/worker/generated/'));const name=String(path).split('/').pop();writes.set(name,String(value));modes.set(name,options?.mode);};
    fs.mkdirSync=(path,...args)=>String(path).includes('/worker/generated/')?undefined:actualMkdir(path,...args);
    syncBuiltinESMExports();
    let auth=0,download=0,cities=0;
    globalThis.fetch=async(input,options={})=>{
      const url=new URL(input);
      if(url.origin==='https://pcsdata.njtransit.com'){
        assert.equal(options.method,'POST');assert.equal(options.redirect,'manual');
        if(url.pathname.endsWith('/authenticateUser')){auth++;return Response.json({Authenticated:true,UserToken:'PRIVATE_SENTINEL_TOKEN'});}
        assert.ok(url.pathname.endsWith('/getGTFS'));download++;return new Response(Buffer.from(${JSON.stringify(Buffer.from(downloaded).toString('base64'))},'base64'));
      }
      assert.equal(options.redirect,'error');assert.ok(!options.method||options.method==='GET');
      if(url.hostname==='services6.arcgis.com'){cities++;return new Response('unavailable',{status:503});}
      if(url.hostname==='dale-live.synthetic.workers.dev'){
        if(url.pathname==='/v1/schedule')return new Response(scenario==='changed-canonical'?text+' ':text);
        assert.equal(url.pathname,'/v1/collection');
        return Response.json({collection:{enabled:true,error:false,stale:false,reason:'collecting',scheduleVersion:feed,scheduleContextStored:true,
          alarmAt:now+30000,effectiveIntervalMs:30000,lastSuccessAt:now-1000,lastAttemptAt:now-1000,completedAttempt:now-1000,observations:100,batches:20,
          bytes:scenario==='capacity-bytes'?249999000:1000,reservedWrites:scenario==='capacity-writes'?74500:100,databaseBytes:2000,pendingInterruptionCount:0,
          byteLimit:250000000,databaseByteLimit:500000000,dailyWriteReservationLimit:75000,budgetDay:'2026-11-04',
          archive:{configured:true,reason:'ready',failures:0,verifiedObjects:21,lastSuccessAt:now-500,reservedBytes:5000,classAReserved32Days:30,classBReserved32Days:30,
            sqlWriteBudgetRemaining:74000,oldestUnarchivedAt:null,backlogAgeMs:0,byteLimit:9000000000,classALimit32Days:800000,classBLimit32Days:8000000}}});
      }
      assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(options.headers.Authorization,'Bearer PRIVATE_SENTINEL_CF');
      const path=url.pathname.split('/dale-live')[1],id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';let result;
      if(path==='/deployments')result={deployments:[{versions:[{version_id:id,percentage:100}]}]};
      else if(path==='/versions')result={items:[{id}]};
      else if(path.startsWith('/versions/'))result={id,resources:{script:{etag:id},script_runtime:{compatibility_date:'2026-11-06',compatibility_flags:['nodejs_compat'],migration_tag:'v1'}}};
      else if(path==='/settings')result={bindings:[{name:'HISTORY_COLLECTION',type:'plain_text',text:'enabled'},{name:'FEED',type:'durable_object_namespace',namespace_id:'retained'},{name:'HISTORY_ARCHIVE',type:'r2_bucket',bucket_name:'dale-history'},{name:'NJT_API_USERNAME',type:'secret_text'},{name:'NJT_API_PASSWORD',type:'secret_text'}]};
      else if(path==='/content/v2'){const f=new FormData();f.set('index.js',new Blob(['export default {}'],{type:'application/javascript+module'}),'index.js');const r=new Response(f);r.headers.set('cf-entrypoint','index.js');return r;}
      else throw Error('FORBIDDEN_ENDPOINT');return Response.json({success:true,result});
    };
    await import(${JSON.stringify(entry)});
    const preflightRefusal=['changed-canonical','wrong-version'].includes(scenario);
    assert.equal(auth,preflightRefusal?0:1);assert.equal(download,auth);
    assert.ok(!writes.has('preservation.json'));
    if(['ok','no-geometry'].includes(scenario)){
      const corridor=writes.get('corridor.json'),parsed=JSON.parse(corridor);
      assert.notEqual(corridor,text);assert.equal(parsed.meta.feedVersion,nextFeed);assert.equal(cities,1);
      const receipt=JSON.parse(writes.get('rollover.json'));assert.equal(modes.get('rollover.json'),0o600);
      assert.deepEqual(Object.keys(receipt).sort(),['checkpoint','fromContext','identity','kind','toContext','toFeedVersion','v']);
      assert.equal(receipt.v,1);assert.equal(receipt.kind,'rollover');assert.equal(receipt.fromContext,context);assert.equal(receipt.toFeedVersion,nextFeed);
      assert.equal(receipt.toContext,nextFeed+':'+createHash('sha256').update(corridor).digest('hex'));
      assert.equal(receipt.identity.versionId,'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');assert.equal(receipt.checkpoint.feedVersion,feed);assert.equal(receipt.checkpoint.observations,100);
      if(scenario==='ok'){const g=JSON.parse(writes.get('route-geometry.json'));assert.equal(g.feedVersion,nextFeed);assert.equal(Object.keys(g.trips).length,12);}
      else assert.equal(writes.get('route-geometry.json'),'null');
    }else assert.equal(writes.size,0);
  `], { env: { NODE_NO_WARNINGS: '1', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'jwchr/dale',
    HISTORY_COLLECTION_MODE: 'rollover-enabled', HISTORY_CANONICAL_CONTEXT: context,
    HISTORY_EXPECTED_WORKER_VERSION: scenario === 'wrong-version' ? 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee' : 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    CLOUDFLARE_API_TOKEN: 'PRIVATE_SENTINEL_CF', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), DALE_WORKER_URL: 'https://dale-live.synthetic.workers.dev', NJT_API_USERNAME: 'PRIVATE_SENTINEL_USER', NJT_API_PASSWORD: 'PRIVATE_SENTINEL_PASSWORD' }, encoding: 'utf8', timeout: 15000 }) };
}
const SECRET = /PRIVATE_SENTINEL|FORBIDDEN|AssertionError/;
it('prepares a changed NJ Transit file as a fresh canonical schedule with an aggregate comparison and a rollover receipt', () => {
  const { result: r, feed, nextFeed } = rollover('ok'); expect(r.error).toBeUndefined(); expect(r.status, r.stderr).toBe(0);
  expect(r.stdout + r.stderr).not.toMatch(SECRET);
  const line = r.stdout.split('\n').find(l => l.startsWith('Schedule rollover comparison (aggregate counts and dates only): '))!;
  const summary = JSON.parse(line.split('only): ')[1]!);
  expect(summary.deployed.feedVersion).toBe(feed); expect(summary.candidate.feedVersion).toBe(nextFeed);
  expect(summary.trips).toMatchObject({ common: 12, coreChanged: 1 });
  expect(r.stdout).toMatch(/^Plain summary: Trips on Dale's routes first differ on /m);
  expect(r.stdout).toContain('Rollover coverage: every service date from 20261104 to 20261111 has corridor trips');
  const capacity = JSON.parse(r.stdout.split('Rollover capacity (aggregate only): ')[1]!.split('\n')[0]!);
  expect(capacity).toMatchObject({ contextParts: 1, contextWriteUnits: 6, reservedWrites: 100, writeHeadroom: 600, databaseBytes: 2000 });
  // Aggregate only: no trip IDs, stop names or times reach the public log.
  expect(r.stdout).not.toMatch(/"T\d+"|FIXTURE TERMINAL|07:45/);
  expect(r.stdout).toContain('Official G2 corridor prepared');
});
it.each([
  ['unchanged', 'rollover-same-schedule-file'], ['coverage-gap', 'rollover-coverage'],
  ['capacity-bytes', 'rollover-capacity'], ['capacity-writes', 'rollover-capacity'],
  ['changed-canonical', 'enabled-preservation-preflight'], ['wrong-version', 'enabled-preservation-preflight'],
])('refuses %s at %s without writing anything', (scenario, phase) => {
  const { result: r } = rollover(scenario); expect(r.error).toBeUndefined(); expect(r.status).toBe(1);
  expect(r.stderr.trim().split('\n').pop()).toBe(`Official G2 corridor preparation failed at ${phase}. No credentials, token or response details are logged. Do not deploy.`);
  expect(r.stdout + r.stderr).not.toMatch(SECRET);
  if (scenario.startsWith('capacity')) expect(r.stdout).toContain('Rollover capacity (aggregate only): ');
});
it('ships the new schedule with route distance off when geometry fails, printing only the aggregate diagnostic', () => {
  const { result: r } = rollover('no-geometry'); expect(r.error).toBeUndefined(); expect(r.status, r.stderr).toBe(0);
  const lines = r.stdout.split('\n');
  const diagnostic = lines.find(l => l.startsWith('Geometry diagnostic (aggregate counts only): '))!;
  expect(JSON.parse(diagnostic.split('only): ')[1]!)).toMatchObject({ v: 1, reason: 'no-matched-trips', counts: { shapesFile: 0, matchedTrips: 0 } });
  expect(lines).toContain('Route distance stays off for this schedule; the schedule rollover continues.');
  expect(r.stdout + r.stderr).not.toMatch(SECRET);
});
