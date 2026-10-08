import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createSandbox } = vi.hoisted(() => ({ createSandbox: vi.fn() }));
vi.mock('../../sandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sandbox.js')>()),
  createSandbox,
}));

import { runWithDefinition } from './orchestrator.js';
import { LocalSandbox, writeTestRunner } from './local-sandbox.test-support.js';
import type { AgentDefinition, InstallStep } from './contract.js';
import type { AgentRunOptions } from '../types.js';

/**
 * These tests run the real orchestrator against sandboxes on the local machine.
 * The fixture asks for `answer.txt` containing 42. Grading uses a stand-in for
 * vitest, installed as a project dependency by the agent definition, that runs
 * shell checks and fails if any check fails, so each test can see exactly what
 * the grading environment contained.
 */
describe('separate verifier', () => {
  let workDir: string;
  let fixtureDir: string;
  let sandboxes: LocalSandbox[];
  /** For each sandbox created after the first: were all earlier ones stopped? */
  let earlierSandboxesStopped: boolean[];

  const writeGrader = (checks: string[]): InstallStep => {
    const path = join(workDir, `grader-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        'fail=0',
        'check() { if sh -c "$2"; then echo "ok: $1"; else echo "FAIL: $1"; fail=1; fi; }',
        ...checks,
        'exit $fail',
        '',
      ].join('\n')
    );
    return {
      kind: 'shell',
      script: [
        'mkdir -p node_modules/.bin node_modules/vitest',
        `cp '${path}' node_modules/.bin/vitest`,
        'chmod +x node_modules/.bin/vitest',
        `echo '{"name":"vitest","version":"3.0.0"}' > node_modules/vitest/package.json`,
      ].join(' && '),
      retryOnce: false,
      errorPrefix: 'grader install failed',
      errorBody: 'last10',
      scope: 'project',
    };
  };

  const ANSWER_CHECK = `check "answer is 42" '[ "$(cat answer.txt 2>/dev/null)" = "42" ]'`;

  const definition = (agentBody: string, grader: InstallStep, extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
    name: 'local-test-agent',
    displayName: 'Local Test Agent',
    defaultModel: 'test-model',
    o11yAgentName: 'claude-code',
    runnerPath: writeTestRunner(workDir, `import * as fs from 'node:fs';\n${agentBody}`),
    getApiKeyEnvVar: () => 'LOCAL_TEST_KEY',
    install: () => [
      grader,
      // The agent CLI: leaves a marker in the sandbox user's home.
      { kind: 'shell', script: 'touch "$HOME/.agent-cli-installed"', errorPrefix: 'CLI install failed', errorBody: 'stderr', scope: 'agent' },
    ],
    configFiles: () => [],
    authEnv: (options) => ({ LOCAL_TEST_KEY: options.apiKey }),
    ...extra,
  });

  const options: AgentRunOptions = {
    prompt: 'Write 42 to answer.txt',
    timeout: 60_000,
    apiKey: 'local-test-api-key-0123456789',
    validation: 'vitest',
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'agent-eval-verifier-'));
    fixtureDir = join(workDir, 'fixture');
    mkdirSync(join(fixtureDir, 'data'), { recursive: true });
    writeFileSync(join(fixtureDir, 'package.json'), '{"name":"fixture","type":"module"}');
    writeFileSync(join(fixtureDir, 'PROMPT.md'), 'Write 42 to answer.txt');
    writeFileSync(join(fixtureDir, 'EVAL.ts'), "import { test } from 'vitest';\ntest('answer', () => {});\n");
    writeFileSync(join(fixtureDir, 'obsolete.txt'), 'remove me');
    writeFileSync(join(fixtureDir, 'old-name.txt'), 'rename me');
    writeFileSync(join(fixtureDir, 'data', 'expected.json'), '{"answer":42}');
    sandboxes = [];
    earlierSandboxesStopped = [];
    createSandbox.mockImplementation(async () => {
      if (sandboxes.length > 0) earlierSandboxesStopped.push(sandboxes.every((sandbox) => sandbox.stopped));
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

  // An agent that doesn't do the task and instead replaces the test runner it
  // can see in node_modules with one that always passes.
  const PATCH_TEST_RUNNER = `fs.writeFileSync('node_modules/.bin/vitest', '#!/bin/sh\\necho "all tests passed"\\nexit 0\\n');`;

  it('shared mode lets an agent that patched node_modules pass (the problem a separate verifier solves)', async () => {
    const result = await runWithDefinition(definition(PATCH_TEST_RUNNER, writeGrader([ANSWER_CHECK])), fixtureDir, options);

    expect(result.success).toBe(true);
    expect(result.testResult?.output).toContain('all tests passed');
    expect(sandboxes).toHaveLength(1);
    // Nothing about the shared verifier is reported unless asked for.
    expect(result).not.toHaveProperty('verifier');
    expect(result).not.toHaveProperty('verifierSandboxId');
    expect(result).not.toHaveProperty('tampering');
    // ...and no extra commands run in the agent's sandbox to track it.
    expect(sandboxes[0].commands.some((command) => command.args.join(' ').includes('agent-eval-snapshot-index'))).toBe(false);
  });

  it('grades with fresh dependencies, so a patched node_modules has no effect', async () => {
    const result = await runWithDefinition(
      definition(PATCH_TEST_RUNNER, writeGrader([ANSWER_CHECK])),
      fixtureDir,
      { ...options, verifier: 'separate' }
    );

    expect(result.success).toBe(false);
    expect(result.testResult?.output).toContain('FAIL: answer is 42');
    expect(result.testResult?.output).not.toContain('all tests passed');
    expect(result.verifier).toBe('separate');
    expect(sandboxes).toHaveLength(2);
    expect(result.sandboxId).toBe(sandboxes[0].sandboxId);
    expect(result.verifierSandboxId).toBe(sandboxes[1].sandboxId);
    // node_modules is gitignored, so the patch never entered the diff at all.
    expect(result.tampering).toEqual([]);
  });

  it('ignores the agent\'s vitest config and eval files, and lists them as tampering', async () => {
    const agent = `
      fs.writeFileSync('answer.txt', '42');
      fs.writeFileSync('vitest.config.ts', '// agent was here');
      fs.writeFileSync('vitest.workspace.ts', '// agent was here');
      fs.writeFileSync('EVAL.ts', '// agent was here');
      fs.mkdirSync('src', { recursive: true });
      fs.writeFileSync('src/EVAL.tsx', '// agent was here');
    `;
    const grader = writeGrader([
      ANSWER_CHECK,
      `check "harness vitest config" '! grep -q "agent was here" vitest.config.ts'`,
      `check "no agent vitest workspace" '[ ! -e vitest.workspace.ts ]'`,
      `check "the real EVAL.ts" 'grep -q "test(" EVAL.ts'`,
      `check "no planted nested eval" '[ ! -e src/EVAL.tsx ]'`,
    ]);

    const result = await runWithDefinition(definition(agent, grader), fixtureDir, { ...options, verifier: 'separate' });

    expect(result.testResult?.output).not.toContain('FAIL');
    expect(result.success).toBe(true);
    expect(result.tampering).toEqual(['EVAL.ts', 'src/EVAL.tsx', 'vitest.config.ts', 'vitest.workspace.ts']);
    // generatedFiles still records everything the agent wrote, for auditing.
    expect(Object.keys(result.generatedFiles ?? {}).sort()).toEqual([
      'EVAL.ts',
      'answer.txt',
      'src/EVAL.tsx',
      'vitest.config.ts',
      'vitest.workspace.ts',
    ]);
  });

  it('applies deletions, renames, and executable bits, but not changes to protectedPaths', async () => {
    const agent = `
      fs.writeFileSync('answer.txt', '42');
      fs.unlinkSync('obsolete.txt');
      fs.renameSync('old-name.txt', 'new-name.txt');
      fs.mkdirSync('scripts');
      fs.writeFileSync('scripts/check.sh', '#!/bin/sh\\necho checked\\n');
      fs.chmodSync('scripts/check.sh', 0o755);
      fs.writeFileSync('data/expected.json', '{"answer":"whatever you got"}');
      fs.writeFileSync('my file.txt', 'spaces survive');
    `;
    const grader = writeGrader([
      ANSWER_CHECK,
      `check "deleted file is gone" '[ ! -e obsolete.txt ]'`,
      `check "renamed file moved" '[ -e new-name.txt ] && [ ! -e old-name.txt ]'`,
      `check "script still executable" './scripts/check.sh | grep -q checked'`,
      `check "protected data untouched" 'grep -q "\\"answer\\":42" data/expected.json'`,
      `check "path with a space" 'grep -q survive "my file.txt"'`,
    ]);

    const result = await runWithDefinition(definition(agent, grader), fixtureDir, {
      ...options,
      verifier: 'separate',
      protectedPaths: ['data/**'],
    });

    expect(result.error).toBeUndefined();
    expect(result.testResult?.output).not.toContain('FAIL');
    expect(result.success).toBe(true);
    expect(result.tampering).toEqual(['data/expected.json']);
    expect(result.deletedFiles?.sort()).toEqual(['obsolete.txt', 'old-name.txt']);
  });

  it('stops the agent\'s sandbox before booting the verifier, and stops the verifier when done', async () => {
    await runWithDefinition(
      definition(`fs.writeFileSync('answer.txt', '42');`, writeGrader([ANSWER_CHECK])),
      fixtureDir,
      { ...options, verifier: 'separate' }
    );

    expect(earlierSandboxesStopped).toEqual([true]);
    expect(sandboxes.map((sandbox) => sandbox.stopped)).toEqual([true, true]);
  });

  it('runs setup in both sandboxes, and installs the agent CLI in the verifier only when the eval uses the judge', async () => {
    const setup = vi.fn(async (sandbox: { runShell(script: string): Promise<unknown> }) => {
      await sandbox.runShell('touch "$HOME/.setup-ran"');
    });
    const grader = writeGrader([
      ANSWER_CHECK,
      `check "setup ran here" '[ -e "$HOME/.setup-ran" ]'`,
      `echo "agent cli: $([ -e "$HOME/.agent-cli-installed" ] && echo installed || echo absent)"`,
      `echo "judge runner: $([ -e __agent_eval__/run.mjs ] && echo shipped || echo absent)"`,
      `echo "judge transcript: $(cat __agent_eval__/transcript.txt)"`,
    ]);
    const agent = `fs.writeFileSync('answer.txt', '42'); result.transcript = 'the agent wrote 42';`;

    const withoutJudge = await runWithDefinition(definition(agent, grader), fixtureDir, {
      ...options,
      verifier: 'separate',
      setup: setup as never,
    });
    expect(withoutJudge.success).toBe(true);
    expect(withoutJudge.testResult?.output).toContain('agent cli: absent');
    expect(withoutJudge.testResult?.output).toContain('judge runner: absent');
    // Setup ran in the agent's sandbox as well as the verifier ("setup ran here").
    expect(existsSync(join(sandboxes[0].root, 'home', '.setup-ran'))).toBe(true);

    writeFileSync(
      join(fixtureDir, 'EVAL.ts'),
      "import { test, expect } from 'vitest';\nimport { transcript } from '@vercel/agent-eval/eval';\ntest('judged', async () => {});\n"
    );
    const withJudge = await runWithDefinition(definition(agent, grader), fixtureDir, { ...options, verifier: 'separate', setup: setup as never });
    expect(withJudge.success).toBe(true);
    expect(withJudge.testResult?.output).toContain('agent cli: installed');
    expect(withJudge.testResult?.output).toContain('judge runner: shipped');
    // The transcript judge reads the transcript by path in the verifier.
    expect(withJudge.testResult?.output).toContain('judge transcript: the agent wrote 42');
  });

  it('reports protectedPaths tampering in shared mode without changing grading', async () => {
    const agent = `
      fs.writeFileSync('answer.txt', '42');
      fs.writeFileSync('data/expected.json', '{"answer":"edited"}');
    `;
    const grader = writeGrader([
      ANSWER_CHECK,
      `echo "data now: $(cat data/expected.json)"`,
    ]);
    // The grader's own install leaves a file behind that isn't the agent's work.
    const def = definition(agent, grader, {
      install: () => [grader, { kind: 'shell', script: 'echo "{}" > data/install-cache.json', errorPrefix: 'x', errorBody: 'stderr', scope: 'project' }],
    });

    const result = await runWithDefinition(def, fixtureDir, { ...options, protectedPaths: ['data/**'] });

    expect(result.success).toBe(true);
    expect(result.tampering).toEqual(['data/expected.json']);
    // Shared mode grades the sandbox as the agent left it.
    expect(result.testResult?.output).toContain('data now: {"answer":"edited"}');
    expect(sandboxes).toHaveLength(1);
    expect(result).not.toHaveProperty('verifier');
  });

  it('does not boot a verifier when the agent itself failed', async () => {
    const result = await runWithDefinition(
      definition(`Object.assign(result, { ok: false, error: 'model refused', agentExitCode: 1 });`, writeGrader([ANSWER_CHECK])),
      fixtureDir,
      { ...options, verifier: 'separate' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('model refused');
    expect(sandboxes).toHaveLength(1);
  });
});
