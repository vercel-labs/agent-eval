/**
 * Docker-based sandbox implementation for isolated eval execution.
 * Uses dockerode to manage Docker containers as sandboxes.
 */

import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import * as tar from 'tar-stream';
import type { Sandbox } from './types.js';
import type { CommandResult, SandboxFile } from './sandbox.js';

/**
 * Docker images for each Node.js runtime.
 * Using -slim variants for faster downloads while maintaining compatibility.
 */
const DOCKER_IMAGES: Record<string, string> = {
  node20: 'node:20-slim',
  node24: 'node:24-slim',
};

/**
 * Default timeout for container operations (10 minutes).
 */
const DEFAULT_TIMEOUT = 600000;

/**
 * Working directory inside the container.
 */
const CONTAINER_WORKDIR = '/home/sandbox/workspace';

/**
 * Non-root user configuration.
 * Running as non-root is important for security and compatibility
 * (e.g., Claude Code refuses --dangerously-skip-permissions as root).
 * Node.js images already have a 'node' user with UID/GID 1000.
 */
const SANDBOX_UID = 1000;
const SANDBOX_GID = 1000;

/**
 * Home of the image `node` user (UID 1000). Official Node images set this as
 * the passwd home; we also export it on every sandbox-user exec so installers
 * that write to `$HOME/.local` (Cursor CLI, custom OpenCode binaries) land in a
 * writable directory instead of the container's root HOME (`/root`).
 */
export const SANDBOX_HOME = '/home/node';

/**
 * Directory for npm global packages (non-root install location).
 */
const NPM_GLOBAL_DIR = `${SANDBOX_HOME}/.npm-global`;

/** User-local binaries. Cursor's official installer and `pip --user` write here. */
const LOCAL_BIN_DIR = `${SANDBOX_HOME}/.local/bin`;

/**
 * Packages missing from `node:*-slim`. `git` is required for the workspace
 * baseline; `curl` is required by Cursor's official installer and OpenCode's
 * custom-binary download. `ca-certificates` makes those HTTPS fetches work.
 */
export const SANDBOX_APT_PACKAGES = ['ca-certificates', 'git', 'curl'] as const;

export function dockerSandboxAptInstallScript(): string {
  return `apt-get update -qq && apt-get install -y -qq ${SANDBOX_APT_PACKAGES.join(' ')}`;
}

/**
 * PATH for sandbox-user execs. Includes npm's non-root global prefix and the
 * user-local bin dir. Docker exec would otherwise inherit a root-oriented PATH
 * that cannot see `~/.local/bin/agent` after `curl https://cursor.com/install`.
 */
export function dockerSandboxPath(): string {
  return `${NPM_GLOBAL_DIR}/bin:${LOCAL_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
}

/**
 * Env for commands run as the sandbox user. PATH is always the sandbox PATH
 * (callers cannot override it — same as before this helper was extracted).
 * HOME defaults to the `node` user home and can be overridden via `overrides`.
 */
export function dockerSandboxUserEnv(
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    HOME: SANDBOX_HOME,
    ...overrides,
    PATH: dockerSandboxPath(),
  };
}

/**
 * Options for creating a Docker sandbox.
 */
export interface DockerSandboxOptions {
  /** Timeout in milliseconds */
  timeout?: number;
  /** Runtime environment */
  runtime?: 'node20' | 'node24';
}

/**
 * Docker-based sandbox manager.
 * Creates isolated containers for running evals.
 */
export class DockerSandboxManager implements Sandbox {
  private docker: Docker;
  private container: Docker.Container | null = null;
  private _containerId: string = '';
  private timeout: number;
  private runtime: string;
  private _workingDirectory: string = CONTAINER_WORKDIR;

  constructor(options: DockerSandboxOptions = {}) {
    this.docker = new Docker();
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.runtime = options.runtime ?? 'node24';
  }

  /**
   * Create and start a new Docker sandbox.
   */
  static async create(options: DockerSandboxOptions = {}): Promise<DockerSandboxManager> {
    const manager = new DockerSandboxManager(options);
    await manager.initialize();
    return manager;
  }

  /**
   * Initialize the sandbox by pulling image and creating container.
   */
  private async initialize(): Promise<void> {
    const imageName = DOCKER_IMAGES[this.runtime];
    if (!imageName) {
      throw new Error(`Unsupported runtime: ${this.runtime}`);
    }

    // Ensure the image is available
    await this.ensureImage(imageName);

    // Create the container (starts as root for setup, then switches to non-root user)
    this.container = await this.docker.createContainer({
      Image: imageName,
      Cmd: ['sleep', 'infinity'], // Keep container running
      WorkingDir: CONTAINER_WORKDIR,
      Tty: true,
      HostConfig: {
        AutoRemove: true, // Clean up when stopped
      },
    });

    this._containerId = this.container.id;

    // Start the container
    await this.container.start();

    // Slim images omit git/curl; swallowing apt output hid install failures and
    // left Cursor at `curl: command not found` after a green-looking setup.
    const packages = await this.runCommandAsRoot('bash', ['-c', dockerSandboxAptInstallScript()]);
    if (packages.exitCode !== 0) {
      const body = (packages.stdout + packages.stderr).trim().split('\n').slice(-10).join('\n');
      throw new Error(`Failed to install sandbox packages:\n${body}`);
    }

    // Create workspace directory owned by the non-root user (node:node in Node.js images)
    // The node user (UID 1000) already exists in node:*-slim images
    await this.runCommandAsRoot('mkdir', ['-p', CONTAINER_WORKDIR]);
    await this.runCommandAsRoot('chown', ['-R', `${SANDBOX_UID}:${SANDBOX_GID}`, CONTAINER_WORKDIR]);

    // Configure npm for non-root global installs
    // Create a user-local directory for global packages
    await this.runCommandAsRoot('mkdir', ['-p', NPM_GLOBAL_DIR]);
    await this.runCommandAsRoot('chown', ['-R', `${SANDBOX_UID}:${SANDBOX_GID}`, NPM_GLOBAL_DIR]);

    // Configure npm to use this directory
    await this.runCommand('npm', ['config', 'set', 'prefix', NPM_GLOBAL_DIR]);
  }

  /**
   * Ensure the Docker image is available locally, pulling if needed.
   */
  private async ensureImage(imageName: string): Promise<void> {
    try {
      // Check if image exists
      const image = this.docker.getImage(imageName);
      await image.inspect();
    } catch {
      // Image doesn't exist, pull it
      console.log(`Pulling Docker image: ${imageName}...`);
      await this.pullImage(imageName);
      console.log(`Docker image ready: ${imageName}`);
    }
  }

  /**
   * Pull a Docker image with progress output.
   */
  private async pullImage(imageName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.pull(imageName, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          reject(err);
          return;
        }

        // Follow the pull progress
        this.docker.modem.followProgress(
          stream,
          (err: Error | null) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          },
          // Progress callback (optional, could add progress bar here)
          () => {}
        );
      });
    });
  }

  /**
   * Get the container ID.
   */
  get sandboxId(): string {
    return this._containerId.slice(0, 12); // Short ID like Docker CLI
  }

  /**
   * Run a command in the container as the sandbox (non-root) user.
   */
  async runCommand(
    command: string,
    args: string[] = [],
    options: { env?: Record<string, string>; cwd?: string } = {}
  ): Promise<CommandResult> {
    const env = dockerSandboxUserEnv(options.env);

    return this.execCommand(command, args, {
      env,
      cwd: options.cwd,
      user: `${SANDBOX_UID}:${SANDBOX_GID}`,
    });
  }

  /**
   * Run a command in the container as root.
   * Used internally for setup tasks.
   */
  private async runCommandAsRoot(
    command: string,
    args: string[] = [],
    options: { env?: Record<string, string>; cwd?: string } = {}
  ): Promise<CommandResult> {
    return this.execCommand(command, args, {
      ...options,
      user: 'root',
    });
  }

  /**
   * Execute a command in the container.
   */
  private async execCommand(
    command: string,
    args: string[] = [],
    options: { env?: Record<string, string>; cwd?: string; user?: string } = {}
  ): Promise<CommandResult> {
    if (!this.container) {
      throw new Error('Container not initialized');
    }

    const cmd = [command, ...args];
    const env = options.env
      ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`)
      : undefined;

    const exec = await this.container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: options.cwd ?? this._workingDirectory,
      Env: env,
      User: options.user,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const stdoutStream = new PassThrough();
      const stderrStream = new PassThrough();
      stdoutStream.on('data', (chunk) => stdoutChunks.push(chunk));
      stderrStream.on('data', (chunk) => stderrChunks.push(chunk));

      // Docker multiplexes stdout and stderr into one framed stream, and frames
      // split across `data` events at arbitrary byte offsets. Let docker-modem
      // own the framing rather than re-implementing it here.
      this.docker.modem.demuxStream(stream, stdoutStream, stderrStream);

      stream.on('end', async () => {
        stdoutStream.end();
        stderrStream.end();
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');

        try {
          const inspection = await exec.inspect();
          resolve({
            stdout,
            stderr,
            exitCode: inspection.ExitCode ?? 0,
          });
        } catch (error) {
          reject(error);
        }
      });

      stream.on('error', reject);

      // Timeout handling
      const timeoutId = setTimeout(() => {
        stream.destroy();
        reject(new Error(`Command timed out after ${this.timeout}ms`));
      }, this.timeout);

      stream.on('end', () => clearTimeout(timeoutId));
    });
  }

  /**
   * Run a shell command (through bash).
   */
  async runShell(command: string, env?: Record<string, string>, cwd?: string): Promise<CommandResult> {
    return this.runCommand('bash', ['-c', command], { env, cwd });
  }

  /**
   * Read a file from the container, decoded as UTF-8.
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
   * Check if a file exists in the container.
   */
  async fileExists(path: string): Promise<boolean> {
    const result = await this.runCommand('test', ['-f', path]);
    return result.exitCode === 0;
  }

  /**
   * Write files to the container.
   */
  async writeFiles(files: Record<string, string>): Promise<void> {
    const sandboxFiles: SandboxFile[] = Object.entries(files).map(([path, content]) => ({
      path,
      content: Buffer.from(content, 'utf-8'),
    }));

    await this.uploadFiles(sandboxFiles);
  }

  /**
   * Upload files to the container using tar archive.
   */
  async uploadFiles(files: SandboxFile[]): Promise<void> {
    if (!this.container) {
      throw new Error('Container not initialized');
    }

    if (files.length === 0) {
      return;
    }

    // Create a tar archive
    const pack = tar.pack();

    for (const file of files) {
      const content = typeof file.content === 'string'
        ? Buffer.from(file.content, 'utf-8')
        : file.content;

      pack.entry({ name: file.path }, content);
    }

    pack.finalize();

    // Upload to container
    await this.container.putArchive(pack, { path: CONTAINER_WORKDIR });

    // Fix ownership - putArchive uploads as root, but we need files owned by node user
    // so that OpenCode and other agents can edit them
    await this.runCommandAsRoot('chown', ['-R', `${SANDBOX_UID}:${SANDBOX_GID}`, CONTAINER_WORKDIR]);
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

  /**
   * Stop and clean up the container.
   */
  async stop(): Promise<void> {
    if (this.container) {
      try {
        await this.container.stop({ t: 0 }); // Immediate stop
      } catch {
        // Container may already be stopped or removed
      }
      this.container = null;
    }
  }
}
