import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { computeContentFingerprint, computeFingerprint } from './lib/fingerprint.js';
import { loadConfig } from './lib/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const CLI_PATH = resolve(PROJECT_ROOT, 'src/cli.ts');

const TEST_DIR = '/tmp/eval-framework-cli-test';

function runCli(args: string[], cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`npx tsx ${CLI_PATH} ${args.join(' ')}`, {
      cwd: cwd ?? PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
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
    mkdirSync(TEST_DIR, { recursive: true });
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

    it('documents playground port flags', () => {
      const result = runCli(['playground', '--help']);
      expect(result.stdout).toContain('--port');
      expect(result.stdout).toContain('-p');
      expect(result.stdout).toContain('PORT');
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
