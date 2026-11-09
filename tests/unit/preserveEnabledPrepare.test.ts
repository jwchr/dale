import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import { miniFiles, NOW } from '../helpers/liveBus';
// @ts-expect-error established pure GTFS converter
import { buildDataset } from '../../scripts/gtfs-lib.mjs';
const entry = new URL('../../scripts/prepare-live-worker.mjs', import.meta.url).href;
function preparation(scenario: string) {
  const files: Record<string, string> = { ...miniFiles,
    'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n' + Array.from({ length: 12 }, (_, i) => `${i === 11 ? '11' : '10'},WK,T${i},${i === 11 ? '165T' : '165'} NEW YORK,0,s\n`).join(''),
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,shape_dist_traveled\n' + Array.from({ length: 12 }, (_, i) => `T${i},07:00:00,07:00:00,1,1,0\nT${i},07:20:00,07:20:00,2,2,10\nT${i},07:40:00,07:40:00,3,3,20\n`).join(''),
    'shapes.txt': 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\ns,40.88,-74.045,1,0\ns,40.87,-74.04,2,10\ns,40.757,-73.991,3,20\n',
  };
  if (scenario === 'no-geometry') files['shapes.txt'] = '';
  const zip = (input: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, strToU8(v)])));
  const source = zip(files), sha = createHash('sha256').update(source).digest('hex');
  const ds = buildDataset(files, { routeShortNames: ['165', '165T'], splitVariants: true, scheduledOnly: true, feedVersion: sha.slice(0, 12), source: 'NJ Transit GTFS BUS G2', builtAt: '2026-11-01T00:00:00Z' });
  ds.meta.realtime = { provider: 'njt-bus-g2' };
  const text = JSON.stringify(ds), context = ds.meta.feedVersion + ':' + createHash('sha256').update(text).digest('hex');
  const downloaded = scenario === 'changed-zip' ? zip({ ...files, 'agency.txt': files['agency.txt'] + '\n' }) : source;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const scenario=${JSON.stringify(scenario)}, text=${JSON.stringify(text)}, feed=${JSON.stringify(ds.meta.feedVersion)}, context=${JSON.stringify(context)}, now=${NOW};
    Date.now=()=>now;
    const writes=new Map(), actualWrite=fs.writeFileSync, actualMkdir=fs.mkdirSync;
    fs.writeFileSync=(path,value)=>{assert.ok(String(path).includes('/worker/generated/'));writes.set(String(path).split('/').pop(),String(value));};
    fs.mkdirSync=(path,...args)=>String(path).includes('/worker/generated/')?undefined:actualMkdir(path,...args);
    syncBuiltinESMExports();
    let auth=0,download=0;
    globalThis.fetch=async(input,options={})=>{
      const url=new URL(input);
      if(url.origin==='https://pcsdata.njtransit.com'){
        assert.equal(options.method,'POST');assert.equal(options.redirect,'manual');
        if(url.pathname.endsWith('/authenticateUser')){auth++;return Response.json({Authenticated:true,UserToken:'PRIVATE_SENTINEL_TOKEN'});}
        assert.ok(url.pathname.endsWith('/getGTFS'));download++;return new Response(Buffer.from(${JSON.stringify(Buffer.from(downloaded).toString('base64'))},'base64'));
      }
      assert.equal(options.redirect,'error');assert.ok(!options.method||options.method==='GET');
      if(url.hostname==='dale-live.synthetic.workers.dev'){
        if(url.pathname==='/v1/schedule')return new Response(scenario==='changed-canonical'?text+' ':text);
        assert.equal(url.pathname,'/v1/collection');
        return Response.json({collection:{enabled:scenario!=='disabled',error:false,stale:false,reason:'collecting',scheduleVersion:feed,scheduleContextStored:true,
          alarmAt:now+30000,effectiveIntervalMs:30000,lastSuccessAt:now-1000,lastAttemptAt:now-1000,completedAttempt:now-1000,observations:100,batches:20,bytes:1000,
          reservedWrites:100,databaseBytes:2000,pendingInterruptionCount:0,byteLimit:250000000,databaseByteLimit:500000000,dailyWriteReservationLimit:75000,budgetDay:'2026-11-04',
          archive:{configured:true,reason:'ready',failures:0,verifiedObjects:21,lastSuccessAt:now-500,reservedBytes:5000,classAReserved32Days:30,classBReserved32Days:30,
            sqlWriteBudgetRemaining:74000,oldestUnarchivedAt:null,backlogAgeMs:0,byteLimit:9000000000,classALimit32Days:800000,classBLimit32Days:8000000}}});
      }
      assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(options.headers.Authorization,'Bearer PRIVATE_SENTINEL_CF');
      const path=url.pathname.split('/dale-live')[1],id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';let result;
      if(path==='/deployments')result={deployments:[{versions:[{version_id:id,percentage:100}]}]};
      else if(path==='/versions')result={items:[{id}]};
      else if(path.startsWith('/versions/'))result={id,resources:{script:{etag:id},script_runtime:{compatibility_date:'2026-11-06',compatibility_flags:['nodejs_compat'],migration_tag:'v1'}}};
      else if(path==='/settings')result={bindings:[{name:'HISTORY_COLLECTION',type:'plain_text',text:'enabled'},{name:'FEED',type:'durable_object_namespace',namespace_id:'retained'},{name:'HISTORY_ARCHIVE',type:'r2_bucket',bucket_name:scenario==='wrong-bucket'?'other-bucket':'dale-history'},{name:'NJT_API_USERNAME',type:'secret_text'},{name:'NJT_API_PASSWORD',type:'secret_text'}]};
      else if(path==='/content/v2'){const f=new FormData();f.set('index.js',new Blob(['export default {}'],{type:'application/javascript+module'}),'index.js');const r=new Response(f);r.headers.set('cf-entrypoint','index.js');return r;}
      else throw Error('FORBIDDEN_ENDPOINT');return Response.json({success:true,result});
    };
    await import(${JSON.stringify(entry)});
    assert.equal(auth,['disabled','changed-canonical','wrong-bucket','missing-pins'].includes(scenario)?0:1);assert.equal(download,auth);
    if(scenario==='ok'){
      assert.equal(writes.get('corridor.json'),text);
      const g=JSON.parse(writes.get('route-geometry.json'));assert.equal(g.feedVersion,feed);assert.equal(Object.keys(g.trips).length,12);
      assert.equal(JSON.parse(writes.get('preservation.json')).context,context);
    }else assert.equal(writes.size,0);
  `], { env: { NODE_NO_WARNINGS: '1', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'jwchr/dale',
    HISTORY_COLLECTION_MODE: 'preserve-enabled', HISTORY_CANONICAL_CONTEXT: scenario === 'missing-pins' ? '' : context, HISTORY_EXPECTED_WORKER_VERSION: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    CLOUDFLARE_API_TOKEN: 'PRIVATE_SENTINEL_CF', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), DALE_WORKER_URL: 'https://dale-live.synthetic.workers.dev', NJT_API_USERNAME: 'PRIVATE_SENTINEL_USER', NJT_API_PASSWORD: 'PRIVATE_SENTINEL_PASSWORD' }, encoding: 'utf8', timeout: 10000 });
}
it('actual native SAME-FETCH preservation reuses byte-identical canonical context and derives geometry with no city lookup or second download', () => {
  const r = preparation('ok'); expect(r.error).toBeUndefined(); expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain('Official G2 corridor prepared'); expect(r.stdout + r.stderr).not.toMatch(/PRIVATE_SENTINEL|FORBIDDEN|AssertionError/);
});
it.each(['changed-zip', 'disabled', 'changed-canonical', 'no-geometry', 'wrong-bucket', 'missing-pins'])('native preparation refuses %s without writing a replacement context or candidate', scenario => {
  const r = preparation(scenario); expect(r.error).toBeUndefined(); expect(r.status).toBe(1);
  expect(r.stdout + r.stderr).not.toMatch(/PRIVATE_SENTINEL|FORBIDDEN|AssertionError/);
});
