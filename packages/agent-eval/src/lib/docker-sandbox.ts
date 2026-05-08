/**
 * Docker-based sandbox implementation for isolated eval execution.
 * Uses dockerode to manage Docker containers as sandboxes.
 */

import Docker from 'dockerode';
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
 * Directory for npm global packages (non-root install location).
 */
const NPM_GLOBAL_DIR = '/home/node/.npm-global';

/**
 * Options for creating a Docker sandbox.
 */
export interface DockerSandboxOptions {
  /** Timeout in milliseconds */
  timeout?: number;
  /** Runtime environment */
  runtime?: 'node20' | 'node24';
  /** Experiment name (used for container naming) */
  experimentName?: string;
  /** Eval/fixture name (used for container naming) */
  evalName?: string;
  /** Run index (used for container naming) */
  runIndex?: number;
}

/**
 * Sanitize a string for use in a Docker container name.
 * Docker container names must match [a-zA-Z0-9][a-zA-Z0-9_.-]*.
 */
function sanitizeForContainerName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

/**
 * Build a human-readable container name from experiment/eval/run info,
 * so `docker ps` is easy to skim.
 */
function buildContainerName(opts: DockerSandboxOptions): string {
  const parts: string[] = ['agent-eval'];
  if (opts.experimentName) parts.push(sanitizeForContainerName(opts.experimentName));
  if (opts.evalName) parts.push(sanitizeForContainerName(opts.evalName));
  if (opts.runIndex !== undefined) parts.push(`run${opts.runIndex}`);
  // Random suffix avoids collisions across concurrent runs of the same eval
  parts.push(Math.random().toString(36).slice(2, 8));
  return parts.join('_');
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
  private options: DockerSandboxOptions;

  constructor(options: DockerSandboxOptions = {}) {
    this.docker = new Docker();
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.runtime = options.runtime ?? 'node24';
    this.options = options;
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
      name: buildContainerName(this.options),
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

    // Install CA certificates and git (slim images may not include them)
    await this.runCommandAsRoot('bash', ['-c', 'apt-get update -qq && apt-get install -y -qq ca-certificates git > /dev/null 2>&1']);

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
    options: { env?: Record<string, string> } = {}
  ): Promise<CommandResult> {
    // Ensure npm global binaries are in PATH
    const env = {
      ...options.env,
      PATH: `${NPM_GLOBAL_DIR}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    };

    return this.execCommand(command, args, {
      env,
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
    options: { env?: Record<string, string> } = {}
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
    options: { env?: Record<string, string>; user?: string } = {}
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
      WorkingDir: CONTAINER_WORKDIR,
      Env: env,
      User: options.user,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      // Docker multiplexes stdout/stderr in the stream
      // We need to demux it
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => {
        // Docker stream format: 8-byte header + payload
        // Header: [stream_type (1 byte), 0, 0, 0, size (4 bytes)]
        // stream_type: 1 = stdout, 2 = stderr
        let offset = 0;
        while (offset < chunk.length) {
          if (offset + 8 > chunk.length) {
            // Incomplete header, treat rest as stdout
            stdoutChunks.push(chunk.slice(offset));
            break;
          }

          const streamType = chunk[offset];
          const size = chunk.readUInt32BE(offset + 4);

          if (offset + 8 + size > chunk.length) {
            // Incomplete payload, treat rest as stdout
            stdoutChunks.push(chunk.slice(offset + 8));
            break;
          }

          const payload = chunk.slice(offset + 8, offset + 8 + size);
          if (streamType === 1) {
            stdoutChunks.push(payload);
          } else if (streamType === 2) {
            stderrChunks.push(payload);
          } else {
            // Unknown type, assume stdout
            stdoutChunks.push(payload);
          }

          offset += 8 + size;
        }
      });

      stream.on('end', async () => {
        stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        stderr = Buffer.concat(stderrChunks).toString('utf-8');

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
  async runShell(command: string, env?: Record<string, string>): Promise<CommandResult> {
    return this.runCommand('bash', ['-c', command], { env });
  }

  /**
   * Read a file from the container.
   */
  async readFile(path: string): Promise<string> {
    const result = await this.runCommand('cat', [path]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file ${path}: ${result.stderr}`);
    }
    return result.stdout;
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
    return CONTAINER_WORKDIR;
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
