import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

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
  });

  describe('run command', () => {
    it('shows error when config file does not exist', () => {
      const result = runCli(['run', '/non/existent/config.ts']);
      expect(result.stderr).toContain('not found');
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

    it('--smoke=name runs the specified eval folder', () => {
      const projectDir = join(TEST_DIR, 'smoke-name-project');
      const experimentsDir = join(projectDir, 'experiments');
      mkdirSync(experimentsDir, { recursive: true });

      const configContent = `export default { agent: 'claude-code' };`;
      writeFileSync(join(experimentsDir, 'cc.ts'), configContent);

      const evalsDir = join(projectDir, 'evals');
      mkdirSync(evalsDir);

      for (const evalName of ['beta-eval', 'alpha-eval']) {
        const fixture = join(evalsDir, evalName);
        mkdirSync(fixture);
        writeFileSync(join(fixture, 'PROMPT.md'), 'Test task');
        writeFileSync(join(fixture, 'EVAL.ts'), 'test code');
        writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
      }

      const result = runCli(['cc', '--smoke=beta-eval', '--dry'], projectDir);
      expect(result.stdout).toContain('SMOKE TEST');
      expect(result.stdout).toContain('beta-eval');
      expect(result.stdout).not.toContain('alpha-eval');
      expect(result.exitCode).toBe(0);
    });

    it('--smoke=invalid-name exits with error', () => {
      const projectDir = join(TEST_DIR, 'smoke-invalid-project');
      const experimentsDir = join(projectDir, 'experiments');
      mkdirSync(experimentsDir, { recursive: true });

      writeFileSync(join(experimentsDir, 'cc.ts'), `export default { agent: 'claude-code' };`);

      const evalsDir = join(projectDir, 'evals');
      mkdirSync(evalsDir);
      const fixture = join(evalsDir, 'only-eval');
      mkdirSync(fixture);
      writeFileSync(join(fixture, 'PROMPT.md'), 'Test');
      writeFileSync(join(fixture, 'EVAL.ts'), 'test');
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));

      const result = runCli(['cc', '--smoke=no-such-eval', '--dry'], projectDir);
      expect(result.stderr).toContain('not found');
      expect(result.stderr).toContain('no-such-eval');
      expect(result.exitCode).toBe(1);
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
});
