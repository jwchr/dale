import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { homePhotoRecord, PhotoError, prepareHomePhoto, type HomePhoto, type PhotoProblem } from '../data/homePhoto';
import type { Strings } from './i18n';
import './homePhoto.css';

type Message = PhotoProblem | 'saved' | 'removed' | undefined;
interface PhotoModel {
  photo: HomePhoto | null; url?: string; loaded: boolean; busy: boolean; message: Message;
  change: (file: File | null) => Promise<void>; refresh: () => Promise<void>;
}
const Context = createContext<PhotoModel | undefined>(undefined);
export const useHomePhoto = () => useContext(Context);
const CHANNEL = 'dale-home-photo-changed-v1';

export function HomePhotoProvider({ children }: { children: ReactNode }) {
  const [photo, setPhoto] = useState<HomePhoto | null>(null);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>();
  const [image, setImage] = useState<{ blob: Blob; url: string }>();
  const current = useRef(photo), active = useRef(true), working = useRef(false), generation = useRef(0);
  const channel = useRef<BroadcastChannel | undefined>(undefined);
  const accept = (value: HomePhoto | null) => {
    if ((current.current?.version ?? null) !== (value?.version ?? null)) { current.current = value; setPhoto(value); }
    setLoaded(true);
  };
  const refresh = async () => {
    if (working.current) return;
    const request = ++generation.current;
    try {
      const value = await homePhotoRecord();
      if (active.current && request === generation.current) { accept(value); setMessage(undefined); }
    } catch { if (active.current && request === generation.current) setMessage('storage'); }
  };
  useEffect(() => {
    active.current = true; void refresh();
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible);
    try { channel.current = new BroadcastChannel(CHANNEL); channel.current.onmessage = () => { void refresh(); }; } catch { /* Foreground refresh remains available. */ }
    return () => {
      active.current = false; ++generation.current; channel.current?.close();
      window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  useEffect(() => {
    if (!photo) { setImage(undefined); return; }
    const url = URL.createObjectURL(photo.blob); setImage({ blob: photo.blob, url });
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  const change = async (file: File | null) => {
    if (working.current || !loaded) return;
    working.current = true; ++generation.current; setBusy(true); setMessage(undefined);
    const expected = current.current?.version ?? null;
    try {
      const blob = file ? await prepareHomePhoto(file) : null;
      const value = await homePhotoRecord({ expected, blob });
      if (active.current) { accept(value); setMessage(file ? 'saved' : 'removed'); }
      try { channel.current?.postMessage('changed'); } catch { /* No photo bytes or names are broadcast. */ }
    } catch (error) {
      let problem: PhotoProblem = error instanceof PhotoError ? error.problem : 'storage';
      if (problem === 'conflict') {
        try { const value = await homePhotoRecord(); if (active.current) accept(value); } catch { problem = 'storage'; }
      }
      if (active.current) setMessage(problem);
    } finally { working.current = false; if (active.current) setBusy(false); }
  };
  const url = image?.blob === photo?.blob ? image?.url : undefined;
  return <Context.Provider value={{ photo, url, loaded, busy, message, change, refresh }}>{children}</Context.Provider>;
}

export function HomePhotoSettings({ t }: { t: Strings }) {
  const model = useHomePhoto(), id = useId();
  const input = useRef<HTMLInputElement>(null), chooser = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!model?.busy && restoreFocus.current) { restoreFocus.current = false; chooser.current?.focus(); }
  }, [model?.busy]);
  if (!model) return null;
  const s = t.homePhoto;
  return <section className="home-photo-settings" aria-labelledby={id}>
    <h2 id={id}>{s.title}</h2>
    <p id={`${id}-note`} className="small muted">{s.note}</p>
    {model.url && <img className="home-photo-preview" src={model.url} alt={s.preview} />}
    <div className="home-photo-picker">
      <button ref={chooser} type="button" disabled={!model.loaded || model.busy} aria-describedby={`${id}-note ${id}-formats`}
        onClick={() => input.current?.click()}>{model.photo ? s.replace : s.choose}</button>
      <input ref={input} hidden type="file" aria-label={model.photo ? s.replace : s.choose} accept="image/jpeg,image/png,image/webp" disabled={!model.loaded || model.busy}
        aria-describedby={`${id}-note ${id}-formats`} onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
          if (file) { restoreFocus.current = true; void model.change(file); }
        }} />
    </div>
    <p id={`${id}-formats`} className="small muted">{s.formats}</p>
    {model.photo && <button type="button" disabled={model.busy} onClick={() => { restoreFocus.current = true; void model.change(null); }}>{s.remove}</button>}
    {!model.loaded && model.message === 'storage' && <button type="button" onClick={() => { void model.refresh(); }}>{t.retry}</button>}
    <p role="status" aria-live="polite">{model.busy ? s.busy : model.message ? s[model.message] : model.photo ? s.saved : s.empty}</p>
  </section>;
}
