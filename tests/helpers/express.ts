import { demoDataset } from '../../src/data/demo';
export function expressDataset() {
  const ds = structuredClone(demoDataset);
  const trip = (id: string, patternId: string, start: number, offsets: number[]) => ({ id, patternId, serviceId: 'WKDY', times: offsets.map((m) => (start + m) * 60) });
  ds.trips = [
    ...[425, 430, 435].map((m, i) => trip('local-' + i, 'L0', m, [0, 6, 14, 24, 55])),
    trip('express', 'X0', 460, [0, 6, 40]),
  ];
  return ds;
}
