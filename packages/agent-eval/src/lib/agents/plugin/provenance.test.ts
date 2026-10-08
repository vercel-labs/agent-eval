import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createSandbox } = vi.hoisted(() => ({ createSandbox: vi.fn() }));
vi.mock('../../sandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sandbox.js')>()),
  createSandbox,
}));

import { runWithDefinition } from './orchestrator.js';
import { LocalSandbox, writeTestRunner, type LocalSandboxOptions } from './local-sandbox.test-support.js';
import type { AgentDefinition } from './contract.js';
import type { AgentRunOptions } from '../types.js';

const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf-8')
).version;

describe('run provenance', () => {
  let workDir: string;
  let fixtureDir: string;
  let sandboxes: LocalSandbox[];

  const useSandbox = (options: LocalSandboxOptions) => {
    createSandbox.mockImplementation(async () => {
      const sandbox = new LocalSandbox(options);
      sandboxes.push(sandbox);
      return sandbox;
    });
  };

  const definition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
    name: 'local-test-agent',
    displayName: 'Local Test Agent',
    defaultModel: 'test-model',
    o11yAgentName: 'claude-code',
    runnerPath: writeTestRunner(workDir, "result.output = 'agent ran';"),
    getApiKeyEnvVar: () => 'LOCAL_TEST_KEY',
    install: () => [],
    configFiles: () => [],
    authEnv: (options) => ({ LOCAL_TEST_KEY: options.apiKey }),
    ...overrides,
  });

  const options: AgentRunOptions = {
    prompt: 'Add a README',
    timeout: 60_000,
    apiKey: 'local-test-api-key-0123456789',
    validation: 'none',
    scripts: [],
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'agent-eval-provenance-'));
    fixtureDir = join(workDir, 'fixture');
    mkdirSync(fixtureDir);
    writeFileSync(join(fixtureDir, 'package.json'), '{"name":"fixture","type":"module"}');
    writeFileSync(join(fixtureDir, 'PROMPT.md'), 'Add a README');
    sandboxes = [];
  });

  afterEach(() => {
    for (const sandbox of sandboxes) sandbox.dispose();
    rmSync(workDir, { recursive: true, force: true });
    createSandbox.mockReset();
  });

  it('records the harness version, the CLI version, and the sandbox environment', async () => {
    useSandbox({ backend: 'vercel', image: 'vercel/sandbox/node:24@sha256:0f3c9a', username: 'user' });
    const def = definition({
      versionCommand: () => ({ kind: 'shell', script: "printf '  local-agent 1.2.3\\n'" }),
    });

    const result = await runWithDefinition(def, fixtureDir, options);

    expect(result.success).toBe(true);
    expect(result.provenance).toEqual({
      agentEvalVersion: PACKAGE_VERSION,
      agentCliVersion: 'local-agent 1.2.3',
      sandboxBackend: 'vercel',
      sandboxImage: 'vercel/sandbox/node:24@sha256:0f3c9a',
      sandboxUser: 'user',
    });
  });

  it('reads the CLI version after install, so it reflects what was installed', async () => {
    useSandbox({ backend: 'docker', username: 'node' });
    const def = definition({
      install: () => [
        { kind: 'shell', script: "mkdir -p bin && printf '#!/bin/sh\\necho 9.9.9\\n' > bin/cli && chmod +x bin/cli", errorPrefix: 'CLI install failed', errorBody: 'stderr' },
      ],
      versionCommand: () => ({ kind: 'command', cmd: 'bin/cli', args: ['--version'] }),
    });

    const result = await runWithDefinition(def, fixtureDir, options);

    // Docker reports no digest-pinned image, so sandboxImage is absent.
    expect(result.provenance).toEqual({
      agentEvalVersion: PACKAGE_VERSION,
      agentCliVersion: '9.9.9',
      sandboxBackend: 'docker',
      sandboxUser: 'node',
    });
  });

  it.each([
    ['exits non-zero', { kind: 'shell', script: 'echo "unknown flag" >&2; exit 2' }],
    ['prints nothing', { kind: 'shell', script: 'true' }],
    ['is not installed', { kind: 'command', cmd: 'no-such-agent-cli', args: ['--version'] }],
  ] as const)('leaves the CLI version unset, and still passes the run, when the version command %s', async (_case, command) => {
    useSandbox({});
    const def = definition({ versionCommand: () => command });

    const result = await runWithDefinition(def, fixtureDir, options);

    expect(result.success).toBe(true);
    expect(result.output).toBe('agent ran');
    expect(result.provenance).toEqual({ agentEvalVersion: PACKAGE_VERSION, sandboxBackend: 'vercel' });
  });

  it('gives up on a version command that hangs, and the run carries on', { timeout: 20_000 }, async () => {
    useSandbox({});
    const def = definition({
      versionCommand: () => ({ kind: 'shell', script: 'echo 1.2.3; sleep 120', timeoutMs: 500 }),
    });

    const started = Date.now();
    const result = await runWithDefinition(def, fixtureDir, options);

    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.success).toBe(true);
    expect(result.output).toBe('agent ran');
    expect(result.provenance).toEqual({ agentEvalVersion: PACKAGE_VERSION, sandboxBackend: 'vercel' });
  });

  it('does not fail the run when building the version command throws', async () => {
    useSandbox({});
    const def = definition({
      versionCommand: () => {
        throw new Error('no version for you');
      },
    });

    const result = await runWithDefinition(def, fixtureDir, options);

    expect(result.success).toBe(true);
    expect(result.provenance?.agentCliVersion).toBeUndefined();
  });

  it('records provenance on a failed agent run too', async () => {
    useSandbox({ username: 'user' });
    const def = definition({
      runnerPath: writeTestRunner(workDir, "Object.assign(result, { ok: false, error: 'model refused', agentExitCode: 1 });"),
      versionCommand: () => ({ kind: 'shell', script: 'echo 1.0.0' }),
    });

    const result = await runWithDefinition(def, fixtureDir, options);

    expect(result.success).toBe(false);
    expect(result.error).toBe('model refused');
    expect(result.provenance).toEqual({
      agentEvalVersion: PACKAGE_VERSION,
      agentCliVersion: '1.0.0',
      sandboxBackend: 'vercel',
      sandboxUser: 'user',
    });
  });
});
