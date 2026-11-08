// Local runtime only: actual SQLite/alarms, synthetic upstream, no NJ Transit access.
import bindings from 'gtfs-realtime-bindings';
import raw from './generated/corridor.json';
import { parseDataset } from '../src/domain/dataset';
import { createFeedClass, createRouter } from './service';
const ds = parseDataset(raw);
if (!ds.meta.feedVersion.startsWith('SYNTHETIC')) throw new Error('Synthetic local-runtime fixture required');
const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
for (const calendar of Object.values(ds.calendars)) { calendar.start = calendar.end = today; calendar.added = [today]; calendar.removed = []; }
const fake = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(url, init), endpoint = new URL(request.url).pathname.split('/').pop();
  if (endpoint === 'authenticateUser') return Response.json({ Authenticated: 'True', UserToken: 'history-local-test-token' });
  const now = Math.floor(Date.now() / 1000), trip = { tripId: 'T1', startDate: today, routeId: '10', directionId: 0 };
  const entity = endpoint === 'getVehiclePositions' ? [{ id: 'v', vehicle: { trip, vehicle: { id: 'history-local-bus' }, timestamp: now - 1,
    position: { latitude: 40.89, longitude: -74.04 } } }]
    : endpoint === 'getTripUpdates' ? [] : undefined;
  if (!entity) throw new Error('Unexpected synthetic endpoint');
  return new Response(new Uint8Array(bindings.transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now - 1 }, entity }).finish()).buffer);
}) as typeof fetch;
export class BusFeed extends createFeedClass(ds, fake) {}
export default createRouter(ds);
