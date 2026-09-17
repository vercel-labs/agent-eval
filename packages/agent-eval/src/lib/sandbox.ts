/**
 * Sandbox integration for isolated eval execution.
 * Supports both Vercel Sandbox and Docker backends.
 */

import { Sandbox as VercelSandbox, type Command, type SandboxUser } from '@vercel/sandbox';
import type { Sandbox } from './types.js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { DockerSandboxManager } from './docker-sandbox.js';

/**
 * Default timeout for sandbox operations (10 minutes).
 */
export const DEFAULT_SANDBOX_TIMEOUT = 600000;

/**
 * Supported sandbox backends.
 */
export type SandboxBackend = 'vercel' | 'docker';

/**
 * Information about the resolved sandbox backend.
 */
export interface SandboxBackendInfo {
  /** Which backend will be used */
  backend: SandboxBackend;
  /** How it was determined */
  reason: 'explicit' | 'auto-detected';
  /** Human-readable description */
  description: string;
}

/**
 * Files to ignore when copying to sandbox.
 * These are build artifacts and dependencies that shouldn't be uploaded.
 * Note: This is a general-purpose pattern list used by collectLocalFiles().
 * For eval-specific exclusions (PROMPT.md, EVAL.ts), see TEST_FILE_PATTERNS.
 */
export const IGNORED_PATTERNS = [
  '.git',
  '.next',
  'node_modules',
  '.DS_Store',
  '*.log',
  'build',
  'dist',
  'pnpm-lock.yaml',
  'package-lock.json',
];

/**
 * Test/eval file patterns to withhold from agent during task execution.
 * These files are uploaded AFTER the agent completes for validation.
 * - PROMPT.md: Contains the task - agent receives this via CLI argument, not as a file
 * - EVAL.ts/tsx: Validation tests - must be hidden so agent can't "cheat"
 */
export const TEST_FILE_PATTERNS = ['EVAL.ts', 'EVAL.tsx', 'PROMPT.md'];

/**
 * Options for creating a sandbox.
 */
export interface SandboxOptions {
  /** Timeout in milliseconds */
  timeout?: number;
  /**
   * Runtime environment. Mutually exclusive with `image`.
   * @default 'node24'
   */
  runtime?: 'node20' | 'node24';
  /**
   * Vercel Container Registry image to boot the sandbox from, such as
   * `vercel/sandbox/node:24` or a digest-pinned custom image. Vercel backend
   * only; the Docker backend rejects it. Mutually exclusive with `runtime`.
   * Opt-in: when omitted the sandbox uses `runtime`, exactly as before.
   */
  image?: string;
  /**
   * Linux username to run every command and file operation as, instead of
   * the sandbox's default account. The user is created on the Vercel sandbox
   * and the working directory moves to `/home/<user>/workspace`, which the
   * user owns. Global npm installs are redirected to `~/.npm-global` because
   * the runtime's default prefix is not writable by other users. Command env
   * (including agent auth tokens) is delivered through a user-owned file that a
   * bash bootstrap sources, so values never appear in command arguments. The
   * Docker backend already runs as an unprivileged `node` user and ignores this.
   * Opt-in: when omitted commands run as the default account, as before.
   */
  user?: string;
  /** Sandbox backend to use. 'auto' will use Vercel if token present, else Docker. @default 'auto' */
  backend?: SandboxBackend | 'auto';
  /** Optional explicit Vercel auth token for sandbox API auth */
  token?: string;
  /** Optional explicit Vercel team ID for sandbox API auth */
  teamId?: string;
  /** Optional explicit Vercel project ID for sandbox API auth */
  projectId?: string;
}

/**
 * Result of running a command in the sandbox.
 */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * File to upload to sandbox.
 */
export interface SandboxFile {
  path: string;
  content: Buffer | string;
}

/**
 * Vercel's edge infrastructure cuts long streaming HTTP responses at ~5-6 min,
 * surfacing as `TypeError: terminated` from undici. Commands are started detached
 * and waited on with reconnect loops so no single HTTP request needs to outlive
 * that cutoff — only the in-sandbox process lifetime (bounded by sandbox timeout).
 */
function isStreamTerminated(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TypeError' && err.message === 'terminated') return true;
  const cause = (err as { cause?: { code?: string } }).cause;
  const code = (err as { code?: string }).code ?? cause?.code;
  return code === 'UND_ERR_SOCKET' || code === 'ECONNRESET';
}

async function waitForDetachedCommand(cmd: Command): Promise<CommandResult> {
  let finished;
  while (true) {
    try {
      finished = await cmd.wait();
      break;
    } catch (err) {
      if (!isStreamTerminated(err)) throw err;
    }
  }

  const readOutput = async (read: () => Promise<string>) => {
    while (true) {
      try {
        return await read();
      } catch (err) {
        if (!isStreamTerminated(err)) throw err;
      }
    }
  };

  return {
    stdout: await readOutput(() => finished.stdout()),
    stderr: await readOutput(() => finished.stderr()),
    exitCode: finished.exitCode,
  };
}

/**
 * Error thrown when the Vercel sandbox session backing a run was stopped and a
 * new session started mid-run. The run's workspace lives only in the original
 * session, so continuing would execute later steps against an empty filesystem.
 */
export class SandboxSessionRecycledError extends Error {
  constructor(sandboxName: string) {
    super(
      `Sandbox ${sandboxName} session was stopped and resumed mid-run; ` +
        'the ephemeral workspace is gone, so the run cannot continue.'
    );
    this.name = 'SandboxSessionRecycledError';
  }
}

/**
 * Wrapper around Vercel Sandbox providing a cleaner API.
 */
export class SandboxManager implements Sandbox {
  private sandbox: VercelSandbox;
  private _workingDirectory: string = '/vercel/sandbox';
  private readonly sessionId: string;
  /** Where commands and file writes execute: the sandbox itself, or a created user. */
  private context: Pick<VercelSandbox, 'runCommand' | 'writeFiles'>;
  /** Set once `runAsUser` has switched the execution context to a created user. */
  private user: SandboxUser | undefined;
  /** Env applied to every command; only populated when running as a created user. */
  private baseEnv: Record<string, string> = {};
  /** Env files already written for the user, keyed by their content hash. */
  private readonly envFiles = new Map<string, string>();

  constructor(sandbox: VercelSandbox) {
    this.sandbox = sandbox;
    this.context = sandbox;
    this.sessionId = sandbox.currentSession().sessionId;
  }

  /**
   * Create a new sandbox instance.
   *
   * Sandboxes are ephemeral: the filesystem is not snapshotted on stop, and a
   * session that stops mid-run is treated as a hard failure rather than being
   * transparently resumed into an empty filesystem by the SDK.
   */
  static async create(options: SandboxOptions = {}): Promise<SandboxManager> {
    if (options.image && options.runtime) {
      throw new Error('SandboxOptions.image and SandboxOptions.runtime are mutually exclusive');
    }
    const timeout = options.timeout ?? DEFAULT_SANDBOX_TIMEOUT;
    const environment = options.image ? { image: options.image } : { runtime: options.runtime ?? 'node24' };
    const credentials = resolveVercelSandboxCredentials(options);

    const sandbox = await VercelSandbox.create({
      ...environment,
      timeout,
      persistent: false,
      onResume: async (resumed) => {
        // The SDK has already started the replacement session. Stop it before
        // failing so an abort that races a resume cannot leave an idle session
        // running until the sandbox timeout.
        await resumed.stop().catch(() => {});
        throw new SandboxSessionRecycledError(resumed.name);
      },
      ...(credentials ?? {}),
    });
    const manager = new SandboxManager(sandbox);
    try {
      if (options.user) {
        await manager.runAsUser(options.user);
      } else if (options.image) {
        // Legacy runtimes ship with `/vercel/sandbox`; images boot with whatever
        // WORKDIR they define (the managed ones use `/vercel`), so the default
        // working directory has to be created before the first command uses it.
        await manager.ensureWorkingDirectory();
      }
    } catch (err) {
      await sandbox.stop().catch(() => {});
      throw err;
    }
    return manager;
  }

  private async ensureWorkingDirectory(): Promise<void> {
    const result = await waitForDetachedCommand(
      await this.sandbox.runCommand({
        cmd: 'mkdir',
        args: ['-p', this._workingDirectory],
        cwd: '/',
        detached: true,
      })
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create sandbox working directory ${this._workingDirectory}:\n${result.stderr.trim()}`);
    }
  }

  /**
   * Get the sandbox ID.
   */
  get sandboxId(): string {
    return this.sandbox.name;
  }

  /**
   * The image the sandbox booted from, digest-pinned by the SDK, or undefined
   * for legacy runtime-based sandboxes. Useful for recording provenance.
   */
  get image(): string | undefined {
    return this.sandbox.image;
  }

  /**
   * Create `username` and route all subsequent commands and file operations
   * through it. The default account's `/vercel/sandbox` is not writable by
   * other users, so the working directory moves to `~/workspace`. Global npm
   * installs get a user-owned prefix, and the `SUDO_*` variables the SDK's
   * `sudo -u` transition leaves behind are cleared so the new identity is the
   * only one the agent can observe.
   */
  private async runAsUser(username: string): Promise<void> {
    const user: SandboxUser = await this.sandbox.createUser(username);
    const workspace = `${user.homeDir}/workspace`;
    const npmPrefix = `${user.homeDir}/.npm-global`;

    const setup = await waitForDetachedCommand(
      await user.runCommand({
        cmd: 'bash',
        args: [
          '-c',
          [
            `mkdir -p "${workspace}" "${npmPrefix}/bin"`,
            `printf 'prefix=%s\\n' "${npmPrefix}" > "${user.homeDir}/.npmrc"`,
            'printf %s "$PATH"',
          ].join(' && '),
        ],
        detached: true,
      })
    );
    if (setup.exitCode !== 0) {
      throw new Error(`Failed to prepare sandbox user ${username}:\n${(setup.stdout + setup.stderr).trim()}`);
    }

    this.baseEnv = {
      PATH: `${npmPrefix}/bin:${setup.stdout.trim()}`,
      SUDO_USER: '',
      SUDO_UID: '',
      SUDO_GID: '',
      SUDO_COMMAND: '',
    };
    this.user = user;
    this.context = user;
    this._workingDirectory = workspace;
  }

  /**
   * Build the SDK command for `cmd args` with `env` applied.
   *
   * Default account: env travels in the API request's dedicated env field.
   * Created user: the SDK would fold env into the argv of a `sudo -u` process
   * (`env KEY=VAL ...`), where it is visible in the process list and persisted
   * in the sandbox's command records. Agent auth tokens ride in env, so instead
   * write the variables to a user-owned file once per distinct env set and
   * source it from a bash bootstrap; argv then carries only the file path.
   */
  private async prepareCommand(
    cmd: string,
    args: string[],
    env: Record<string, string> | undefined,
    cwd: string
  ): Promise<{ cmd: string; args: string[]; env?: Record<string, string>; cwd: string; detached: true }> {
    if (!this.user) {
      return { cmd, args, env, cwd, detached: true };
    }
    const merged = { ...this.baseEnv, ...(env ?? {}) };
    const envFile = await this.materializeEnv(this.user, merged);
    return {
      cmd: 'bash',
      // `set -a` exports every assignment sourced from the file; `shift` drops
      // the file path so `exec "$@"` runs exactly the requested command.
      args: ['-c', 'set -a && . "$1" && set +a && shift && exec "$@"', 'bash', envFile, cmd, ...args],
      cwd,
      detached: true,
    };
  }

  private async materializeEnv(user: SandboxUser, env: Record<string, string>): Promise<string> {
    const lines = Object.entries(env)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new Error(`Invalid environment variable name for sandbox command: ${JSON.stringify(key)}`);
        }
        // Single quotes make the value literal; embedded single quotes close,
        // escape, and reopen the quoting.
        return `${key}='${value.replace(/'/g, `'\\''`)}'`;
      });
    const content = `${lines.join('\n')}\n`;
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const cached = this.envFiles.get(hash);
    if (cached) return cached;

    const path = `${user.homeDir}/.agent-eval/env-${hash}.sh`;
    await user.writeFiles([{ path, content: Buffer.from(content, 'utf-8') }]);
    this.envFiles.set(hash, path);
    return path;
  }

  /**
   * The SDK transparently starts a new session when the previous one stopped.
   * `onResume` rejects that in the common path; this guards the remaining case
   * where the SDK reports a fresh session without flagging it as a resume.
   */
  private assertOriginalSession(): void {
    if (this.sandbox.currentSession().sessionId !== this.sessionId) {
      throw new SandboxSessionRecycledError(this.sandbox.name);
    }
  }

  /**
   * Run a command in the sandbox.
   */
  async runCommand(
    command: string,
    args: string[] = [],
    options: { env?: Record<string, string>; cwd?: string } = {}
  ): Promise<CommandResult> {
    const command_ = await this.context.runCommand(
      await this.prepareCommand(command, args, options.env, options.cwd ?? this._workingDirectory)
    );
    this.assertOriginalSession();
    return waitForDetachedCommand(command_);
  }

  /**
   * Run a shell command (through bash).
   */
  async runShell(command: string, env?: Record<string, string>, cwd?: string): Promise<CommandResult> {
    const command_ = await this.context.runCommand(
      await this.prepareCommand('bash', ['-c', command], env, cwd ?? this._workingDirectory)
    );
    this.assertOriginalSession();
    return waitForDetachedCommand(command_);
  }

  /**
   * Read a file from the sandbox, decoded as UTF-8.
   *
   * Lossy for binary files — use `readFileBuffer` for anything that is not text.
   */
  async readFile(path: string): Promise<string> {
    const result = await this.runCommand('cat', [path]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file ${path}: ${result.stderr}`);
    }
    return result.stdout;
  }

  /**
   * Read a file from the sandbox as raw bytes, through base64 encoding.
   */
  async readFileBuffer(path: string): Promise<Buffer> {
    const result = await this.runCommand('base64', [path]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file ${path}: ${result.stderr}`);
    }
    return Buffer.from(result.stdout, 'base64');
  }

  /**
   * Check if a file exists in the sandbox.
   */
  async fileExists(path: string): Promise<boolean> {
    const result = await this.runCommand('test', ['-f', path]);
    return result.exitCode === 0;
  }

  /**
   * Write files to the sandbox.
   */
  async writeFiles(files: Record<string, string>): Promise<void> {
    const sandboxFiles: Array<{ path: string; content: Buffer }> = [];

    for (const [path, content] of Object.entries(files)) {
      sandboxFiles.push({
        path: this.resolveSandboxPath(path),
        content: Buffer.from(content, 'utf-8'),
      });
    }

    await this.context.writeFiles(sandboxFiles);
    this.assertOriginalSession();
  }

  /**
   * Upload files from local filesystem to sandbox.
   */
  async uploadFiles(files: SandboxFile[]): Promise<void> {
    const sandboxFiles = files.map((f) => ({
      path: this.resolveSandboxPath(f.path),
      content: typeof f.content === 'string' ? Buffer.from(f.content, 'utf-8') : f.content,
    }));

    await this.context.writeFiles(sandboxFiles);
    this.assertOriginalSession();
  }

  /**
   * Get the working directory.
   */
  getWorkingDirectory(): string {
    return this._workingDirectory;
  }

  /**
   * Set the working directory.
   */
  setWorkingDirectory(path: string): void {
    this._workingDirectory = path;
  }

  private resolveSandboxPath(path: string): string {
    return isAbsolute(path) ? path : join(this._workingDirectory, path);
  }

  /**
   * Stop and clean up the sandbox.
   */
  async stop(): Promise<void> {
    await this.sandbox.stop();
  }
}

function resolveVercelSandboxCredentials(options: SandboxOptions): {
  token: string;
  teamId: string;
  projectId: string;
} | null {
  const token = options.token ?? process.env.VERCEL_TOKEN;
  const teamId = options.teamId ?? process.env.VERCEL_TEAM_ID;
  const projectId = options.projectId ?? process.env.VERCEL_PROJECT_ID;

  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }

  return null;
}

/**
 * Resolve which sandbox backend to use based on options.
 *
 * Priority:
 * 1. Explicit backend in options (if not 'auto')
 * 2. Auto-detect: Vercel if token present, else Docker
 */
export function resolveBackend(options?: SandboxOptions): SandboxBackend {
  // Explicit backend in options
  if (options?.backend && options.backend !== 'auto') {
    return options.backend;
  }

  // Auto-detect: Vercel if token present, else Docker
  if (process.env.VERCEL_TOKEN || process.env.VERCEL_OIDC_TOKEN) {
    return 'vercel';
  }

  return 'docker';
}

/**
 * Get information about the sandbox backend that will be used.
 * Useful for displaying to users.
 */
export function getSandboxBackendInfo(options?: SandboxOptions): SandboxBackendInfo {
  const backend = resolveBackend(options);

  // Determine the reason
  let reason: 'explicit' | 'auto-detected';
  let description: string;

  const hasExplicitOption = options?.backend && options.backend !== 'auto';

  if (hasExplicitOption) {
    reason = 'explicit';
    description = `${backend} (explicit)`;
  } else {
    reason = 'auto-detected';
    if (backend === 'vercel') {
      description = `${backend} (auto-detected: VERCEL_TOKEN found)`;
    } else {
      description = `${backend} (auto-detected: no VERCEL_TOKEN, using Docker)`;
    }
  }

  return { backend, reason, description };
}

/**
 * Create a sandbox using the appropriate backend.
 *
 * By default, uses Vercel Sandbox if VERCEL_TOKEN is present,
 * otherwise falls back to Docker.
 *
 * @example
 * ```typescript
 * // Auto-detect backend
 * const sandbox = await createSandbox();
 *
 * // Explicit Docker
 * const sandbox = await createSandbox({ backend: 'docker' });
 *
 * // Explicit Vercel
 * const sandbox = await createSandbox({ backend: 'vercel' });
 * ```
 */
export async function createSandbox(
  options: SandboxOptions = {}
): Promise<SandboxManager | DockerSandboxManager> {
  const backend = resolveBackend(options);

  if (backend === 'docker') {
    if (options.image) {
      throw new Error(
        'SandboxOptions.image is only supported by the Vercel sandbox backend; ' +
          'the Docker backend selects its image from `runtime`.'
      );
    }
    // `user` is intentionally ignored: the Docker backend already runs as the
    // unprivileged `node` user, which is what the option asks for.
    return DockerSandboxManager.create({
      timeout: options.timeout,
      runtime: options.runtime,
    });
  }

  return SandboxManager.create({
    timeout: options.timeout,
    runtime: options.runtime,
    image: options.image,
    user: options.user,
  });
}

/**
 * Collect files from a local directory for uploading to sandbox.
 */
export async function collectLocalFiles(
  dir: string,
  options: {
    excludePatterns?: string[];
    includePatterns?: string[];
  } = {}
): Promise<SandboxFile[]> {
  const { readdirSync, statSync } = await import('fs');

  const excludePatterns = options.excludePatterns ?? IGNORED_PATTERNS;
  const includePatterns = options.includePatterns;
  const files: SandboxFile[] = [];

  function shouldExclude(name: string, relativePath: string): boolean {
    for (const pattern of excludePatterns) {
      if (pattern.startsWith('*.')) {
        // Wildcard pattern
        const ext = pattern.slice(1);
        if (name.endsWith(ext)) {
          return true;
        }
      } else if (name === pattern || relativePath === pattern) {
        return true;
      }
    }
    return false;
  }

  function shouldInclude(name: string): boolean {
    if (!includePatterns) {
      return true;
    }
    for (const pattern of includePatterns) {
      if (pattern.startsWith('*.')) {
        const ext = pattern.slice(1);
        if (name.endsWith(ext)) {
          return true;
        }
      } else if (name === pattern) {
        return true;
      }
    }
    return false;
  }

  function walk(currentDir: string, relativePath: string = '') {
    const entries = readdirSync(currentDir);

    for (const entry of entries) {
      const entryRelativePath = relativePath ? `${relativePath}/${entry}` : entry;
      const fullPath = join(currentDir, entry);

      if (shouldExclude(entry, entryRelativePath)) {
        continue;
      }

      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath, entryRelativePath);
      } else if (shouldInclude(entry)) {
        const content = readFileSync(fullPath);
        files.push({ path: entryRelativePath, content });
      }
    }
  }

  walk(dir);
  return files;
}

/**
 * Check if a filename matches any of the test file patterns.
 */
function isTestFilePattern(filename: string): boolean {
  for (const pattern of TEST_FILE_PATTERNS) {
    if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1);
      if (filename.endsWith(ext)) {
        return true;
      }
    } else if (filename === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Split files into workspace files (visible to agent) and test files (hidden until validation).
 */
export function splitTestFiles(files: SandboxFile[]): {
  workspaceFiles: SandboxFile[];
  testFiles: SandboxFile[];
} {
  const workspaceFiles: SandboxFile[] = [];
  const testFiles: SandboxFile[] = [];

  for (const file of files) {
    const name = file.path.split('/').pop() ?? file.path;

    if (isTestFilePattern(name)) {
      testFiles.push(file);
    } else {
      workspaceFiles.push(file);
    }
  }

  return { workspaceFiles, testFiles };
}

/**
 * Verify that no test files exist in the sandbox.
 */
export async function verifyNoTestFiles(
  sandbox: SandboxManager | DockerSandboxManager
): Promise<void> {
  const result = await sandbox.runShell(
    "find . -path './node_modules' -prune  -o -name 'EVAL.ts' -print"
  );

  const foundTests = result.stdout.trim();
  if (foundTests) {
    throw new Error(`Test files found in sandbox before agent run: ${foundTests}`);
  }
}
