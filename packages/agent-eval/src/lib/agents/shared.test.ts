import { describe, expect, it, vi } from 'vitest';
import {
  ensureValidationRunner,
  FALLBACK_VITEST_VERSION,
  prepareNeutralWorkspace,
  runValidation,
} from './shared.js';

describe('prepareNeutralWorkspace', () => {
  it('copies Vercel sandboxes into /workspace and switches the working directory', async () => {
    const sandbox = {
      getWorkingDirectory: vi.fn(() => '/vercel/sandbox'),
      setWorkingDirectory: vi.fn(),
      runShell: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    };

    const result = await prepareNeutralWorkspace(sandbox as never);

    expect(sandbox.runShell).toHaveBeenCalledWith('git remote remove origin 2>/dev/null || true; rm -rf .git/logs');
    expect(sandbox.runShell).toHaveBeenCalledWith(expect.stringContaining('sudo cp -a . /workspace/'));
    expect(sandbox.setWorkingDirectory).toHaveBeenCalledWith('/workspace');
    expect(result).toEqual({
      cwd: '/workspace',
      env: { USER: 'user', LOGNAME: 'user' },
    });
  });

  it('keeps non-Vercel sandbox working directories in place', async () => {
    const sandbox = {
      getWorkingDirectory: vi.fn(() => '/home/sandbox/workspace'),
      setWorkingDirectory: vi.fn(),
      runShell: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    };

    const result = await prepareNeutralWorkspace(sandbox as never);

    expect(sandbox.runShell).toHaveBeenCalledTimes(1);
    expect(sandbox.setWorkingDirectory).not.toHaveBeenCalled();
    expect(result).toEqual({
      cwd: '/home/sandbox/workspace',
      env: { USER: 'user', LOGNAME: 'user' },
    });
  });
});

describe('ensureValidationRunner', () => {
  const sandboxWith = (present: boolean) => ({
    runShell: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: present ? 0 : 1 })),
    runCommand: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
  });

  it('leaves a workspace that already has vitest alone', async () => {
    const sandbox = sandboxWith(true);

    await ensureValidationRunner(sandbox as never);

    expect(sandbox.runShell).toHaveBeenCalledWith('test -e node_modules/vitest/package.json');
    expect(sandbox.runCommand).not.toHaveBeenCalled();
  });

  it('reinstalls vitest when the agent removed it, leaving manifest and lockfile alone', async () => {
    const sandbox = sandboxWith(false);

    await ensureValidationRunner(sandbox as never);

    expect(sandbox.runCommand).toHaveBeenCalledWith('npm', [
      'install',
      '--no-save',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      `vitest@${FALLBACK_VITEST_VERSION}`,
    ]);
  });
});

describe('runValidation', () => {
  it('restores the runner before invoking vitest', async () => {
    const order: string[] = [];
    const sandbox = {
      runShell: vi.fn(async (cmd: string) => {
        order.push(`shell:${cmd}`);
        return { stdout: 'package.json\nEVAL.ts\n', stderr: '', exitCode: 1 };
      }),
      runCommand: vi.fn(async (cmd: string, args: string[]) => {
        order.push(`${cmd} ${args.join(' ')}`);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };

    await runValidation(sandbox as never, []);

    const install = order.findIndex((c) => c.startsWith('npm install --no-save'));
    const run = order.findIndex((c) => c.startsWith('npx vitest run'));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(install);
  });
});
