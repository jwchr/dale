// A saved checklist, never vehicle tracking or a rail timetable.
export const JOURNEY_KEY = 'arriba.penn-guide.v1';
export const STATIONS = ['anderson', 'essex'] as const;
export type StationChoice = typeof STATIONS[number];
export interface JourneyChecklist {
  station: StationChoice;
  direction: 'outbound' | 'return';
  mode: 'train' | 'bus';
  travelling: boolean;
  step: number;
  walks: Partial<Record<StationChoice | 'summit', number>>;
}
export const initialChecklist = (): JourneyChecklist => ({ station: 'anderson', direction: 'outbound', mode: 'train', travelling: false, step: 0, walks: {} });
export function readChecklist(store: Pick<Storage, 'getItem'> | undefined, mode?: JourneyChecklist['mode']): JourneyChecklist {
  try {
    const p: unknown = JSON.parse((mode ? store?.getItem(`${JOURNEY_KEY}.${mode}`) : undefined) ?? store?.getItem(JOURNEY_KEY) ?? 'null');
    if (!p || typeof p !== 'object') return { ...initialChecklist(), ...(mode ? { mode } : {}) };
    const s = p as Partial<JourneyChecklist>;
    if (mode && s.mode !== mode) return { ...initialChecklist(), mode };
    const walks: JourneyChecklist['walks'] = {};
    for (const key of [...STATIONS, 'summit'] as const) {
      const n = s.walks?.[key];
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 120) walks[key] = n;
    }
    return { station: s.station === 'essex' ? 'essex' : 'anderson', direction: s.direction === 'return' ? 'return' : 'outbound',
      mode: s.mode === 'bus' ? 'bus' : 'train', travelling: s.travelling === true,
      step: typeof s.step === 'number' && Number.isInteger(s.step) && s.step >= 0 && s.step < 5 ? s.step : 0, walks };
  } catch { return { ...initialChecklist(), ...(mode ? { mode } : {}) }; }
}
export function saveChecklist(store: Pick<Storage, 'setItem'> | undefined, value: JourneyChecklist): boolean {
  try { if (!store) return false; store.setItem(`${JOURNEY_KEY}.${value.mode}`, JSON.stringify(value)); store.setItem(JOURNEY_KEY, JSON.stringify(value)); return true; } catch { return false; }
}
