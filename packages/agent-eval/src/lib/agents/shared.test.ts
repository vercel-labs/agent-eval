import { describe, expect, it, vi } from 'vitest';
import { injectTranscriptContext, prepareNeutralWorkspace, TRANSCRIPT_CONTEXT_PATH } from './shared.js';

describe('injectTranscriptContext', () => {
  it('materializes natural interaction history for EVAL.ts assertions', async () => {
    const writeFiles = vi.fn();
    const turns = [{ turn: 1, result: { text: 'Which region?' }, userResponse: 'iad1' }];

    await injectTranscriptContext(
      { writeFiles } as never,
      undefined,
      'claude-code',
      undefined,
      turns
    );

    expect(writeFiles).toHaveBeenCalledWith({
      [TRANSCRIPT_CONTEXT_PATH]: JSON.stringify(
        { o11y: null, interaction: { turns } },
        null,
        2
      ),
    });
  });
});

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
