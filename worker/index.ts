import geometry from './generated/route-geometry.json';
import raw from './generated/corridor.json';
import rescue from './generated/rescue-schedule.json';
import region from './generated/region-routes.json';
import { parseDataset } from '../src/domain/dataset';
import { createFeedClass, createRouter } from './service';
const ds = parseDataset(raw);
if (ds.meta.realtime?.provider !== 'njt-bus-g2' || ds.meta.feedVersion.startsWith('SYNTHETIC')) throw new Error('A canonical G2 schedule is required');
export class BusFeed extends createFeedClass(ds, undefined, undefined, region) {}
// Only the corridor schedule reaches the live poller and history collector; the wider rescue schedule is served, never collected.
export default createRouter(ds, geometry, rescue);
