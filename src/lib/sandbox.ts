/**
 * Sandbox integration for isolated eval execution.
 * Supports both Vercel Sandbox and Docker backends.
 */

import { Sandbox as VercelSandbox } from '@vercel/sandbox';
import type { Sandbox } from './types.js';
import { readFileSync } from 'fs';
import { join } from 'path';
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
  /** Runtime environment */
  runtime?: 'node20' | 'node24';
  /** Sandbox backend to use. 'auto' will use Vercel if token present, else Docker. @default 'auto' */
  backend?: SandboxBackend | 'auto';
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
 * Wrapper around Vercel Sandbox providing a cleaner API.
 */
export class SandboxManager implements Sandbox {
  private sandbox: VercelSandbox;
  private _workingDirectory: string = '/vercel/sandbox';

  constructor(sandbox: VercelSandbox) {
    this.sandbox = sandbox;
  }

  /**
   * Create a new sandbox instance.
   */
  static async create(options: SandboxOptions = {}): Promise<SandboxManager> {
    const timeout = options.timeout ?? DEFAULT_SANDBOX_TIMEOUT;
    const runtime = options.runtime ?? 'node24';

    const sandbox = await VercelSandbox.create({ runtime, timeout });
    return new SandboxManager(sandbox);
  }

  /**
   * Get the sandbox ID.
   */
  get sandboxId(): string {
    return this.sandbox.sandboxId;
  }

  /**
   * Run a command in the sandbox.
   */
  async runCommand(
    command: string,
    args: string[] = [],
    options: { env?: Record<string, string> } = {}
  ): Promise<CommandResult> {
    const result = await this.sandbox.runCommand({
      cmd: command,
      args,
      env: options.env,
    });

    return {
      stdout: await result.stdout(),
      stderr: await result.stderr(),
      exitCode: result.exitCode,
    };
  }

  /**
   * Run a shell command (through bash).
   */
  async runShell(command: string, env?: Record<string, string>): Promise<CommandResult> {
    const result = await this.sandbox.runCommand({
      cmd: 'bash',
      args: ['-c', command],
      env,
    });

    return {
      stdout: await result.stdout(),
      stderr: await result.stderr(),
      exitCode: result.exitCode,
    };
  }

  /**
   * Read a file from the sandbox.
   */
  async readFile(path: string): Promise<string> {
    const result = await this.runCommand('cat', [path]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file ${path}: ${result.stderr}`);
    }
    return result.stdout;
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
        path,
        content: Buffer.from(content, 'utf-8'),
      });
    }

    await this.sandbox.writeFiles(sandboxFiles);
  }

  /**
   * Upload files from local filesystem to sandbox.
   */
  async uploadFiles(files: SandboxFile[]): Promise<void> {
    const sandboxFiles = files.map((f) => ({
      path: f.path,
      content: typeof f.content === 'string' ? Buffer.from(f.content, 'utf-8') : f.content,
    }));

    await this.sandbox.writeFiles(sandboxFiles);
  }

  /**
   * Get the working directory.
   */
  getWorkingDirectory(): string {
    return this._workingDirectory;
  }

  /**
   * Stop and clean up the sandbox.
   */
  async stop(): Promise<void> {
    await this.sandbox.stop();
  }
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
    return DockerSandboxManager.create({
      timeout: options.timeout,
      runtime: options.runtime,
    });
  }

  return SandboxManager.create({
    timeout: options.timeout,
    runtime: options.runtime,
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
    "find . -path './node_modules' -prune -o \\( -name '*.test.tsx' -o -name '*.test.ts' -o -name 'EVAL.ts' \\) -print"
  );

  const foundTests = result.stdout.trim();
  if (foundTests) {
    throw new Error(`Test files found in sandbox before agent run: ${foundTests}`);
  }
}
