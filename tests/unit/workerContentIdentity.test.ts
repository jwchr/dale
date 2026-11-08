import { expect, it } from 'vitest';
// @ts-expect-error Native deployment helper is intentionally unbundled JavaScript.
import { workerContentIdentity, workerContentComparison } from '../../scripts/worker-content-identity.mjs';
function content(main='export default {}', entry='index.js', reverse=false) {
  const form=new FormData();
  const files: [string,string,string][] = [['index.js',main,'application/javascript+module'],['data.bin','\u0000\u00ff','application/octet-stream']];
  for (const [name,body,type] of reverse?files.reverse():files) form.append(name,new Blob([body],{type}),name);
  const response=new Response(form); response.headers.set('cf-entrypoint',entry); return response;
}
it('compares every module byte, name/type and entrypoint independently of multipart boundaries/order', async () => {
  const a=await workerContentIdentity(content()); const b=await workerContentIdentity(content(undefined,undefined,true));
  expect(a).toEqual(b); expect(a.modules).toHaveLength(2);
  expect(await workerContentIdentity(content('export default {changed:true}'))).not.toEqual(a);
  expect(await workerContentIdentity(content(undefined,'data.bin'))).not.toEqual(a);
});
it.each(['missing-entry','not-multipart','http-error','wrong-entry','oversized','duplicate','truncated'])('fails closed on %s without returning source content', async scenario => {
  let response=content();
  if(scenario==='missing-entry')response.headers.delete('cf-entrypoint');
  if(scenario==='not-multipart')response=new Response('PRIVATE_SENTINEL',{headers:{'content-type':'text/javascript'}});
  if(scenario==='http-error')response=new Response('PRIVATE_SENTINEL',{status:403});
  if(scenario==='wrong-entry')response.headers.set('cf-entrypoint','missing.js');
  if(scenario==='oversized')response.headers.set('content-length',String(16*1024*1024+1));
  if(scenario==='duplicate'){const f=new FormData();f.append('index.js',new Blob(['a'],{type:'text/javascript'}),'index.js');f.append('index.js',new Blob(['b'],{type:'text/javascript'}),'index.js');response=new Response(f);response.headers.set('cf-entrypoint','index.js');}
  if(scenario==='truncated')response=new Response('PRIVATE_SENTINEL',{headers:{'content-type':'multipart/form-data; boundary=missing','cf-entrypoint':'index.js'}});
  await expect(workerContentIdentity(response)).rejects.toThrow();
});
it.each(['name','filename','type','auxiliary-byte','missing-auxiliary'])('retains strict %s identity', async change=>{
  const base=await workerContentIdentity(content());
  const form=new FormData();
  form.set('index.js',new Blob(['export default {}'],{type:'application/javascript+module'}),'index.js');
  if(change!=='missing-auxiliary')form.set(change==='name'?'renamed.bin':'data.bin',new Blob([change==='auxiliary-byte'?'changed':'\u0000\u00ff'],{type:change==='type'?'text/plain':'application/octet-stream'}),change==='filename'?'renamed.bin':'data.bin');
  const response=new Response(form);response.headers.set('cf-entrypoint','index.js');
  expect(await workerContentIdentity(response)).not.toEqual(base);
});
it.each(['unknown-type','duplicate-filename','stream-limit','length-mismatch'])('rejects %s', async change=>{
  const form=new FormData();form.set('index.js',new Blob(['a'],{type:change==='unknown-type'?'application/unknown':'application/javascript+module'}),'index.js');
  if(change==='duplicate-filename')form.set('other.js',new Blob(['b'],{type:'application/javascript+module'}),'index.js');
  let response=new Response(form);response.headers.set('cf-entrypoint','index.js');
  if(change==='length-mismatch')response.headers.set('content-length','1');
  if(change==='stream-limit')response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(16*1024*1024+1));c.close();}}),{headers:{'content-type':'multipart/form-data; boundary=x','cf-entrypoint':'index.js'}});
  await expect(workerContentIdentity(response)).rejects.toThrow();
});
function rawPart(payload: Uint8Array, headers='Content-Disposition: form-data; name="index.js"\r\nContent-Type: application/javascript+module') {
  return new Response(Buffer.concat([Buffer.from('--proof\r\n'+headers+'\r\n\r\n'),payload,Buffer.from('\r\n--proof--\r\n')]),{headers:{'content-type':'multipart/form-data; boundary=proof','cf-entrypoint':'index.js'}});
}
it('preserves distinct invalid-UTF8 bytes even in filename-less parts',async()=>{
  const a=await workerContentIdentity(rawPart(new Uint8Array([255])));
  const b=await workerContentIdentity(rawPart(new Uint8Array([254])));
  expect(a).not.toEqual(b); expect(a.modules[0].bytes).toBe(1);
});
it('keeps boundary-looking binary payload exact',async()=>{
  const payload=Buffer.from('x\r\n--proofXdata');
  const value=await workerContentIdentity(rawPart(payload));expect(value.modules[0].bytes).toBe(payload.length);
});
it.each(['Content-Disposition: form-data; name="index.js"\r\nContent-Transfer-Encoding: base64','Content-Disposition: form-data; name="index.js"\r\nContent-Type: text/plain\r\nContent-Type: text/javascript','Bad header','Content-Disposition: form-data; name="index.js"\r\nUnknown: private'])('rejects ambiguous or unsupported MIME headers',async headers=>{
  await expect(workerContentIdentity(rawPart(Buffer.from('a'),headers))).rejects.toThrow();
});

it.each(['entrypoint','name','filename','type','bytes','sha256'])('closed field comparison isolates %s without exposing values',field=>{
  const before={entrypoint:'PRIVATE_SENTINEL_ENTRY',modules:[{name:'PRIVATE_SENTINEL_NAME',filename:'PRIVATE_SENTINEL_FILE',type:'PRIVATE_SENTINEL_TYPE',bytes:123,sha256:'PRIVATE_SENTINEL_HASH'}]};
  const after=structuredClone(before);
  if(field==='entrypoint')after.entrypoint='changed';else(after.modules[0] as Record<string,unknown>)[field]=field==='bytes'?124:'changed';
  const diagnostic=workerContentComparison(before,after);
  const key=({entrypoint:'entrypointEqual',name:'namesEqual',filename:'filenamesEqual',type:'typesEqual',bytes:'lengthsEqual',sha256:'byteDigestsEqual'} as Record<string,string>)[field];
  expect(Object.entries(diagnostic).filter(([,equal])=>!equal).map(([name])=>name)).toEqual([key]);
  expect(Object.values(diagnostic).every(value=>typeof value==='boolean')).toBe(true);
  expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE_SENTINEL|123|124|changed/);
});
