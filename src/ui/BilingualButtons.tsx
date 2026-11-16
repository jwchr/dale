import { createContext, useContext, type ReactNode } from 'react';
import { strings, type Lang, type Strings } from './i18n';
import './bilingualButtons.css';

const ButtonLanguage = createContext<{ enabled: boolean; lang: Lang }>({ enabled: false, lang: 'en' });
export const useBilingualButtons = () => useContext(ButtonLanguage);

/** Presentation only; the existing settings and native controls keep all state/actions. */
export function BilingualButtons({ enabled, lang, children }: { enabled: boolean; lang: Lang; children: ReactNode }) {
  return <ButtonLanguage.Provider value={{ enabled, lang }}>{children}</ButtonLanguage.Provider>;
}

/** An explicit opt-in at selected text buttons; no DOM rewriting or automatic translation. */
export function ButtonLabel({ children, translate }: { children: string; translate: (t: Strings) => string }) {
  const { enabled, lang } = useContext(ButtonLanguage);
  if (!enabled) return children;
  const other = lang === 'en' ? 'es' : 'en';
  return <span className="bilingual-button-label">
    <span lang={lang}>{children}</span>
    <small lang={other}>{translate(strings[other])}</small>
  </span>;
}
