import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { LiveBusStatus } from '../../src/ui/LiveBusStatus';
import { strings } from '../../src/ui/i18n';
import { LIVE_SOURCE, type LiveBusSnapshot } from '../../src/domain/liveBus';
import type { Departure } from '../../src/domain/types';
it.each(['en','es'] as const)('compact missing-GPS branch suppresses cancelled snapshot predictions even before lock state changes (%s)',lang=>{
 const now=Date.UTC(2026,10,4,12,20);
 // This view consumes only the selected trip identity and boarding index.
 const dep={tripInstanceId:'synthetic@20261104',stopIndex:1} as Departure;
 const snapshot:LiveBusSnapshot={v:1,source:LIVE_SOURCE,feedVersion:'synthetic',tripInstanceId:dep.tripInstanceId,receivedAt:now,
  vehicles:{state:'unavailable'},updates:{state:'ok',timestamp:now},observations:[],updatedAt:now,
  predictions:[{stopIndex:1,kind:'departure',at:now+300000,observedAt:now}],skippedStops:[]};
 const render=(cancelled:boolean)=>renderToStaticMarkup(createElement(LiveBusStatus,{state:'available',snapshot:{...snapshot,...(cancelled?{cancelledAt:now}: {})},dep,now,t:strings[lang],lang,tz:'America/New_York',lockStatus:'scheduled_only'}));
 const prediction=strings[lang].live.prediction(lang==='es'?'7:25 a.m.':'7:25 AM');
 expect(render(false)).toContain(prediction);expect(render(true)).not.toContain(prediction);
});
