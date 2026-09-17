import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createVercelSandbox } = vi.hoisted(() => ({
  createVercelSandbox: vi.fn(),
}));

vi.mock('@vercel/sandbox', () => ({
  Sandbox: { create: createVercelSandbox },
}));

import { DEFAULT_SANDBOX_TIMEOUT, SandboxManager, SandboxSessionRecycledError } from './sandbox.js';

/**
 * Minimal stand-in for the SDK's Sandbox at the wrapper's external boundary.
 * `sessionId` is mutable so a test can simulate the SDK swapping in a fresh
 * session behind the wrapper's back.
 */
function fakeSandbox(name = 'sandbox-123') {
  const state = { sessionId: 'session-1' };
  const finished = {
    exitCode: 0,
    stdout: async () => 'ok\n',
    stderr: async () => '',
  };
  return {
    state,
    name,
    currentSession: () => ({ sessionId: state.sessionId }),
    runCommand: vi.fn(async () => ({ wait: async () => finished })),
    writeFiles: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

describe('SandboxManager.create', () => {
  beforeEach(() => {
    createVercelSandbox.mockReset();
    createVercelSandbox.mockResolvedValue(fakeSandbox());
    // The test setup loads .env for every file; a developer with the token-auth
    // triple configured would otherwise see credentials spread into the create
    // call and the exact default-path assertion below fail locally only.
    vi.stubEnv('VERCEL_TOKEN', '');
    vi.stubEnv('VERCEL_TEAM_ID', '');
    vi.stubEnv('VERCEL_PROJECT_ID', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('preserves the existing node24 runtime and ephemeral lifecycle by default', async () => {
    const sandbox = await SandboxManager.create();

    expect(createVercelSandbox).toHaveBeenCalledWith({
      runtime: 'node24',
      timeout: DEFAULT_SANDBOX_TIMEOUT,
      persistent: false,
      onResume: expect.any(Function),
    });
    expect(sandbox.sandboxId).toBe('sandbox-123');
  });

  it('preserves explicit runtime, timeout, and credential options', async () => {
    const sandbox = await SandboxManager.create({
      runtime: 'node20',
      timeout: 30_000,
      token: 'token',
      teamId: 'team-id',
      projectId: 'project-id',
    });

    expect(createVercelSandbox).toHaveBeenCalledWith({
      runtime: 'node20',
      timeout: 30_000,
      persistent: false,
      onResume: expect.any(Function),
      token: 'token',
      teamId: 'team-id',
      projectId: 'project-id',
    });
    expect(sandbox.sandboxId).toBe('sandbox-123');
  });

  it('rejects an SDK-initiated resume and stops the replacement session so nothing idles until timeout', async () => {
    await SandboxManager.create();
    const { onResume } = createVercelSandbox.mock.calls[0][0] as {
      onResume: (sandbox: { name: string; stop: () => Promise<unknown> }) => Promise<void>;
    };
    const replacement = { name: 'sandbox-123', stop: vi.fn(async () => ({})) };

    await expect(onResume(replacement)).rejects.toBeInstanceOf(SandboxSessionRecycledError);
    expect(replacement.stop).toHaveBeenCalledTimes(1);
  });

  it('still fails the run when the replacement session cannot be stopped', async () => {
    await SandboxManager.create();
    const { onResume } = createVercelSandbox.mock.calls[0][0] as {
      onResume: (sandbox: { name: string; stop: () => Promise<unknown> }) => Promise<void>;
    };
    const replacement = {
      name: 'sandbox-123',
      stop: vi.fn(async () => {
        throw new Error('already stopping');
      }),
    };

    await expect(onResume(replacement)).rejects.toBeInstanceOf(SandboxSessionRecycledError);
  });

  it('fails the next operation when the SDK swapped sessions without reporting a resume', async () => {
    const fake = fakeSandbox();
    createVercelSandbox.mockResolvedValue(fake);
    const sandbox = await SandboxManager.create();

    expect((await sandbox.runCommand('echo', ['ok'])).stdout).toBe('ok\n');

    fake.state.sessionId = 'session-2';

    await expect(sandbox.runCommand('echo', ['ok'])).rejects.toBeInstanceOf(SandboxSessionRecycledError);
    await expect(sandbox.runShell('true')).rejects.toBeInstanceOf(SandboxSessionRecycledError);
    await expect(sandbox.writeFiles({ 'a.txt': 'a' })).rejects.toBeInstanceOf(SandboxSessionRecycledError);
    await expect(sandbox.uploadFiles([{ path: 'b.txt', content: 'b' }])).rejects.toBeInstanceOf(
      SandboxSessionRecycledError
    );
  });
});
