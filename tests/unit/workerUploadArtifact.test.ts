// Actual pinned Wrangler compiler/output, never a Worker deployment or NJT call.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error Native deployment helper intentionally has no bundled declaration.
import { verifyUploadedWorker } from '../../scripts/worker-deployment-proof.mjs';
it('actual pinned Wrangler dry-run output including its known README binds to the complete uploaded module manifest',async()=>{
  const temporary=mkdtempSync(join(tmpdir(),'dale-real-upload-proof-'));
  try {
    writeFileSync(join(temporary,'index.js'),'export default {fetch(){return new Response("SYNTHETIC")}};');
    writeFileSync(join(temporary,'wrangler.json'),JSON.stringify({name:'dale-live',main:'index.js',compatibility_date:'2026-11-06',compatibility_flags:['nodejs_compat'],upload_source_maps:false}));
    const out=join(temporary,'output');
    const compile=spawnSync(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'deploy','--dry-run','--config',join(temporary,'wrangler.json'),'--outdir',out],{
      env:{PATH:process.env.PATH,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG:'error'},encoding:'utf8',timeout:30000,
    });
    expect(compile.error).toBeUndefined();expect(compile.status,compile.stderr).toBe(0);
    expect(readdirSync(out)).toContain('README.md');
    expect(readFileSync(join(out,'README.md'),'utf8')).toMatch(/^This folder contains the built output assets for the worker "dale-live" generated at /);
    const uploadedBytes=readFileSync(join(out,'index.js'));
    let gets=0;
    const bindings=[{name:'FEED',type:'durable_object_namespace',namespace_id:'synthetic'},{name:'HISTORY_ARCHIVE',type:'r2_bucket',bucket_name:'dale-history'},{name:'HISTORY_COLLECTION',type:'plain_text',text:'disabled'}];
    const runtime={compatibility_date:'2026-11-06',compatibility_flags:['nodejs_compat'],migration_tag:'v1'};
    const fetchImpl=async(input: string,options:{method:string})=>{
      gets++;expect(options.method).toBe('GET');
      const path=new URL(input).pathname.split('/dale-live')[1];
      if(path==='/content/v2'){
        const form=new FormData();form.set('index.js',new Blob([uploadedBytes],{type:'application/javascript+module'}),'index.js');
        const response=new Response(form);response.headers.set('cf-entrypoint','index.js');return response;
      }
      const result=path==='/deployments'?{deployments:[{versions:[{version_id:'v1',percentage:100}]}]}:path==='/versions'?{items:[{id:'v1'}]}:path==='/versions/v1'?{id:'v1',resources:{script:{etag:'synthetic'},script_runtime:runtime}}:path==='/settings'?{bindings}:undefined;
      if(!result)throw Error('Unexpected network endpoint');
      return Response.json({success:true,result});
    };
    const env={GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'jwchr/dale',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic'};
    const proof=await verifyUploadedWorker(env,out,{runtime,bindings},{fetchImpl});
    expect(proof.content.modules).toHaveLength(1);expect(gets).toBeGreaterThan(0);
    writeFileSync(join(out,'README.md'),'arbitrary source is not known build documentation');
    await expect(verifyUploadedWorker(env,out,{runtime,bindings},{fetchImpl})).rejects.toThrow('worker-upload-artifact-invalid');
    writeFileSync(join(out,'README.md'),'This folder contains the built output assets for the worker "dale-live" generated at 2026-11-08T10:00:00.000Z.');
    writeFileSync(join(out,'extra.js'),'export default "unmanifested"');
    await expect(verifyUploadedWorker(env,out,{runtime,bindings},{fetchImpl})).rejects.toThrow('worker-upload-artifact-invalid');
  }finally{rmSync(temporary,{recursive:true,force:true});}
},40000);
