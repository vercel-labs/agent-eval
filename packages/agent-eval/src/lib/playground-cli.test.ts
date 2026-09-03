import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePlaygroundBin, resolvePlaygroundPort } from './playground-cli.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('resolvePlaygroundPort', () => {
  it('uses --port over PORT', () => {
    expect(resolvePlaygroundPort('4000', { PORT: '3001' })).toBe('4000');
  });

  it('uses PORT when --port is omitted', () => {
    expect(resolvePlaygroundPort(undefined, { PORT: '3001' })).toBe('3001');
  });

  it('skips empty values and falls back to 3000', () => {
    expect(resolvePlaygroundPort('  ', { PORT: '' })).toBe('3000');
    expect(resolvePlaygroundPort(undefined, {})).toBe('3000');
  });
});

describe('resolvePlaygroundBin', () => {
  it('finds the monorepo playground next to this package', () => {
    const bin = resolvePlaygroundBin(here);
    // Only asserted when playground deps are installed (next must resolve).
    if (bin) {
      expect(bin).toBe(resolve(here, '../../../playground/bin.mjs'));
    }
  });
});
