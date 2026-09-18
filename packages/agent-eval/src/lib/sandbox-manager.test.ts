import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createVercelSandbox } = vi.hoisted(() => ({
  createVercelSandbox: vi.fn(),
}));

vi.mock('@vercel/sandbox', () => ({
  Sandbox: { create: createVercelSandbox },
}));

import { DEFAULT_SANDBOX_TIMEOUT, SandboxManager, SandboxSessionRecycledError, createSandbox } from './sandbox.js';

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
    image: undefined as string | undefined,
    currentSession: () => ({ sessionId: state.sessionId }),
    runCommand: vi.fn(async () => ({ wait: async () => finished })),
    writeFiles: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    createUser: vi.fn(async (username: string) => fakeUser(username)),
  };
}

/**
 * Stand-in for the SDK's SandboxUser. The first command it receives is the
 * wrapper's own setup step, which reports the user's PATH on stdout.
 */
function fakeUser(username: string, path = '/usr/local/bin:/usr/bin:/bin') {
  const commands: Array<Record<string, unknown>> = [];
  const finished = (stdout: string) => ({ exitCode: 0, stdout: async () => stdout, stderr: async () => '' });
  return {
    username,
    homeDir: `/home/${username}`,
    commands,
    runCommand: vi.fn(async (params: Record<string, unknown>) => {
      commands.push(params);
      return { wait: async () => finished(commands.length === 1 ? path : 'as-user\n') };
    }),
    writeFiles: vi.fn(async () => {}),
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

describe('SandboxManager.create opt-in image and user', () => {
  beforeEach(() => {
    createVercelSandbox.mockReset();
    createVercelSandbox.mockResolvedValue(fakeSandbox());
    vi.stubEnv('VERCEL_TOKEN', '');
    vi.stubEnv('VERCEL_TEAM_ID', '');
    vi.stubEnv('VERCEL_PROJECT_ID', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('boots from an image instead of the legacy runtime when image is set', async () => {
    const fake = fakeSandbox();
    fake.image = 'vercel/sandbox/node@sha256:abc';
    createVercelSandbox.mockResolvedValue(fake);

    const sandbox = await SandboxManager.create({ image: 'vercel/sandbox/node:24' });

    const request = createVercelSandbox.mock.calls[0][0] as Record<string, unknown>;
    expect(request.image).toBe('vercel/sandbox/node:24');
    expect(request).not.toHaveProperty('runtime');
    expect(sandbox.image).toBe('vercel/sandbox/node@sha256:abc');
    // Images do not ship the legacy `/vercel/sandbox`; the wrapper creates it
    // from `/` so later commands have a valid cwd.
    expect(fake.runCommand).toHaveBeenCalledWith({ cmd: 'mkdir', args: ['-p', '/vercel/sandbox'], cwd: '/', detached: true });
  });

  it('stops the sandbox and fails create when the image working directory cannot be created', async () => {
    const fake = fakeSandbox();
    fake.runCommand.mockResolvedValue({
      wait: async () => ({ exitCode: 1, stdout: async () => '', stderr: async () => 'mkdir: read-only file system' }),
    });
    createVercelSandbox.mockResolvedValue(fake);

    await expect(SandboxManager.create({ image: 'vercel/sandbox/node:24' })).rejects.toThrow(/read-only file system/);
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('refuses image together with runtime before contacting the SDK', async () => {
    await expect(SandboxManager.create({ image: 'vercel/sandbox/node:24', runtime: 'node24' })).rejects.toThrow(
      /mutually exclusive/
    );
    expect(createVercelSandbox).not.toHaveBeenCalled();
  });

  it('runs commands and file writes as the created user from a user-owned workspace with a writable npm prefix', async () => {
    const fake = fakeSandbox();
    createVercelSandbox.mockResolvedValue(fake);

    const sandbox = await SandboxManager.create({ user: 'user' });
    const user = await fake.createUser.mock.results[0].value;

    expect(fake.createUser).toHaveBeenCalledWith('user');
    expect(sandbox.getWorkingDirectory()).toBe('/home/user/workspace');
    // Setup ran as the user and prepared the workspace + npm prefix.
    expect(user.commands[0]).toMatchObject({ cmd: 'bash' });
    expect(String((user.commands[0].args as string[])[1])).toContain('mkdir -p "/home/user/workspace" "/home/user/.npm-global/bin"');
    expect(String((user.commands[0].args as string[])[1])).toContain("prefix=%s");

    const result = await sandbox.runShell('whoami', { FOO: 'bar' });

    expect(result.stdout).toBe('as-user\n');
    // Routed through the user, not the sandbox's default account.
    expect(fake.runCommand).not.toHaveBeenCalled();
    expect(user.commands[1]).toMatchObject({ cwd: '/home/user/workspace' });

    await sandbox.writeFiles({ 'src/index.ts': 'export {};' });
    expect(user.writeFiles).toHaveBeenCalledWith([
      { path: '/home/user/workspace/src/index.ts', content: Buffer.from('export {};', 'utf-8') },
    ]);
    expect(fake.writeFiles).not.toHaveBeenCalled();
  });

  it('keeps env values out of argv in user mode: they are sourced from a user-owned file', async () => {
    const fake = fakeSandbox();
    createVercelSandbox.mockResolvedValue(fake);
    const sandbox = await SandboxManager.create({ user: 'user' });
    const user = await fake.createUser.mock.results[0].value;

    await sandbox.runCommand('node', ['run.mjs'], { env: { ANTHROPIC_AUTH_TOKEN: "sk-it's-secret", FOO: 'bar' } });

    const params = user.commands[1];
    expect(params.env).toBeUndefined();
    expect(JSON.stringify(params.args)).not.toContain('secret');
    const [flag, bootstrap, argv0, envFile, ...rest] = params.args as string[];
    expect(flag).toBe('-c');
    expect(bootstrap).toBe('set -a && . "$1" && set +a && shift && exec "$@"');
    expect(argv0).toBe('bash');
    expect(envFile).toMatch(/^\/home\/user\/\.agent-eval\/env-[0-9a-f]{16}\.sh$/);
    expect(rest).toEqual(['node', 'run.mjs']);

    const [write] = user.writeFiles.mock.calls.at(-1)!;
    expect(write[0].path).toBe(envFile);
    expect(write[0].content.toString('utf-8')).toBe(
      [
        "ANTHROPIC_AUTH_TOKEN='sk-it'\\''s-secret'",
        "FOO='bar'",
        "PATH='/home/user/.npm-global/bin:/usr/local/bin:/usr/bin:/bin'",
        "SUDO_COMMAND=''",
        "SUDO_GID=''",
        "SUDO_UID=''",
        "SUDO_USER=''",
        '',
      ].join('\n')
    );
  });

  it('writes each distinct env set once and reuses the file for repeated commands', async () => {
    const fake = fakeSandbox();
    createVercelSandbox.mockResolvedValue(fake);
    const sandbox = await SandboxManager.create({ user: 'user' });
    const user = await fake.createUser.mock.results[0].value;

    await sandbox.runCommand('echo', ['a'], { env: { FOO: 'bar' } });
    await sandbox.runShell('echo b', { FOO: 'bar' });
    await sandbox.runCommand('echo', ['c']);

    const envFiles = user.writeFiles.mock.calls.map(([files]: [Array<{ path: string }>]) => files[0].path);
    expect(new Set(envFiles).size).toBe(2);
    const argvFile = (i: number) => (user.commands[i].args as string[])[3];
    expect(argvFile(1)).toBe(argvFile(2));
    expect(argvFile(3)).not.toBe(argvFile(1));
  });

  it('rejects env names that could break out of the sourced file', async () => {
    const fake = fakeSandbox();
    createVercelSandbox.mockResolvedValue(fake);
    const sandbox = await SandboxManager.create({ user: 'user' });

    await expect(sandbox.runCommand('echo', [], { env: { 'BAD NAME; rm -rf /': 'x' } })).rejects.toThrow(
      /Invalid environment variable name/
    );
  });

  it('lets a caller override PATH for one command without losing the user identity env', async () => {
    const fake = fakeSandbox();
    createVercelSandbox.mockResolvedValue(fake);
    const sandbox = await SandboxManager.create({ user: 'user' });
    const user = await fake.createUser.mock.results[0].value;

    await sandbox.runCommand('node', ['-v'], { env: { PATH: '/custom/bin' } });

    const [write] = user.writeFiles.mock.calls.at(-1)!;
    const content = write[0].content.toString('utf-8');
    expect(content).toContain("PATH='/custom/bin'");
    expect(content).toContain("SUDO_USER=''");
  });

  it('stops the sandbox and fails create when the user cannot be prepared', async () => {
    const fake = fakeSandbox();
    fake.createUser.mockRejectedValue(new Error('useradd: permission denied'));
    createVercelSandbox.mockResolvedValue(fake);

    await expect(SandboxManager.create({ user: 'user' })).rejects.toThrow('useradd: permission denied');
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('leaves the default account and env untouched when user is not set', async () => {
    const fake = fakeSandbox();
    createVercelSandbox.mockResolvedValue(fake);
    const sandbox = await SandboxManager.create();

    await sandbox.runCommand('echo', ['ok'], { env: { FOO: 'bar' } });

    expect(fake.createUser).not.toHaveBeenCalled();
    expect(fake.runCommand).toHaveBeenCalledWith({
      cmd: 'echo',
      args: ['ok'],
      env: { FOO: 'bar' },
      cwd: '/vercel/sandbox',
      detached: true,
    });
  });
});

describe('createSandbox backend dispatch for opt-in options', () => {
  beforeEach(() => {
    createVercelSandbox.mockReset();
    createVercelSandbox.mockResolvedValue(fakeSandbox());
  });

  it('rejects image on the Docker backend instead of silently booting a different environment', async () => {
    await expect(createSandbox({ backend: 'docker', image: 'vercel/sandbox/node:24' })).rejects.toThrow(
      /only supported by the Vercel sandbox backend/
    );
    expect(createVercelSandbox).not.toHaveBeenCalled();
  });

  it('forwards image and user to the Vercel backend', async () => {
    const fake = fakeSandbox();
    createVercelSandbox.mockResolvedValue(fake);

    const sandbox = await createSandbox({ backend: 'vercel', image: 'vercel/sandbox/node:24', user: 'user' });

    expect((createVercelSandbox.mock.calls[0][0] as Record<string, unknown>).image).toBe('vercel/sandbox/node:24');
    expect(fake.createUser).toHaveBeenCalledWith('user');
    expect(sandbox.getWorkingDirectory()).toBe('/home/user/workspace');
  });
});
