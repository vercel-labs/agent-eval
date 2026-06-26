/**
 * Shared utilities for agent implementations.
 */

import type { ScriptResult } from './types.js';
import type { SandboxManager } from '../sandbox.js';
import type { DockerSandboxManager } from '../docker-sandbox.js';
import { parseTranscript } from '../o11y/index.js';
import type { ValidationMode } from '../types.js';
import {
  getJudgeRuntimeSource,
  resolveJudgeEnv,
  TRANSCRIPT_EVENTS_PATH,
  JUDGE_RUNTIME_PATH,
} from '../judge.js';

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
 * Run validation scripts in the sandbox.
 */
export async function runValidation(
  sandbox: AnySandbox,
  scripts: string[],
  validation: ValidationMode = 'vitest'
): Promise<ValidationResults> {
  const results: ValidationResults = {
    allPassed: true,
    scripts: {},
  };

  if (validation === 'vitest') {
    // Detect which eval file exists (EVAL.ts or EVAL.tsx)
    const evalFile = await detectEvalFile(sandbox);

    // Always run vitest for the eval file (explicitly specify the file).
    // Forward gateway creds + judge model so in-eval `toSatisfyCriterion` LLM
    // assertions can reach the model. Env is merged by the sandbox, not replaced,
    // so PATH/etc. are preserved; when no gateway credential is present we pass no
    // env and judge-based assertions are simply unavailable.
    const judgeEnv = resolveJudgeEnv();
    const testResult = await sandbox.runCommand(
      'npx',
      ['vitest', 'run', evalFile],
      judgeEnv ? { env: judgeEnv } : {}
    );
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
    ".gitignore": "node_modules/\n",
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
): Promise<{ generatedFiles: Record<string, string>; deletedFiles: string[] }> {
  const generatedFiles: Record<string, string> = {};
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
          const content = await sandbox.readFile(filePath);
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

  await sandbox.writeFiles({
    'vitest.config.ts': `
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['${evalFile}'],
    globals: false,
    // LLM-judge assertions call a model (and codebase() may run a multi-turn
    // explorer or agent CLI), so the 5s default is far too low.
    testTimeout: 120000,
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
      // Full normalized transcript for LLM-judge assertions (toSatisfyCriterion).
      [TRANSCRIPT_EVENTS_PATH]: JSON.stringify({ events: transcript?.events ?? [] }),
      // Zero-dep judge runtime EVAL.ts can import (registers the matcher + helpers).
      [JUDGE_RUNTIME_PATH]: getJudgeRuntimeSource(),
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
