import { describe, expect, it, vi } from 'vitest';
import { installDependenciesIfPackageJsonExists } from './shared.js';

describe('installDependenciesIfPackageJsonExists', () => {
  it('skips npm install when package.json is missing', async () => {
    const sandbox = {
      fileExists: vi.fn(async () => false),
      runCommand: vi.fn(),
    };

    await installDependenciesIfPackageJsonExists(sandbox as never);

    expect(sandbox.fileExists).toHaveBeenCalledWith('package.json');
    expect(sandbox.runCommand).not.toHaveBeenCalled();
  });

  it('runs npm install when package.json exists', async () => {
    const sandbox = {
      fileExists: vi.fn(async () => true),
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    };

    await installDependenciesIfPackageJsonExists(sandbox as never);

    expect(sandbox.runCommand).toHaveBeenCalledWith('npm', ['install']);
  });

  it('retries npm install once before failing', async () => {
    const sandbox = {
      fileExists: vi.fn(async () => true),
      runCommand: vi
        .fn()
        .mockResolvedValueOnce({ stdout: 'first failure', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: 'second failure', exitCode: 1 }),
    };

    await expect(installDependenciesIfPackageJsonExists(sandbox as never)).rejects.toThrow(
      'npm install failed (exit code 1)'
    );
    expect(sandbox.runCommand).toHaveBeenCalledTimes(2);
  });
});
