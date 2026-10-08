/**
 * Test support: a sandbox that runs on the local machine.
 *
 * Orchestrator tests swap `createSandbox` for this so the real host-side flow
 * (git baseline, install steps, the shipped runner, validation, diff capture)
 * runs end to end without network access or credentials. Each instance owns a
 * fresh temporary directory: commands run there with real `bash`, `git`, and
 * `node`, and file operations resolve against the working directory exactly as
 * the Vercel and Docker sandboxes do.
 *
 * Every command is recorded as the sandbox API received it, so tests can check
 * what crossed the sandbox boundary (for example, that a credential never
 * appeared in argv).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { CommandResult, SandboxBackend, SandboxFile } from '../../sandbox.js';

/** One command as the sandbox received it. */
export interface RecordedCommand {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
}

export interface LocalSandboxOptions {
  backend?: SandboxBackend;
  image?: string;
  username?: string;
  /**
   * Put a user-writable `~/.npm-global/bin` first on PATH, as the Docker
   * sandbox and Vercel's created-user mode do. Lets a test agent shadow tools
   * such as `git`.
   */
  userBinFirst?: boolean;
}

let counter = 0;

export class LocalSandbox {
  readonly root: string;
  readonly sandboxId: string;
  readonly backend: SandboxBackend;
  readonly image: string | undefined;
  readonly username: string | undefined;
  readonly commands: RecordedCommand[] = [];
  stopped = false;
  /** Processes still running; stopping the sandbox kills them, as a real one does. */
  private readonly running = new Set<ChildProcess>();
  private readonly home: string;
  private readonly path: string;
  private cwd: string;

  constructor(options: LocalSandboxOptions = {}) {
    this.root = mkdtempSync(join(tmpdir(), 'agent-eval-local-sandbox-'));
    // prepareNeutralWorkspace relocates (with sudo) any cwd under /vercel/.
    if (this.root.includes('/vercel/')) {
      throw new Error(`LocalSandbox needs a temp dir outside /vercel/, got ${this.root}`);
    }
    this.sandboxId = `local-${++counter}`;
    this.backend = options.backend ?? 'vercel';
    this.image = options.image;
    this.username = options.username;
    this.home = join(this.root, 'home');
    this.cwd = join(this.root, 'workspace');
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.cwd, { recursive: true });
    const hostPath = process.env.PATH ?? '';
    if (options.userBinFirst) {
      const userBin = join(this.home, '.npm-global', 'bin');
      mkdirSync(userBin, { recursive: true });
      this.path = `${userBin}:${hostPath}`;
    } else {
      this.path = hostPath;
    }
  }

  getWorkingDirectory(): string {
    return this.cwd;
  }

  setWorkingDirectory(path: string): void {
    this.cwd = path;
  }

  async runCommand(
    cmd: string,
    args: string[] = [],
    options: { env?: Record<string, string>; cwd?: string } = {}
  ): Promise<CommandResult> {
    if (this.stopped) throw new Error(`sandbox ${this.sandboxId} is stopped`);
    const cwd = options.cwd ?? this.cwd;
    this.commands.push({ cmd, args: [...args], ...(options.env ? { env: { ...options.env } } : {}), cwd });
    // Asynchronous, like the real sandboxes: a command that hangs must not block
    // the host, so host-side timeouts can be tested.
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd,
        // A minimal, isolated environment: the host's PATH for the tools, and a
        // private HOME so neither the host's git config nor its credentials leak in.
        env: { PATH: this.path, HOME: this.home, GIT_CONFIG_NOSYSTEM: '1', ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.running.add(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => {
        this.running.delete(child);
        resolve({ stdout: '', stderr: error.message, exitCode: 127 });
      });
      child.on('close', (code) => {
        this.running.delete(child);
        resolve({
          stdout: Buffer.concat(stdout).toString('utf-8'),
          stderr: Buffer.concat(stderr).toString('utf-8'),
          exitCode: code ?? 1,
        });
      });
    });
  }

  async runShell(script: string, env?: Record<string, string>, cwd?: string): Promise<CommandResult> {
    return this.runCommand('bash', ['-c', script], { env, cwd });
  }

  private resolve(path: string): string {
    return isAbsolute(path) ? path : join(this.cwd, path);
  }

  async readFile(path: string): Promise<string> {
    return readFileSync(this.resolve(path), 'utf-8');
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    return readFileSync(this.resolve(path));
  }

  async fileExists(path: string): Promise<boolean> {
    const full = this.resolve(path);
    return existsSync(full) && statSync(full).isFile();
  }

  async writeFiles(files: Record<string, string>): Promise<void> {
    if (this.stopped) throw new Error(`sandbox ${this.sandboxId} is stopped`);
    for (const [path, content] of Object.entries(files)) {
      const full = this.resolve(path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }

  async uploadFiles(files: SandboxFile[]): Promise<void> {
    if (this.stopped) throw new Error(`sandbox ${this.sandboxId} is stopped`);
    for (const file of files) {
      const full = this.resolve(file.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, file.content);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.killRunning();
  }

  /** Delete the sandbox's directory. Tests call this in cleanup. */
  dispose(): void {
    this.killRunning();
    rmSync(this.root, { recursive: true, force: true });
  }

  private killRunning(): void {
    for (const child of this.running) child.kill('SIGKILL');
    this.running.clear();
  }
}

/**
 * Write an in-sandbox runner for a test agent and return its path. `body` runs
 * with `input` (the AgentRunInput) in scope and must assign `result` fields;
 * the wrapper writes the RunnerResult the orchestrator reads back.
 */
export function writeTestRunner(dir: string, body: string): string {
  const path = join(dir, `run-${++counter}.mjs`);
  writeFileSync(
    path,
    `import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const input = JSON.parse(process.argv[2]);
const result = { ok: true, output: '', transcript: null, observedModel: null, error: null, agentExitCode: 0 };
${body}
mkdirSync(dirname(input.resultPath), { recursive: true });
writeFileSync(input.resultPath, JSON.stringify(result));
`
  );
  return path;
}
