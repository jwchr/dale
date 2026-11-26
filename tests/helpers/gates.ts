import type { Dataset } from '../../src/domain/types';
export const NOW = Date.UTC(2026, 10, 26, 12);
export const dataset: Dataset = {
  meta: { demo: false, source: 'synthetic schedule', feedVersion: 'gates-fixture', builtAt: '2026-11-26', timezone: 'America/New_York', realtime: { provider: 'njt-bus-g2' } },
  routes: [{ id: 'r', shortName: '165', longName: 'Corridor' }], stops: [{ id: 'p', name: 'Terminal', terminal: 'PABT' }, { id: 'p2', name: 'Terminal second call', terminal: 'PABT' }, { id: 'd', name: 'Destination' }],
  patterns: [{ id: 'out', routeId: 'r', directionId: 0, headsign: 'Destination', stopIds: ['p', 'p2', 'd'] }],
  trips: [{ id: 't', patternId: 'out', serviceId: 'daily', times: [7 * 3600 + 900, 7 * 3600 + 1200, 8 * 3600] }],
  calendars: { daily: { start: '20260101', end: '20261231', days: [true, true, true, true, true, true, true], added: [], removed: [] } },
};
export const row = (patch = {}) => ({ public_route: '165', timing_point_id: 'NWYKPABT', sched_dep_time: '11/26/2026 7:15 AM', lanegate: '222-3', ...patch });
