/**
 * Shared utilities for agent implementations.
 */

import type { ScriptResult } from './types.js';
import type { SandboxManager } from '../sandbox.js';
import type { DockerSandboxManager } from '../docker-sandbox.js';
import { parseTranscript } from '../o11y/index.js';
import type { ValidationMode } from '../types.js';

/** Union type for sandbox implementations */
type AnySandbox = SandboxManager | DockerSandboxManager;

/**
 * Well-known directory where transcript context is written inside the sandbox.
 * EVAL.ts tests can read `__agent_eval__/results.json` to assert on agent behavior
 * (e.g. which shell commands were run, files modified, tool calls made).
 */
export const TRANSCRIPT_CONTEXT_DIR = '__agent_eval__';

/** Path to the results file inside the sandbox. */
export const TRANSCRIPT_CONTEXT_PATH = `${TRANSCRIPT_CONTEXT_DIR}/results.json`;

// ── Agentic-judge runtime, shipped into the sandbox before validation ──────────
// These paths are mirrored as literals in eval-helper.mjs (a zero-dep file that
// cannot import this module). Keep the two in sync.

/** The in-sandbox eval helper, aliased to `@vercel/agent-eval/eval` for EVAL.ts. */
export const EVAL_HELPER_PATH = `${TRANSCRIPT_CONTEXT_DIR}/eval-helper.mjs`;

/** Raw transcript materialized as a file so the judge agent can read it by path. */
export const JUDGE_TRANSCRIPT_FILE = `${TRANSCRIPT_CONTEXT_DIR}/transcript.txt`;

/** Judge config (`{ runnerPath, model, extra }`) read by eval-helper.mjs. */
export const JUDGE_CONFIG_PATH = `${TRANSCRIPT_CONTEXT_DIR}/judge-config.json`;

/** The judge agent's runner, shipped separately ONLY when the judge agent differs
 * from the codegen agent. When they match, the judge reuses the codegen run.mjs. */
export const JUDGE_RUNNER_PATH = `${TRANSCRIPT_CONTEXT_DIR}/judge-run.mjs`;

/**
 * Resolve an agent's API key from the host env. Single source of truth shared by
 * the CLI (codegen agent) and the orchestrator (a pinned judge agent): the agent's
 * own key env var, falling back to VERCEL_OIDC_TOKEN — which authenticates both the
 * Vercel Sandbox and the AI Gateway. Returns undefined when neither is set.
 */
export function resolveAgentApiKey(getApiKeyEnvVar: () => string): string | undefined {
  return process.env[getApiKeyEnvVar()] ?? process.env.VERCEL_OIDC_TOKEN;
}

/**
 * Combined validation results.
 */
export interface ValidationResults {
  allPassed: boolean;
  test?: ScriptResult;
  scripts: Record<string, ScriptResult>;
}

export interface NeutralWorkspace {
  cwd: string;
  env: Record<string, string>;
}

/**
 * Detect which eval file exists in the sandbox (EVAL.ts or EVAL.tsx).
 * Case-sensitive: Only matches exact uppercase filenames.
 * Returns the filename if found, or 'EVAL.ts' as fallback.
 */
async function detectEvalFile(sandbox: AnySandbox): Promise<string> {
  try {
    // List files in current directory and check for exact case match
    const lsResult = await sandbox.runShell('ls -1');
    if (lsResult.exitCode === 0) {
      const files = lsResult.stdout.split('\n').map((f) => f.trim());

      // Check for EVAL.tsx first (prefer JSX if both exist)
      if (files.includes('EVAL.tsx')) {
        return 'EVAL.tsx';
      }

      // Check for EVAL.ts
      if (files.includes('EVAL.ts')) {
        return 'EVAL.ts';
      }
    }
  } catch {
    // Ignore errors
  }

  // Default to EVAL.ts (will fail later if it doesn't exist)
  return 'EVAL.ts';
}

/**
 * Version installed when the workspace has no vitest of its own. Only a floor:
 * anything recent satisfies the generated config, which uses nothing but
 * `defineConfig`.
 */
export const FALLBACK_VITEST_VERSION = '^3';

/**
 * Guarantee the validation runner is resolvable from the workspace.
 *
 * Validation shells out to `npx vitest`, and the generated vitest.config.ts
 * imports `vitest/config`, which Node resolves from the workspace. Fixtures
 * normally supply vitest as a devDependency, but package.json belongs to the agent
 * for the length of the run. An agent scaffolding into an empty directory often
 * replaces that file outright rather than editing it, and its next `npm install`
 * prunes vitest. npx then downloads vitest into its own cache, which does not
 * satisfy the config's import, and the run dies at startup with "Cannot find
 * module 'vitest/config'".
 *
 * That failure is indistinguishable from a bad result: the eval never executes, so
 * the harness records a red for work it never graded. Installing vitest when it is
 * missing keeps a fixture gradeable no matter what the agent did to the manifest.
 *
 * Nothing about this repair may show up as the agent's work: it runs before the
 * git diff is captured, so `--no-save` keeps it out of package.json and
 * `--no-package-lock` keeps it out of the lockfile, which is not gitignored and
 * would otherwise be recorded as a file the agent wrote.
 */
export async function ensureValidationRunner(sandbox: AnySandbox): Promise<void> {
  const present = await sandbox.runShell('test -e node_modules/vitest/package.json');
  if (present.exitCode === 0) {
    return;
  }

  await sandbox.runCommand('npm', [
    'install',
    '--no-save',
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
    `vitest@${FALLBACK_VITEST_VERSION}`,
  ]);
}

/**
 * Run validation scripts in the sandbox.
 */
export async function runValidation(
  sandbox: AnySandbox,
  scripts: string[],
  validation: ValidationMode = 'vitest',
  // Auth/neutral env for the eval process. EVAL.ts judge matchers re-invoke the
  // agent CLI in-sandbox, which needs the same credentials the codegen run used —
  // so the vitest process must carry them (it inherits them to its child spawns).
  env?: Record<string, string>
): Promise<ValidationResults> {
  const results: ValidationResults = {
    allPassed: true,
    scripts: {},
  };

  if (validation === 'vitest') {
    // Detect which eval file exists (EVAL.ts or EVAL.tsx)
    const evalFile = await detectEvalFile(sandbox);

    // The agent may have removed vitest from the project; put it back first.
    await ensureValidationRunner(sandbox);

    // Always run vitest for the eval file (explicitly specify the file)
    const testResult = await sandbox.runCommand('npx', ['vitest', 'run', evalFile], env ? { env } : undefined);
    results.test = {
      success: testResult.exitCode === 0,
      output: testResult.stdout + testResult.stderr,
    };
    if (!results.test.success) {
      results.allPassed = false;
    }
  }

  // Run configured scripts
  for (const script of scripts) {
    const scriptResult = await sandbox.runCommand('npm', ['run', script]);
    const result: ScriptResult = {
      success: scriptResult.exitCode === 0,
      output: scriptResult.stdout + scriptResult.stderr,
    };

    results.scripts[script] = result;

    if (!result.success) {
      results.allPassed = false;
    }
  }

  return results;
}

export async function prepareNeutralWorkspace(sandbox: AnySandbox): Promise<NeutralWorkspace> {
  const neutralEnv = { USER: 'user', LOGNAME: 'user' };
  const currentWorkingDirectory = sandbox.getWorkingDirectory();

  await sandbox.runShell('git remote remove origin 2>/dev/null || true; rm -rf .git/logs');

  if (!currentWorkingDirectory.includes('/vercel/')) {
    return { cwd: currentWorkingDirectory, env: neutralEnv };
  }

  const neutralWorkspacePath = '/workspace';
  const copyResult = await sandbox.runShell(
    [
      `sudo rm -rf ${neutralWorkspacePath}`,
      `sudo mkdir -p ${neutralWorkspacePath}`,
      `sudo cp -a . ${neutralWorkspacePath}/`,
      `sudo chown -R "$(id -u):$(id -g)" ${neutralWorkspacePath}`,
    ].join(' && ')
  );
  if (copyResult.exitCode !== 0) {
    const output = (copyResult.stdout + copyResult.stderr).trim().split('\n').slice(-10).join('\n');
    throw new Error(`Failed to prepare neutral workspace:\n${output}`);
  }

  sandbox.setWorkingDirectory(neutralWorkspacePath);
  return { cwd: neutralWorkspacePath, env: neutralEnv };
}

export async function initGitAndCommit(sandbox: AnySandbox): Promise<void> {
  await sandbox.writeFiles({
    // `__agent_eval__/` holds framework scaffolding only (the runner, transcript,
    // judge I/O) — never agent output — so keep it out of the captured git diff.
    ".gitignore": "node_modules/\n__agent_eval__/\n",
  });

  // init a git repo and set user and name since those are needed. Commit everything to have a clean diff with HEAD to capture
  // the generated files
  await sandbox.runShell(
    'git init && git config user.email "agent-eval@localhost" && git config user.name "agent-eval" && git add . && git commit -m "init"'
  );
}

/**
 * Capture source files generated by the agent.
 * Returns both modified/added files (with content) and deleted file paths.
 */
export async function captureGeneratedFiles(
  sandbox: AnySandbox
): Promise<{ generatedFiles: Record<string, Buffer>; deletedFiles: string[] }> {
  const generatedFiles: Record<string, Buffer> = {};
  const deletedFiles: string[] = [];

  try {
    // Use --name-status to distinguish added/modified from deleted
    const findResult = await sandbox.runShell("git add . && git diff HEAD --name-status");

    const lines = findResult.stdout
      .trim()
      .split('\n')
      .filter(Boolean);

    for (const line of lines) {
      const [status, ...rest] = line.split('\t');
      const filePath = rest.join('\t');

      if (!filePath) continue;

      if (status === 'D') {
        deletedFiles.push(filePath);
      } else {
        try {
          // Bytes, not a string: `readFile` decodes stdout as UTF-8 and would
          // replace every non-UTF-8 byte with U+FFFD, corrupting every binary
          // file in the agent's diff. Text is unaffected — results.ts writes
          // the buffer straight back to disk.
          const content = await sandbox.readFileBuffer(filePath);
          generatedFiles[filePath] = content;
        } catch {
          // Skip unreadable files
        }
      }
    }
  } catch {
    // If capture fails, return empty results
  }

  return { generatedFiles, deletedFiles };
}

/**
 * Create vitest config for running EVAL.ts or EVAL.tsx.
 */
export async function createVitestConfig(sandbox: AnySandbox): Promise<void> {
  // Detect which eval file exists
  const evalFile = await detectEvalFile(sandbox);

  // Absolute path to the shipped eval helper. It is BOTH the source of the
  // `environment`/`transcript` exports (aliased to `@vercel/agent-eval/eval`) and
  // the setup file that registers the judge matchers via expect.extend.
  const helperPath = `${sandbox.getWorkingDirectory()}/${EVAL_HELPER_PATH}`;

  await sandbox.writeFiles({
    'vitest.config.ts': `
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['${evalFile}'],
    globals: false,
    // Agentic judge matchers spawn a full agent run in-sandbox; give them room.
    // The sandbox-level timeout is the real bound.
    testTimeout: 900000,
    hookTimeout: 900000,
    setupFiles: ['${helperPath}'],
  },
  resolve: {
    alias: { '@vercel/agent-eval/eval': '${helperPath}' },
  },
});
`,
  });
}

/**
 * Inject transcript context into the sandbox so EVAL.ts tests can assert on agent behavior.
 * Writes parsed transcript summary to `__agent_eval__/results.json`.
 *
 * This is best-effort: failures are silently ignored since it's supplementary data.
 */
export async function injectTranscriptContext(
  sandbox: AnySandbox,
  rawTranscript: string | undefined,
  agentName: string,
  model?: string,
): Promise<void> {
  try {
    const transcript = rawTranscript
      ? parseTranscript(rawTranscript, agentName, model)
      : null;

    const context = {
      o11y: transcript?.summary ?? null,
    };

    await sandbox.writeFiles({
      [TRANSCRIPT_CONTEXT_PATH]: JSON.stringify(context, null, 2),
    });
  } catch {
    // Best-effort: don't fail the eval if context injection fails
  }
}

/**
 * AI Gateway configuration.
 */
export const AI_GATEWAY = {
  baseUrl: 'https://ai-gateway.vercel.sh',
  openAiBaseUrl: 'https://ai-gateway.vercel.sh/v1',
  apiKeyEnvVar: 'AI_GATEWAY_API_KEY',
} as const;

/**
 * Direct API configuration for Anthropic.
 */
export const ANTHROPIC_DIRECT = {
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
} as const;

/**
 * Direct API configuration for OpenAI.
 */
export const OPENAI_DIRECT = {
  baseUrl: 'https://api.openai.com/v1',
  apiKeyEnvVar: 'OPENAI_API_KEY',
} as const;

/**
 * Direct API configuration for Google Gemini.
 */
export const GEMINI_DIRECT = {
  apiKeyEnvVar: 'GEMINI_API_KEY',
} as const;

/**
 * Direct API configuration for Cursor.
 */
export const CURSOR_DIRECT = {
  apiKeyEnvVar: 'CURSOR_API_KEY',
} as const;
