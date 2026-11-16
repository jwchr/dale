import { expect, it } from 'vitest';
import { strings } from '../../src/ui/i18n';

// TypeScript already checks function signatures. Walk runtime keys as well:
// Record<string, string> and arrays can otherwise silently omit a translation.
it('keeps every message key, guide step and nonblank static message in both languages', () => {
  function compare(en: unknown, es: unknown, path: string) {
    expect(typeof es, path).toBe(typeof en);
    if (typeof en === 'string') {
      // A deliberately silent English state should remain silent in Spanish.
      expect((es as string).trim().length > 0, path).toBe(en.trim().length > 0);
    } else if (en && typeof en === 'object') {
      expect(Array.isArray(es), path).toBe(Array.isArray(en));
      if (Array.isArray(en)) expect((es as unknown[]).length, path).toBe(en.length);
      expect(Object.keys(es as object).sort(), path).toEqual(Object.keys(en).sort());
      for (const [key, value] of Object.entries(en)) compare(value, (es as Record<string, unknown>)[key], `${path}.${key}`);
    }
  }
  compare(strings.en, strings.es, 'messages');
});
