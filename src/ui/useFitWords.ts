import { useLayoutEffect, type RefObject } from 'react';

/** Smallest scale a sign name may shrink to before its words are allowed to break. Below this,
 * enlarged text wins over keeping words whole, so riders who need big text still get it. */
const MIN_FIT = 0.6;
/** Room left for glyph overhang and sub-pixel rounding. */
const FIT_MARGIN_PX = 2;

/** Shrink the sign names inside the container to one shared size at which every name fits on one
 * line (owner requests 2026-11-11: "HACKEN / SACK" must not split, and NEW YORK matches HACKENSACK
 * in size on one line). Sets the same `--sign-fit` on every `.highway-name` (unset when all already
 * fit), so the names stay as large as the longest one allows. CSS multiplies the normal font size by
 * it. A name too long for one line even at MIN_FIT (a full stop name when the town is unknown) wraps
 * between words and only its widest word limits the shared size, so it cannot shrink the other sign
 * to the floor. Re-fits on resize, enlarged text and once web fonts settle.
 * `visible` must change whenever the container mounts again (for example after Edit, then Done). */
export function useFitWords(ref: RefObject<HTMLElement | null>, texts: string, visible = true) {
  useLayoutEffect(() => {
    const container = ref.current;
    if (!visible || !container) return;
    const keyOf = () => `${[...container.querySelectorAll('.highway-name')].map(n => n.getBoundingClientRect().width).join(',')}|${getComputedStyle(document.documentElement).fontSize}`;
    let lastKey = '';
    const fit = () => {
      if (keyOf() === lastKey) return;
      const names = [...container.querySelectorAll<HTMLElement>('.highway-name')];
      for (const name of names) name.style.removeProperty('--sign-fit');
      let scale = 1;
      for (const name of names) {
        // Exact content width; clientWidth rounds, and a name 0.1px wider than its box still wraps.
        const style = getComputedStyle(name);
        const available = name.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - FIT_MARGIN_PX;
        // A hidden copy inside the sign inherits its font, case and letter spacing, and cannot wrap.
        const probe = document.createElement('span');
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;inset-inline-start:0;top:0';
        const words = (name.textContent ?? '').split(/\s+/).filter(Boolean);
        name.append(probe);
        const measure = (text: string) => { probe.textContent = text; return probe.getBoundingClientRect().width; };
        const lineWidth = measure(words.join(' '));
        // Too long for one line even at the floor: it wraps between words, so only its widest word counts.
        const width = available > 0 && available / lineWidth < MIN_FIT ? Math.max(...words.map(measure)) : lineWidth;
        probe.remove();
        if (available > 0 && width > available) scale = Math.min(scale, available / width);
      }
      if (scale < 1) {
        const fitValue = String(Math.max(MIN_FIT, Math.floor(scale * 1000) / 1000));
        for (const name of names) name.style.setProperty('--sign-fit', fitValue);
      }
      // Record the key after fitting, so our own size change does not trigger another pass.
      lastKey = keyOf();
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit);
    observer?.observe(container);
    const refit = () => { lastKey = ''; fit(); };
    // Late web fonts change word widths without resizing the signs. `ready` resolves only once, often
    // before a sign's own font is even requested, so also re-fit after every later font load.
    document.fonts?.ready.then(refit).catch(() => undefined);
    const fonts = document.fonts as (FontFaceSet & EventTarget) | undefined;
    fonts?.addEventListener?.('loadingdone', refit);
    window.addEventListener('resize', refit);
    return () => { observer?.disconnect(); fonts?.removeEventListener?.('loadingdone', refit); window.removeEventListener('resize', refit); };
  }, [ref, texts, visible]);
}
