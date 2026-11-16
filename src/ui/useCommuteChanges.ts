import { useEffect, useMemo, useRef, useState } from 'react';
import { commuteChangeStore, type SavedCommuteChanges } from '../data/commuteChangeStore';
import { favoriteKey, officialSchedule } from '../domain/commuteChanges';
import type { Favorite } from '../domain/favorites';
import type { Dataset } from '../domain/types';

export function useCommuteChanges(api: string | undefined, ds: Dataset, favorites: Favorite[], now: number, fromCache = false, favoriteStorage?: Pick<Storage, 'getItem'>) {
  const store = useMemo(() => api && officialSchedule(ds) ? commuteChangeStore(api, favoriteStorage) : undefined, [api, ds, favoriteStorage]);
  const [saved, setSaved] = useState<SavedCommuteChanges>();
  const identities = JSON.stringify(favorites.map(favoriteKey).sort());
  const observed = useRef<Dataset | undefined>(undefined);
  useEffect(() => {
    let current = true;
    if (!store) { setSaved(undefined); return; }
    const fresh = observed.current !== ds && !fromCache;
    observed.current = ds;
    void store.advance(ds, favorites, now, fresh).then(value => { if (current) setSaved(value); });
    return () => { current = false; };
    // Rename/order/clock ticks do not advance the saved schedule or regenerate dismissed notices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, ds, identities, fromCache]);
  const eligible = new Set(favorites.map(favoriteKey));
  return {
    notices: store ? saved?.state.notices.filter(n => eligible.has(n.favoriteKey)) ?? [] : [],
    durable: saved?.durable ?? true,
    dismiss: async (id: string) => { if (store) setSaved(await store.dismiss(id)); },
  };
}
