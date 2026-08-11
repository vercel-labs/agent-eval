import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cacheSnapshotId,
  computeSandboxTemplateIdentity,
  defineSandboxTemplate,
  resetSandboxTemplateCacheForTests,
  SANDBOX_TEMPLATE_CACHE_PATH,
} from './sandbox-template.js';
import type { EvalFixture, RunnableExperimentConfig } from './types.js';

const root = '/tmp/agent-eval-sandbox-template-test';
const config: RunnableExperimentConfig = {
  agent: 'claude-code',
  model: 'sonnet',
  evals: '*',
  runs: 1,
  earlyExit: false,
  scripts: [],
  validation: 'vitest',
  timeout: 600,
  sandbox: 'vercel',
  copyFiles: 'none',
};

function fixture(): EvalFixture {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'source.ts'), 'one');
  return { name: 'test', path: root, prompt: 'do it', isModule: true };
}

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(join(process.cwd(), '.agent-eval'), { recursive: true, force: true });
  resetSandboxTemplateCacheForTests();
});

describe('sandbox templates', () => {
  it('persists snapshot IDs in the project-local cache', () => {
    cacheSnapshotId('identity', 'snapshot-id');

    const saved = JSON.parse(
      readFileSync(join(process.cwd(), SANDBOX_TEMPLATE_CACHE_PATH), 'utf8')
    );
    expect(saved.snapshots.identity).toBe('snapshot-id');
  });

  it('rejects an empty key', () => {
    expect(() => defineSandboxTemplate({ key: '', prepare: async () => {} })).toThrow(
      'Sandbox template key must be a non-empty string.'
    );
  });

  it('uses all visible workspace files by default', async () => {
    const evalFixture = fixture();
    const template = defineSandboxTemplate({ key: 'deps-v1', prepare: async () => {} });
    const options = {
      template,
      fixture: evalFixture,
      config,
      backend: 'vercel' as const,
      runtime: 'node24',
    };

    const first = await computeSandboxTemplateIdentity({
      ...options,
      workspaceFiles: [{ path: 'source.ts', content: 'one' }],
    });
    const second = await computeSandboxTemplateIdentity({
      ...options,
      workspaceFiles: [{ path: 'source.ts', content: 'two' }],
    });

    expect(first).not.toBe(second);
  });

  it('lets identity define which contexts share prepared state', async () => {
    const evalFixture = fixture();
    const template = defineSandboxTemplate({
      key: 'deps-v1',
      identity: ({ hashFiles }) => ({ dependencies: hashFiles(['package.json']) }),
      prepare: async () => {},
    });
    const options = {
      template,
      fixture: evalFixture,
      config,
      backend: 'vercel' as const,
      runtime: 'node24',
    };

    const first = await computeSandboxTemplateIdentity({
      ...options,
      workspaceFiles: [{ path: 'source.ts', content: 'one' }],
    });
    writeFileSync(join(root, 'source.ts'), 'two');
    const second = await computeSandboxTemplateIdentity({
      ...options,
      workspaceFiles: [{ path: 'source.ts', content: 'two' }],
    });

    expect(first).toBe(second);
  });

  it('rejects non-serializable custom identities', async () => {
    const evalFixture = fixture();
    const template = defineSandboxTemplate({
      key: 'invalid',
      // Deliberately bypass the public serializable type to verify the runtime boundary.
      identity: () => (() => 'nope') as never,
      prepare: async () => {},
    });

    await expect(
      computeSandboxTemplateIdentity({
        template,
        fixture: evalFixture,
        config,
        workspaceFiles: [],
        backend: 'vercel',
        runtime: 'node24',
      })
    ).rejects.toThrow('Sandbox template identity must be JSON-serializable.');
  });

  it('includes framework-owned backend, runtime, and key invariants', async () => {
    const evalFixture = fixture();
    const base = {
      fixture: evalFixture,
      config,
      workspaceFiles: [],
      backend: 'vercel' as const,
      runtime: 'node24',
    };
    const one = await computeSandboxTemplateIdentity({
      ...base,
      template: defineSandboxTemplate({ key: 'v1', identity: () => 'same', prepare: async () => {} }),
    });
    const two = await computeSandboxTemplateIdentity({
      ...base,
      runtime: 'node22',
      template: defineSandboxTemplate({ key: 'v2', identity: () => 'same', prepare: async () => {} }),
    });

    expect(one).not.toBe(two);
  });
});
