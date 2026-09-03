import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  repairRoutesManifest,
  resolveNextCommand,
  resolvePlaygroundPort,
} from '../../../playground/lib/start-utils.mjs';

describe('playground start-utils', () => {
  it('prefers an explicit port, then PORT, then 3000', () => {
    expect(resolvePlaygroundPort('3001', { PORT: '4000' })).toBe('3001');
    expect(resolvePlaygroundPort(undefined, { PORT: '3001' })).toBe('3001');
    expect(resolvePlaygroundPort(undefined, {})).toBe('3000');
  });

  it('writes onMatchHeaders when a pre-16.2.4 playground build omitted it', () => {
    const root = mkdtempSync(join(tmpdir(), 'playground-manifest-'));
    try {
      mkdirSync(join(root, '.next'));
      const path = join(root, '.next', 'routes-manifest.json');
      writeFileSync(path, JSON.stringify({ version: 3, headers: [] }));

      expect(repairRoutesManifest(root)).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8')).onMatchHeaders).toEqual([]);
      expect(repairRoutesManifest(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses next start only when a production BUILD_ID exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'playground-next-cmd-'));
    try {
      expect(resolveNextCommand(root)).toBe('dev');
      mkdirSync(join(root, '.next'));
      expect(resolveNextCommand(root)).toBe('dev');
      writeFileSync(join(root, '.next', 'BUILD_ID'), 'test');
      expect(resolveNextCommand(root)).toBe('start');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
