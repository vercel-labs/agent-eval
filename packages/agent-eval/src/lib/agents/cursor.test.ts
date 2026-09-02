import { describe, expect, it } from 'vitest';
import { delimiter, join } from 'node:path';

import { createCursorDefinition } from './cursor/agent.js';
import {
  buildCursorCliArgs,
  buildCursorRunEnv,
  extractTranscriptFromOutput,
  resolveCursorBin,
} from './cursor/run.mjs';

describe('createCursorDefinition', () => {
  const definition = createCursorDefinition();
  const options = { prompt: 'p', apiKey: 'test-key', timeout: 1000 };

  it('installs the official CLI and asserts the installer symlink exists', () => {
    const install = definition.install(options);
    expect(install).toHaveLength(2);
    expect(install[1]).toMatchObject({
      kind: 'shell',
      errorPrefix: 'Cursor CLI install failed',
    });
    expect(install[1].script).toContain('curl https://cursor.com/install -fsSL | bash');
    expect(install[1].script).toContain('test -x "$HOME/.local/bin/agent"');
  });

  it('authenticates with CURSOR_API_KEY only', () => {
    expect(definition.getApiKeyEnvVar()).toBe('CURSOR_API_KEY');
    expect(definition.authEnv(options)).toEqual({ CURSOR_API_KEY: 'test-key' });
    expect(definition.configFiles(options)).toEqual([]);
  });
});

describe('buildCursorCliArgs', () => {
  it('prints a forced stream-json run with the prompt first', () => {
    expect(buildCursorCliArgs({ prompt: 'add a greeting' })).toEqual([
      'add a greeting',
      '--print',
      '--force',
      '--output-format',
      'stream-json',
    ]);
  });

  it('appends --model only when a model override is provided', () => {
    expect(buildCursorCliArgs({ prompt: 'p', model: 'composer-1.5' })).toEqual([
      'p',
      '--print',
      '--force',
      '--model',
      'composer-1.5',
      '--output-format',
      'stream-json',
    ]);
  });
});

describe('resolveCursorBin', () => {
  it('prefers the official installer path when it exists', () => {
    const exists = (p: string) => p === join('/home/node', '.local/bin/agent');
    expect(resolveCursorBin({ HOME: '/home/node' }, exists)).toBe(
      join('/home/node', '.local/bin/agent')
    );
  });

  it('falls back to the cursor-agent alias', () => {
    const alias = join('/home/node', '.local/bin/cursor-agent');
    expect(resolveCursorBin({ HOME: '/home/node' }, (p) => p === alias)).toBe(alias);
  });

  it('falls back to a PATH lookup of agent when neither file exists', () => {
    expect(resolveCursorBin({ HOME: '/home/node' }, () => false)).toBe('agent');
  });
});

describe('buildCursorRunEnv', () => {
  it('prepends ~/.local/bin so spawnSync can find the installer symlink', () => {
    const env = buildCursorRunEnv({ HOME: '/home/node', PATH: '/usr/bin', CURSOR_API_KEY: 'k' });
    expect(env.PATH).toBe(`${join('/home/node', '.local/bin')}${delimiter}/usr/bin`);
    expect(env.CURSOR_API_KEY).toBe('k');
  });
});

describe('extractTranscriptFromOutput', () => {
  it('keeps only complete JSON object lines', () => {
    const output = [
      'not json',
      '{"type":"assistant","message":"hi"}',
      '{incomplete',
      '{"type":"result"}',
    ].join('\n');
    expect(extractTranscriptFromOutput(output)).toBe(
      '{"type":"assistant","message":"hi"}\n{"type":"result"}'
    );
  });

  it('returns undefined when no JSON lines are present', () => {
    expect(extractTranscriptFromOutput('just text\n')).toBeUndefined();
  });
});
