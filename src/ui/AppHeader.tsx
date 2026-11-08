import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Reserve the real sticky-header height when text size, language or viewport changes. */
export function AppHeader({ children }: { children: ReactNode }) {
  const header = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = header.current;
    if (!node) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty('--sticky-header-height', `${Math.ceil(node.getBoundingClientRect().height)}px`);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    if (observer) observer.observe(node); else window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      root.style.removeProperty('--sticky-header-height');
    };
  }, []);
  return <header ref={header} className="top">{children}</header>;
}
