import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createSandbox } = vi.hoisted(() => ({ createSandbox: vi.fn() }));
vi.mock('../../sandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sandbox.js')>()),
  createSandbox,
}));

import { runWithDefinition } from './orchestrator.js';
import { LocalSandbox, writeTestRunner } from './local-sandbox.test-support.js';
import type { AgentDefinition } from './contract.js';
import type { AgentRunOptions } from '../types.js';
import { REDACTED } from '../redact.js';

const DEPLOY_TOKEN = 'dpl_live_7a1f0c9e44b2d8a63f5e19c0';
const REGISTRY_TOKEN = 'npm_8Hq2LrX0vT6yWc4mZs1KdPa9';

describe('agentEnv', () => {
  let workDir: string;
  let fixtureDir: string;
  let sandboxes: LocalSandbox[];

  /** A test agent that uses its credentials the way a careless agent might. */
  const leakyAgent = (): AgentDefinition => ({
    name: 'local-test-agent',
    displayName: 'Local Test Agent',
    defaultModel: 'test-model',
    o11yAgentName: 'claude-code',
    runnerPath: writeTestRunner(
      workDir,
      `
      const token = process.env.DEPLOY_TOKEN;
      writeFileSync('deploy.log', 'deployed with ' + token + '\\n');
      result.output = token ? 'token present (' + token.length + ' chars), echoed: ' + token : 'token missing';
      result.transcript = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'export DEPLOY_TOKEN=' + token }] } });
      `
    ),
    getApiKeyEnvVar: () => 'LOCAL_TEST_KEY',
    install: () => [],
    configFiles: () => [],
    authEnv: (options) => ({ LOCAL_TEST_KEY: options.apiKey }),
  });

  const options: AgentRunOptions = {
    prompt: 'Deploy the app',
    timeout: 60_000,
    apiKey: 'local-test-api-key-0123456789',
    validation: 'none',
    agentEnv: { DEPLOY_TOKEN, NPM_TOKEN: REGISTRY_TOKEN },
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'agent-eval-agent-env-'));
    fixtureDir = join(workDir, 'fixture');
    mkdirSync(fixtureDir);
    writeFileSync(
      join(fixtureDir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: {
          // Runs during validation, which must not receive agentEnv.
          'check-env': `node -e "console.log(process.env.DEPLOY_TOKEN ? 'validation saw the token' : 'validation has no token')"`,
          // Reads a file the agent wrote, so the token can reach script output.
          'show-log': 'cat deploy.log',
        },
      })
    );
    sandboxes = [];
    createSandbox.mockImplementation(async () => {
      const sandbox = new LocalSandbox();
      sandboxes.push(sandbox);
      return sandbox;
    });
  });

  afterEach(() => {
    for (const sandbox of sandboxes) sandbox.dispose();
    rmSync(workDir, { recursive: true, force: true });
    createSandbox.mockReset();
  });

  it('reaches the agent process through its environment, never through argv', async () => {
    const result = await runWithDefinition(leakyAgent(), fixtureDir, options);

    expect(result.success).toBe(true);
    expect(result.output).toContain(`token present (${DEPLOY_TOKEN.length} chars)`);

    const [sandbox] = sandboxes;
    const runner = sandbox.commands.find((command) => command.cmd === 'node' && command.args[0] === '__agent_eval__/run.mjs');
    expect(runner?.env).toMatchObject({ DEPLOY_TOKEN, NPM_TOKEN: REGISTRY_TOKEN, LOCAL_TEST_KEY: options.apiKey, USER: 'user' });
    for (const command of sandbox.commands) {
      const argv = [command.cmd, ...command.args].join(' ');
      expect(argv).not.toContain(DEPLOY_TOKEN);
      expect(argv).not.toContain(REGISTRY_TOKEN);
    }
  });

  it('is redacted from the output, transcript, script outputs, and generated files', async () => {
    const result = await runWithDefinition(leakyAgent(), fixtureDir, { ...options, scripts: ['show-log'] });

    expect(result.output).toContain(`echoed: ${REDACTED}`);
    expect(result.transcript).toContain(`export DEPLOY_TOKEN=${REDACTED}`);
    expect(result.scriptsResults?.['show-log'].output).toContain(`deployed with ${REDACTED}`);
    expect(result.generatedFiles?.['deploy.log'].toString('utf-8')).toBe(`deployed with ${REDACTED}\n`);
    const everything = JSON.stringify({ ...result, generatedFiles: undefined }) +
      Object.values(result.generatedFiles ?? {}).map((buffer) => buffer.toString('utf-8')).join('');
    expect(everything).not.toContain(DEPLOY_TOKEN);
  });

  it('is not given to validation: neither the EVAL.ts process nor npm scripts', async () => {
    writeFileSync(join(fixtureDir, 'EVAL.ts'), "import { test } from 'vitest';\ntest('deployed', () => {});\n");
    // A stand-in vitest, installed as a project dependency, that reports which
    // credentials the validation process received. The judge's credentials are
    // supposed to be there; agentEnv is not.
    const stubVitest = [
      'mkdir -p node_modules/vitest node_modules/.bin',
      `echo '{"name":"vitest","version":"3.0.0"}' > node_modules/vitest/package.json`,
      `printf '#!/bin/sh\\nnode -e "console.log(process.env.DEPLOY_TOKEN ? \\\\"vitest saw the token\\\\" : \\\\"vitest has no token\\\\", process.env.LOCAL_TEST_KEY ? \\\\"judge key present\\\\" : \\\\"judge key missing\\\\")"\\n' > node_modules/.bin/vitest`,
      'chmod +x node_modules/.bin/vitest',
    ].join(' && ');
    const def: AgentDefinition = {
      ...leakyAgent(),
      install: () => [{ kind: 'shell', script: stubVitest, errorPrefix: 'stub install failed', errorBody: 'last10' }],
    };

    const result = await runWithDefinition(def, fixtureDir, { ...options, validation: 'vitest', scripts: ['check-env'] });

    expect(result.testResult?.output).toContain('vitest has no token judge key present');
    expect(result.scriptsResults?.['check-env'].output).toContain('validation has no token');
  });

  it.each([
    ['the agent\'s auth variable', { LOCAL_TEST_KEY: 'attacker-chosen-key-0000000000' }, 'LOCAL_TEST_KEY'],
    ['a workspace identity variable', { USER: 'root', LOGNAME: 'root' }, 'LOGNAME, USER'],
  ])('rejects a key that collides with %s before booting a sandbox', async (_case, agentEnv, keys) => {
    await expect(runWithDefinition(leakyAgent(), fixtureDir, { ...options, agentEnv })).rejects.toThrow(
      `agentEnv cannot set ${keys}: reserved for Local Test Agent authentication or the sandbox workspace identity`
    );
    expect(sandboxes).toHaveLength(0);
  });

  it('rejects names a shell environment cannot hold', async () => {
    await expect(
      runWithDefinition(leakyAgent(), fixtureDir, { ...options, agentEnv: { 'DEPLOY-TOKEN': DEPLOY_TOKEN } })
    ).rejects.toThrow('agentEnv has invalid environment variable names: DEPLOY-TOKEN');
    expect(sandboxes).toHaveLength(0);
  });

  it('leaves the agent environment exactly as before when unset', async () => {
    const { agentEnv: _unused, ...withoutAgentEnv } = options;

    const result = await runWithDefinition(leakyAgent(), fixtureDir, withoutAgentEnv);

    expect(result.output).toBe('token missing');
    const runner = sandboxes[0].commands.find((command) => command.cmd === 'node');
    expect(runner?.env).toEqual({ LOCAL_TEST_KEY: options.apiKey, USER: 'user', LOGNAME: 'user' });
  });
});
