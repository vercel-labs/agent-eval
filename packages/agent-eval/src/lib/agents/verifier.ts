/**
 * Building blocks for grading an agent's work somewhere the agent couldn't touch.
 *
 * With the shared verifier, tests are uploaded into the agent's own sandbox
 * after it finishes, so anything the agent left behind there (a patched
 * `node_modules`, a global binary, a background process, an edited test config)
 * can change what the grader runs. The separate verifier instead captures the
 * agent's file changes as a diff, boots a fresh sandbox, rebuilds the workspace
 * from the original fixture, and applies only those changes, minus protected
 * paths. These helpers do the capture, the protection check, and the apply.
 */

import { minimatch } from 'minimatch';
import type { SandboxManager } from '../sandbox.js';
import { TEST_FILE_PATTERNS } from '../sandbox.js';
import type { DockerSandboxManager } from '../docker-sandbox.js';
import { TRANSCRIPT_CONTEXT_DIR } from './shared.js';
import type { InstallStep } from './plugin/contract.js';

type AnySandbox = SandboxManager | DockerSandboxManager;

/**
 * Paths the separate verifier always protects, on top of `protectedPaths`:
 * the eval's own files wherever they appear, vitest's config and workspace
 * files (which decide what runs and how), the harness's `__agent_eval__`
 * directory, and `node_modules`, which the verifier installs fresh. The agent
 * can only get `node_modules` into its diff by un-ignoring it, which is itself
 * a way to ship a patched test runner.
 */
export const VERIFIER_PROTECTED_PATHS: readonly string[] = [
  ...TEST_FILE_PATTERNS.map((name) => `**/${name}`),
  '**/vitest.config.*',
  '**/vitest.workspace.*',
  `${TRANSCRIPT_CONTEXT_DIR}/**`,
  '**/node_modules/**',
];

/** True when a workspace-relative path matches any of the globs. */
export function createProtectedPathMatcher(patterns: readonly string[]): (path: string) => boolean {
  return (path) => patterns.some((pattern) => minimatch(path, pattern, { dot: true }));
}

/** The agent's file changes relative to the git baseline. */
export interface AgentChanges {
  /** Added or modified files, with their raw bytes. */
  generatedFiles: Record<string, Buffer>;
  /** Deleted files. */
  deletedFiles: string[];
  /** Added or modified files whose mode is executable. */
  executableFiles: string[];
}

/**
 * Capture every change the agent made relative to the git baseline, before
 * anything else is written to the workspace.
 *
 * Like {@link captureGeneratedFiles}, renames are reported as a deletion plus
 * an addition and paths are read NUL-separated so none are lost. Unlike it,
 * this capture has to be replayable: executable modes are kept, so a script
 * the agent made runnable stays runnable, and a failed capture throws instead
 * of quietly returning nothing, since grading an empty diff would record a
 * false failure.
 */
export async function captureAgentChanges(sandbox: AnySandbox): Promise<AgentChanges> {
  const changes: AgentChanges = { generatedFiles: {}, deletedFiles: [], executableFiles: [] };
  const diff = await sandbox.runShell('git add -A . && git diff --cached HEAD --raw --no-renames -z');
  if (diff.exitCode !== 0) {
    throw new Error(`Failed to capture the agent's changes for the verifier:\n${diff.stderr.trim()}`);
  }

  // Each record is ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0".
  const fields = diff.stdout.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i].trim();
    const path = fields[i + 1];
    if (!meta.startsWith(':') || !path) continue;
    const [, newMode, , , status] = meta.slice(1).split(' ');

    if (status === 'D') {
      changes.deletedFiles.push(path);
      continue;
    }
    try {
      changes.generatedFiles[path] = await sandbox.readFileBuffer(path);
    } catch {
      // Not a readable file (a nested repository, a dangling symlink): nothing to replay.
      continue;
    }
    if (newMode === '100755') changes.executableFiles.push(path);
  }
  return changes;
}

/**
 * A private git index, so snapshots never touch the index the agent (and, with
 * the shared verifier, the tests) see.
 */
const SNAPSHOT_INDEX = 'export GIT_INDEX_FILE="$(git rev-parse --git-dir)/agent-eval-snapshot-index"';

/**
 * Record the workspace as it is right before the agent runs and return the git
 * tree id. Install steps run after the git baseline and leave files behind (a
 * lockfile, a CLI config file), so comparing against this snapshot rather than
 * the baseline means tampering only ever reports the agent's own changes.
 */
export async function snapshotWorkspace(sandbox: AnySandbox): Promise<string> {
  const result = await sandbox.runShell(`${SNAPSHOT_INDEX} && git add -A . && git write-tree`);
  const tree = result.stdout.trim();
  if (result.exitCode !== 0 || !tree) {
    throw new Error(`Failed to snapshot the workspace before the agent ran:\n${result.stderr.trim()}`);
  }
  return tree;
}

/** Paths added, modified, or deleted since {@link snapshotWorkspace} returned `tree`. */
export async function pathsChangedSince(sandbox: AnySandbox, tree: string): Promise<string[]> {
  const result = await sandbox.runShell(
    `${SNAPSHOT_INDEX} && git add -A . && git diff --cached --name-only --no-renames -z ${tree}`
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to list the agent's changes:\n${result.stderr.trim()}`);
  }
  return result.stdout.split('\0').filter(Boolean);
}

/** Changed paths that match the protected globs, sorted and de-duplicated. */
export function findTampering(paths: Iterable<string>, isProtected: (path: string) => boolean): string[] {
  return [...new Set([...paths].filter(isProtected))].sort();
}

/**
 * Run a command over many workspace-relative paths without exceeding
 * argument-length limits. Paths are prefixed with `./` so one starting with a
 * dash can't be read as a flag (more portable than `--`).
 */
async function runInBatches(sandbox: AnySandbox, cmd: string, flags: string[], paths: string[]): Promise<void> {
  const BATCH = 200;
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH).map((path) => `./${path}`);
    const result = await sandbox.runCommand(cmd, [...flags, ...batch]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to apply the agent's changes in the verifier (${cmd}):\n${result.stderr.trim()}`);
    }
  }
}

/** Replay the agent's changes into the verifier's workspace, skipping protected paths. */
export async function applyAgentChanges(
  sandbox: AnySandbox,
  changes: AgentChanges,
  isProtected: (path: string) => boolean
): Promise<void> {
  const files = Object.entries(changes.generatedFiles)
    .filter(([path]) => !isProtected(path))
    .map(([path, content]) => ({ path, content }));
  if (files.length > 0) await sandbox.uploadFiles(files);

  const deleted = changes.deletedFiles.filter((path) => !isProtected(path));
  if (deleted.length > 0) await runInBatches(sandbox, 'rm', ['-f'], deleted);

  const executable = changes.executableFiles.filter((path) => !isProtected(path));
  if (executable.length > 0) await runInBatches(sandbox, 'chmod', ['+x'], executable);
}

/**
 * Install steps the separate verifier re-runs for the project's dependencies.
 * Definitions that mark no step with a scope get every step, since there is
 * no way to tell their project install from their CLI install.
 */
export function projectInstallSteps(steps: InstallStep[]): InstallStep[] {
  return steps.some((step) => step.scope) ? steps.filter((step) => step.scope === 'project') : steps;
}

/** Install steps for the agent CLI, for a verifier whose eval uses the judge. */
export function agentInstallSteps(steps: InstallStep[]): InstallStep[] {
  return steps.some((step) => step.scope) ? steps.filter((step) => step.scope !== 'project') : steps;
}

/** Specifier EVAL files use to import the agentic judge matchers. */
const JUDGE_IMPORT = '@vercel/agent-eval/eval';

/**
 * Whether any fixture file imports the judge matchers, in which case the
 * verifier needs the judge agent's CLI installed. EVAL files are checked along
 * with every other fixture file, so a shared test helper that imports the
 * judge counts too.
 */
export function fixtureUsesJudge(files: ReadonlyArray<{ content: Buffer | string }>): boolean {
  return files.some((file) =>
    typeof file.content === 'string' ? file.content.includes(JUDGE_IMPORT) : file.content.includes(JUDGE_IMPORT)
  );
}
