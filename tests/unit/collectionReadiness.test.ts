import { expect, it } from 'vitest';
// @ts-expect-error Native shared verification helper has no declaration.
import { waitForReadiness } from '../../scripts/collection-readiness.mjs';
it.each([30_000, 65_000])('read-only readiness can appear after %i ms without changing proof conditions', async readyAt => {
 let now=0,reads=0;
 const result=await waitForReadiness(async (timeout:number)=>{reads++;expect(timeout).toBeLessThanOrEqual(10_000);return now>=readyAt?{verified:true}:undefined;},{clock:()=>now,sleep:async(ms:number)=>{now+=ms;}});
 expect(result).toEqual({verified:true});expect(now).toBe(readyAt);expect(reads).toBe(readyAt/1000+1);
});
it('never-ready fails closed by the absolute120second deadline including request time',async()=>{
 let now=0;
 const result=await waitForReadiness(async(timeout:number)=>{now+=timeout;return undefined;},{clock:()=>now,sleep:async(ms:number)=>{now+=ms;}});
 expect(result).toBeUndefined();expect(now).toBe(120_000);
});
it('a result arriving at or after the deadline is rejected',async()=>{
 let now=0;
 expect(await waitForReadiness(async()=>{now=120_000;return {verified:true};},{clock:()=>now})).toBeUndefined();
});
it('request failures propagate without retry or mutation',async()=>{
 let reads=0;
 await expect(waitForReadiness(async()=>{reads++;throw new Error('synthetic');})).rejects.toThrow('synthetic');expect(reads).toBe(1);
});
