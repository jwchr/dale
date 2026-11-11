import { useLayoutEffect, type RefObject } from 'react';

/** Smallest scale a sign name may shrink to before its words are allowed to break. Below this,
 * enlarged text wins over keeping words whole, so riders who need big text still get it. */
const MIN_FIT = 0.6;
/** Room left for glyph overhang and sub-pixel rounding. */
const FIT_MARGIN_PX = 2;

/** Shrink each sign name inside the container just enough that every word fits on one line (owner
 * request 2026-11-11: "HACKEN / SACK" must not split). Sets `--sign-fit` on each `.highway-name`
 * (unset when it already fits), so every name stays as large as it can (owner request 2026-11-09).
 * CSS multiplies the normal font size by it. Re-fits on resize, enlarged text and once web fonts settle. */
export function useFitWords(ref: RefObject<HTMLElement | null>, texts: string) {
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const keyOf = () => `${[...container.querySelectorAll('.highway-name')].map(n => n.getBoundingClientRect().width).join(',')}|${getComputedStyle(document.documentElement).fontSize}`;
    let lastKey = '';
    const fit = () => {
      if (keyOf() === lastKey) return;
      for (const name of container.querySelectorAll<HTMLElement>('.highway-name')) {
        name.style.removeProperty('--sign-fit');
        let scale = 1;
        // Exact content width; clientWidth rounds, and a word 0.1px wider than its box still wraps.
        const style = getComputedStyle(name);
        const available = name.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - FIT_MARGIN_PX;
        // A hidden copy inside the sign inherits its font, case and letter spacing, and cannot wrap.
        const probe = document.createElement('span');
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;inset-inline-start:0;top:0';
        name.append(probe);
        for (const word of (name.textContent ?? '').split(/\s+/).filter(Boolean)) {
          probe.textContent = word;
          const width = probe.getBoundingClientRect().width;
          if (available > 0 && width > available) scale = Math.min(scale, available / width);
        }
        probe.remove();
        if (scale < 1) name.style.setProperty('--sign-fit', String(Math.max(MIN_FIT, Math.floor(scale * 1000) / 1000)));
      }
      // Record the key after fitting, so our own size change does not trigger another pass.
      lastKey = keyOf();
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit);
    observer?.observe(container);
    const refit = () => { lastKey = ''; fit(); };
    // Late web fonts change word widths without resizing the signs.
    document.fonts?.ready.then(refit).catch(() => undefined);
    window.addEventListener('resize', refit);
    return () => { observer?.disconnect(); window.removeEventListener('resize', refit); };
  }, [ref, texts]);
}
