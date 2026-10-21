import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, mkdtempSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { tmpdir } from 'os';
import { computeContentFingerprint, computeFingerprint } from './lib/fingerprint.js';
import { loadConfig } from './lib/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const CLI_PATH = resolve(PROJECT_ROOT, 'src/cli.ts');
const BUILT_CLI_PATH = resolve(PROJECT_ROOT, 'dist/cli.js');

let TEST_DIR: string;

function runCli(
  args: string[],
  cwd?: string,
  options: { built?: boolean; env?: Record<string, string> } = {}
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const cli = options.built ? `node ${BUILT_CLI_PATH}` : `npx tsx ${CLI_PATH}`;
    const stdout = execSync(`${cli} ${args.join(' ')}`, {
      cwd: cwd ?? PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error: unknown) {
    const e = error as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

describe('CLI', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'agent-eval-cli-'));
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('help', () => {
    it('shows help with --help flag', () => {
      const result = runCli(['--help']);
      expect(result.stdout).toContain('eval');
      expect(result.stdout).toContain('init');
      expect(result.stdout).toContain('run');
    });
  });

  describe('run command', () => {
    it('shows error when the named experiment does not exist', () => {
      const result = runCli(['run', 'no-such-experiment']);
      expect(result.stderr.toLowerCase()).toMatch(/no experiments matched|required/);
      expect(result.exitCode).toBe(1);
    });

    it('runs with valid config and evals (dry run)', () => {
      // Create project structure matching convention:
      // project/experiments/config.ts and project/evals/
      const projectDir = join(TEST_DIR, 'project');
      const experimentsDir = join(projectDir, 'experiments');
      mkdirSync(experimentsDir, { recursive: true });

      // Create config file in experiments/
      const configContent = `export default { agent: 'claude-code' };`;
      writeFileSync(join(experimentsDir, 'cc.ts'), configContent);

      // Create evals directory with valid fixture
      const evalsDir = join(projectDir, 'evals');
      mkdirSync(evalsDir);
      const fixture = join(evalsDir, 'my-eval');
      mkdirSync(fixture);
      writeFileSync(join(fixture, 'PROMPT.md'), 'Test task');
      writeFileSync(join(fixture, 'EVAL.ts'), 'test code');
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));

      const result = runCli(['experiments/cc.ts', '--dry'], projectDir);
      expect(result.stdout).toContain('my-eval');
      expect(result.stdout).toContain('DRY RUN');
      expect(result.exitCode).toBe(0);
    });

    it('supports shorthand config names (dry run)', () => {
      // Create project structure
      const projectDir = join(TEST_DIR, 'shorthand-project');
      const experimentsDir = join(projectDir, 'experiments');
      mkdirSync(experimentsDir, { recursive: true });

      const configContent = `export default { agent: 'claude-code' };`;
      writeFileSync(join(experimentsDir, 'cc.ts'), configContent);

      const evalsDir = join(projectDir, 'evals');
      mkdirSync(evalsDir);
      const fixture = join(evalsDir, 'test-eval');
      mkdirSync(fixture);
      writeFileSync(join(fixture, 'PROMPT.md'), 'Test task');
      writeFileSync(join(fixture, 'EVAL.ts'), 'test code');
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));

      // Use shorthand: "cc" instead of "experiments/cc.ts"
      const result = runCli(['cc', '--dry'], projectDir);
      expect(result.stdout).toContain('test-eval');
      expect(result.stdout).toContain('DRY RUN');
      expect(result.exitCode).toBe(0);
    });

    it('--smoke picks first eval alphabetically and sets runs to 1', () => {
      const projectDir = join(TEST_DIR, 'smoke-project');
      const experimentsDir = join(projectDir, 'experiments');
      mkdirSync(experimentsDir, { recursive: true });

      const configContent = `export default { agent: 'claude-code' };`;
      writeFileSync(join(experimentsDir, 'cc.ts'), configContent);

      const evalsDir = join(projectDir, 'evals');
      mkdirSync(evalsDir);

      // Create two evals - smoke should pick first alphabetically
      for (const evalName of ['beta-eval', 'alpha-eval']) {
        const fixture = join(evalsDir, evalName);
        mkdirSync(fixture);
        writeFileSync(join(fixture, 'PROMPT.md'), 'Test task');
        writeFileSync(join(fixture, 'EVAL.ts'), 'test code');
        writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
      }

      const result = runCli(['cc', '--smoke', '--dry'], projectDir);
      expect(result.stdout).toContain('SMOKE TEST');
      expect(result.stdout).toContain('alpha-eval');
      expect(result.stdout).toContain('1 eval(s) x 1 run(s)');
      expect(result.exitCode).toBe(0);
    });

    it('shows error when no valid fixtures found', () => {
      // Create project structure matching convention
      const projectDir = join(TEST_DIR, 'empty-project');
      const experimentsDir = join(projectDir, 'experiments');
      mkdirSync(experimentsDir, { recursive: true });

      const configContent = `export default { agent: 'claude-code' };`;
      writeFileSync(join(experimentsDir, 'cc.ts'), configContent);

      // Create empty evals directory
      const evalsDir = join(projectDir, 'evals');
      mkdirSync(evalsDir);

      const result = runCli(['experiments/cc.ts'], projectDir);
      expect(result.stderr).toContain('No valid eval fixtures');
      expect(result.exitCode).toBe(1);
    });

    it('validates config file', () => {
      // Create project structure matching convention
      const projectDir = join(TEST_DIR, 'bad-config');
      const experimentsDir = join(projectDir, 'experiments');
      mkdirSync(experimentsDir, { recursive: true });

      // Create invalid config (missing agent)
      const configContent = `export default { model: 'opus' };`;
      writeFileSync(join(experimentsDir, 'cc.ts'), configContent);

      const evalsDir = join(projectDir, 'evals');
      mkdirSync(evalsDir);

      const result = runCli(['experiments/cc.ts'], projectDir);
      expect(result.stderr.toLowerCase()).toContain('error');
      expect(result.exitCode).toBe(1);
    });

    it('rejects a --concurrency that is not a positive integer', () => {
      for (const args of [
        ['run', 'cc', '--concurrency', '0'],
        ['run', 'cc', '--concurrency', 'many'],
        ['cc', '--dry', '--concurrency', '1.5'],
      ]) {
        const result = runCli(args);
        expect(result.stderr).toContain("option '--concurrency <n>' argument");
        expect(result.stderr).toContain('Must be a positive integer.');
        expect(result.exitCode).toBe(1);
      }
    });

    function countingProject(stuck = false, multiModel = false): string {
      // Custom agents register with the package the project imports, so this
      // drives the built CLI that `@vercel/agent-eval` resolves to.
      expect(existsSync(BUILT_CLI_PATH), 'run `npm run build` first').toBe(true);
      const projectDir = join(TEST_DIR, 'concurrency-run');
      mkdirSync(join(projectDir, 'node_modules', '@vercel'), { recursive: true });
      symlinkSync(PROJECT_ROOT, join(projectDir, 'node_modules', '@vercel', 'agent-eval'));
      mkdirSync(join(projectDir, 'results'));
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ type: 'module' }));
      // Each run counts itself active for 300ms; the counts are shared by all experiments.
      writeFileSync(
        join(projectDir, 'counting-agent.ts'),
        `import { writeFileSync } from 'node:fs';
import { registerAgent } from '@vercel/agent-eval';
const stats = (globalThis.__countingAgentStats ??= { active: 0, peak: 0, starts: 0 });
const record = () => writeFileSync(new URL('./stats.json', import.meta.url), JSON.stringify(stats));
const definition = {
  name: 'counting-agent',
  displayName: 'Counting Agent',
  defaultModel: 'none',
  runnerPath: '/unused/run.mjs',
  getApiKeyEnvVar: () => 'COUNTING_AGENT_KEY',
  install: () => [],
  configFiles: () => [],
  authEnv: () => ({}),
};
registerAgent({
  name: definition.name,
  displayName: definition.displayName,
  getApiKeyEnvVar: definition.getApiKeyEnvVar,
  getDefaultModel: () => definition.defaultModel,
  definition,
  run: async () => {
    stats.active++;
    stats.starts++;
    stats.peak = Math.max(stats.peak, stats.active);
    record();
    await new Promise((resolve) => ${stuck ? 'undefined' : 'setTimeout(resolve, 300)'});
    stats.active--;
    record();
    return { success: true, output: 'ok', duration: 6000, testResult: { success: true, output: 'ok' }, scriptsResults: {} };
  },
});
`
      );
      mkdirSync(join(projectDir, 'experiments'));
      for (const name of ['a', 'b', 'c']) {
        writeFileSync(
          join(projectDir, 'experiments', `${name}.ts`),
          `import '../counting-agent.ts';\nexport default { agent: 'counting-agent', timeout: ${stuck ? 0.05 : 300}, model: ${multiModel ? "['one', 'two']" : "'none'"} };`
        );
      }
      for (const name of ['eval-1', 'eval-2']) {
        const fixture = join(projectDir, 'evals', name);
        mkdirSync(fixture, { recursive: true });
        writeFileSync(join(fixture, 'PROMPT.md'), 'Test task');
        writeFileSync(join(fixture, 'EVAL.ts'), 'test code');
        writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
      }

      return projectDir;
    }

    it.each([
      { args: ['run', 'a', 'b', 'c'], peak: 6, starts: 6 },
      { args: ['run', 'a', 'b', 'c', '--concurrency', '2'], peak: 2, starts: 6 },
      { args: ['--concurrency', '2', 'run', 'a', 'b', 'c'], peak: 2, starts: 6 },
      { args: ['--concurrency', '1', 'run', 'a', 'b', 'c', '--concurrency', '2'], peak: 2, starts: 6 },
      { args: ['a', '--concurrency', '1'], peak: 1, starts: 2 },
      { args: ['run', 'a', 'b', '--concurrency', '2'], peak: 2, starts: 8, multiModel: true },
    ])('schedules the built CLI with $args', ({ args, peak, starts, multiModel }) => {
      const projectDir = countingProject(false, multiModel);
      const result = runCli(args, projectDir, {
        built: true, env: { COUNTING_AGENT_KEY: 'test-key' },
      });
      const statsPath = join(projectDir, 'stats.json');
      expect(result.exitCode, result.stderr).toBe(0);
      expect(existsSync(statsPath), `the agent never ran:\n${result.stdout}${result.stderr}`).toBe(true);
      expect(JSON.parse(readFileSync(statsPath, 'utf-8'))).toEqual({ active: 0, peak, starts });
    });

    it('drains active custom agents and skips later models after a cleanup failure', () => {
      const projectDir = countingProject();
      writeFileSync(join(projectDir, 'cleanup-agent.ts'), `
import './counting-agent.ts';
import { getAgent, registerAgent, SandboxCleanupError } from '@vercel/agent-eval';
import { writeFileSync } from 'node:fs';
let release;
const ready = new Promise(resolve => { release = resolve; });
const state = (globalThis.__cleanupStats ??= { starts: 0, cleaned: 0, strict: true, ready, release });
const record = () => writeFileSync(new URL('./cleanup.json', import.meta.url), JSON.stringify({
  starts: state.starts, cleaned: state.cleaned, strict: state.strict,
}));
registerAgent({
  ...getAgent('counting-agent'), name: 'cleanup-agent',
  run: async (_path, { signal, requireCleanup }) => {
    const first = ++state.starts === 1;
    state.strict &&= requireCleanup === true;
    record();
    if (first) {
      await state.ready;
      throw new SandboxCleanupError('test-container', new Error('daemon unavailable'));
    }
    state.release();
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await new Promise(resolve => setTimeout(resolve, 100));
    state.cleaned++;
    record();
    return { success: false, output: '', error: 'Aborted', duration: 0 };
  },
});
`);
      for (const name of ['a', 'b']) {
        writeFileSync(join(projectDir, 'experiments', `${name}.ts`), `
import '../cleanup-agent.ts';
export default { agent: 'cleanup-agent', evals: ['eval-1'], model: ['one', 'two'], timeout: 0.2 };
`);
      }
      const result = runCli(['run', 'a', 'b', '--concurrency', '2'], projectDir, {
        built: true, env: { COUNTING_AGENT_KEY: 'test-key', AI_GATEWAY_API_KEY: '', VERCEL_OIDC_TOKEN: '' },
      });
      expect(result.exitCode, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('Failed to stop sandbox test-container');
      expect(JSON.parse(readFileSync(join(projectDir, 'cleanup.json'), 'utf-8'))).toEqual({
        starts: 2, cleaned: 1, strict: true,
      });
    });

    it('waits for an active experiment before exiting on another experiment setup error', () => {
      const projectDir = countingProject();
      writeFileSync(join(projectDir, 'drain-agent.ts'), `
import './counting-agent.ts';
import { existsSync, writeFileSync } from 'node:fs';
import { getAgent, registerAgent } from '@vercel/agent-eval';
export async function waitFor(name) {
  const deadline = Date.now() + 3000;
  while (!existsSync(new URL(name, import.meta.url))) {
    if (Date.now() > deadline) throw new Error('Barrier timed out: ' + name);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
registerAgent({
  ...getAgent('counting-agent'), name: 'drain-agent',
  run: async () => {
    writeFileSync(new URL('./started', import.meta.url), '');
    await waitFor('./key-error');
    try {
      return { success: true, output: 'ok', duration: 6000, testResult: { success: true, output: 'ok' } };
    } finally {
      await new Promise(resolve => setTimeout(resolve, 100));
      writeFileSync(new URL('./cleaned-up', import.meta.url), '');
    }
  },
});
`);
      writeFileSync(join(projectDir, 'experiments', 'a.ts'), `
import '../drain-agent.ts';
export default { agent: 'drain-agent', evals: ['eval-1'], timeout: 10 };
`);
      writeFileSync(join(projectDir, 'experiments', 'b.ts'), `
import '../drain-agent.ts';
import { getAgent, registerAgent } from '@vercel/agent-eval';
import { writeFileSync } from 'node:fs';
registerAgent({
  ...getAgent('drain-agent'), name: 'key-error-agent',
  getApiKeyEnvVar: () => {
    writeFileSync(new URL('../key-error', import.meta.url), '');
    throw new Error('API key configuration failed');
  },
});
export default { agent: 'key-error-agent' };
`);
      const result = runCli(['run', 'a', 'b', '--concurrency', '2'], projectDir, {
        built: true, env: { COUNTING_AGENT_KEY: 'test-key', AI_GATEWAY_API_KEY: '', VERCEL_OIDC_TOKEN: '' },
      });
      expect(result.exitCode, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('API key configuration failed');
      expect(existsSync(join(projectDir, 'cleaned-up'))).toBe(true);
      expect(existsSync(join(projectDir, 'results', 'a'))).toBe(true);
    });

    it('keeps the CLI alive until the cleanup deadline, then exits nonzero without starting queued evals', () => {
      const projectDir = countingProject(true);
      const started = Date.now();
      const result = runCli(['run', 'a', '--concurrency', '1'], projectDir, {
        built: true,
        env: { COUNTING_AGENT_KEY: 'test-key', AI_GATEWAY_API_KEY: '', VERCEL_OIDC_TOKEN: '' },
      });
      expect(result.exitCode, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toMatch(/cleanup.*60s/i);
      expect(Date.now() - started).toBeGreaterThanOrEqual(60_000);
      expect(JSON.parse(readFileSync(join(projectDir, 'stats.json'), 'utf-8'))).toEqual({ active: 1, peak: 1, starts: 1 });
      expect(existsSync(join(projectDir, 'results', 'a'))).toBe(false);
    }, 75_000);
  });

  describe('refingerprint command', () => {
    function setupProject(): { projectDir: string; evalPath: string; summaryPath: string } {
      const projectDir = join(TEST_DIR, 'refp');
      const experimentsDir = join(projectDir, 'experiments');
      mkdirSync(experimentsDir, { recursive: true });
      writeFileSync(join(experimentsDir, 'cc.ts'), `export default { agent: 'claude-code', model: 'opus' };`);
      const evalDir = join(projectDir, 'evals', 'eval-1');
      mkdirSync(evalDir, { recursive: true });
      writeFileSync(join(evalDir, 'PROMPT.md'), 'do it');
      writeFileSync(join(evalDir, 'EVAL.ts'), 'test code');
      writeFileSync(join(evalDir, 'package.json'), '{"type":"module"}');
      const summaryDir = join(projectDir, 'results', 'cc', '2026-01-01T00-00-00.000Z', 'eval-1');
      mkdirSync(summaryDir, { recursive: true });
      return { projectDir, evalPath: evalDir, summaryPath: join(summaryDir, 'summary.json') };
    }

    it('carries forward a config-only change but never masks a content change', () => {
      const { projectDir, evalPath, summaryPath } = setupProject();
      const currentContent = computeContentFingerprint(evalPath);

      // Config-only change: stored content fp matches current, combined is stale.
      writeFileSync(
        summaryPath,
        JSON.stringify({
          totalRuns: 1, passedRuns: 1, passRate: '100%', meanDuration: 1,
          fingerprint: 'STALE_COMBINED', contentFingerprint: currentContent,
        })
      );
      let r = runCli(['refingerprint'], projectDir);
      expect(r.exitCode).toBe(0);
      let summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
      expect(summary.fingerprint).not.toBe('STALE_COMBINED'); // carried forward
      expect(summary.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(summary.contentFingerprint).toBe(currentContent); // content untouched

      // Content change: stored content fp differs → must be left stale, NOT masked.
      writeFileSync(
        summaryPath,
        JSON.stringify({
          totalRuns: 1, passedRuns: 1, passRate: '100%', meanDuration: 1,
          fingerprint: 'OLD_COMBINED', contentFingerprint: 'OLD_CONTENT',
        })
      );
      r = runCli(['refingerprint'], projectDir);
      expect(r.exitCode).toBe(0);
      summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
      expect(summary.fingerprint).toBe('OLD_COMBINED'); // NOT re-stamped
      expect(summary.contentFingerprint).toBe('OLD_CONTENT');
    });

    it('--dry does not write', () => {
      const { projectDir, evalPath, summaryPath } = setupProject();
      const currentContent = computeContentFingerprint(evalPath);
      writeFileSync(
        summaryPath,
        JSON.stringify({
          totalRuns: 1, passedRuns: 1, passRate: '100%', meanDuration: 1,
          fingerprint: 'STALE_COMBINED', contentFingerprint: currentContent,
        })
      );
      const r = runCli(['refingerprint', '--dry'], projectDir);
      expect(r.exitCode).toBe(0);
      const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
      expect(summary.fingerprint).toBe('STALE_COMBINED'); // unchanged under --dry
    });

    it('does not carry legacy results across a runtime compatibility boundary', () => {
      const { projectDir, evalPath, summaryPath } = setupProject();
      writeFileSync(
        join(projectDir, 'experiments', 'cc.ts'),
        `export default { agent: 'vercel-ai-gateway/codex', model: 'openai/gpt-5.2-codex', webResearch: true };`
      );
      writeFileSync(
        summaryPath,
        JSON.stringify({
          totalRuns: 1,
          passedRuns: 1,
          passRate: '100%',
          meanDuration: 1,
          fingerprint: 'LEGACY_RESEARCH',
          contentFingerprint: computeContentFingerprint(evalPath),
        })
      );

      const r = runCli(['refingerprint'], projectDir);
      expect(r.exitCode).toBe(0);
      const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
      expect(summary.fingerprint).toBe('LEGACY_RESEARCH');
      expect(r.stdout).toContain('left stale');
      expect(runCli(['status', '--check'], projectDir).exitCode).toBe(1);
    });
  });

  describe('staleness flow (status / refingerprint / --check / --json)', () => {
    it('fresh → change → status + --check + --json flag it; refingerprint stays honest; a rerun clears it', async () => {
      const projectDir = join(TEST_DIR, 'flow');
      const experimentsDir = join(projectDir, 'experiments');
      mkdirSync(experimentsDir, { recursive: true });
      writeFileSync(join(experimentsDir, 'cc.ts'), `export default { agent: 'claude-code', model: 'opus' };`);
      const evalDir = join(projectDir, 'evals', 'eval-1');
      mkdirSync(evalDir, { recursive: true });
      writeFileSync(join(evalDir, 'PROMPT.md'), 'do it');
      writeFileSync(join(evalDir, 'EVAL.ts'), 'v1');
      writeFileSync(join(evalDir, 'package.json'), '{"type":"module"}');
      const summaryPath = join(projectDir, 'results', 'cc', '2026-01-01T00-00-00.000Z', 'eval-1', 'summary.json');
      mkdirSync(dirname(summaryPath), { recursive: true });

      const config = await loadConfig(join(experimentsDir, 'cc.ts'));
      const modelConfig = { ...config, model: Array.isArray(config.model) ? config.model[0] : config.model };
      const seedFresh = () =>
        writeFileSync(
          summaryPath,
          JSON.stringify({
            totalRuns: 1, passedRuns: 1, passRate: '100%', meanDuration: 1,
            fingerprint: computeFingerprint(evalDir, modelConfig as never),
            contentFingerprint: computeContentFingerprint(evalDir),
          })
        );

      // 1. Fresh → status clean, --check passes.
      seedFresh();
      expect(runCli(['status'], projectDir).stdout).toContain('up to date');
      expect(runCli(['status', '--check'], projectDir).exitCode).toBe(0);

      // 2. Eval content changes → status flags it, --check fails, --json reports it.
      writeFileSync(join(evalDir, 'EVAL.ts'), 'v2');
      const s = runCli(['status'], projectDir).stdout;
      expect(s).toContain('changed');
      expect(s).toContain('eval-1');
      expect(runCli(['status', '--check'], projectDir).exitCode).toBe(1);
      const json = JSON.parse(runCli(['status', '--json'], projectDir).stdout);
      expect(json.work).toEqual([{ experiment: 'cc', new: [], changed: ['eval-1'] }]);

      // 3. refingerprint must NOT mask a content change — still failing.
      runCli(['refingerprint'], projectDir);
      expect(runCli(['status', '--check'], projectDir).exitCode).toBe(1);

      // 4. A rerun (simulated by re-seeding fresh for the new content) clears it.
      seedFresh();
      expect(runCli(['status', '--check'], projectDir).exitCode).toBe(0);
    });

    it('status reports new and changed evals as the work to do', async () => {
      const projectDir = join(TEST_DIR, 'status');
      const experimentsDir = join(projectDir, 'experiments');
      mkdirSync(experimentsDir, { recursive: true });
      writeFileSync(join(experimentsDir, 'cc.ts'), `export default { agent: 'claude-code', model: 'opus' };`);
      const evalDir = join(projectDir, 'evals', 'eval-1');
      mkdirSync(evalDir, { recursive: true });
      writeFileSync(join(evalDir, 'PROMPT.md'), 'do it');
      writeFileSync(join(evalDir, 'EVAL.ts'), 'v1');
      writeFileSync(join(evalDir, 'package.json'), '{"type":"module"}');

      const config = await loadConfig(join(experimentsDir, 'cc.ts'));
      const modelConfig = { ...config, model: Array.isArray(config.model) ? config.model[0] : config.model };
      const sp = join(projectDir, 'results', 'cc', '2026-01-01T00-00-00.000Z', 'eval-1', 'summary.json');
      mkdirSync(dirname(sp), { recursive: true });
      writeFileSync(
        sp,
        JSON.stringify({
          totalRuns: 1, passedRuns: 1, passRate: '100%', meanDuration: 1,
          fingerprint: computeFingerprint(evalDir, modelConfig as never),
          contentFingerprint: computeContentFingerprint(evalDir),
        })
      );

      // Up to date.
      expect(runCli(['status'], projectDir).stdout).toContain('up to date');

      // Add a NEW eval (no result) + CHANGE the existing one.
      const evalDir2 = join(projectDir, 'evals', 'eval-2');
      mkdirSync(evalDir2, { recursive: true });
      writeFileSync(join(evalDir2, 'PROMPT.md'), 'do it');
      writeFileSync(join(evalDir2, 'EVAL.ts'), 'x');
      writeFileSync(join(evalDir2, 'package.json'), '{"type":"module"}');
      writeFileSync(join(evalDir, 'EVAL.ts'), 'v2');

      const out = runCli(['status'], projectDir).stdout;
      expect(out).toContain('new'); // eval-2
      expect(out).toContain('eval-2');
      expect(out).toContain('changed'); // eval-1
      expect(out).toContain('eval-1');
      expect(out).toContain('to run');
    });
  });
});
