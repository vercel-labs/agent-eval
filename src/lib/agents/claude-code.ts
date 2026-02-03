/**
 * Claude Code agent implementation.
 * Uses Vercel AI Gateway for model access.
 */

import type { Agent, AgentRunOptions, AgentRunResult } from './types.js';
import type { ModelTier } from '../types.js';
import {
  createSandbox,
  collectLocalFiles,
  splitTestFiles,
  verifyNoTestFiles,
  type SandboxManager,
} from '../sandbox.js';
import type { DockerSandboxManager } from '../docker-sandbox.js';
import {
  runValidation,
  captureGeneratedFiles,
  createVitestConfig,
  AI_GATEWAY,
  ANTHROPIC_DIRECT,
} from './shared.js';

/** Union type for sandbox implementations */
type AnySandbox = SandboxManager | DockerSandboxManager;

/**
 * Capture the Claude Code transcript from the sandbox.
 * Claude Code stores transcripts at ~/.claude/projects/-{workdir}/{session-id}.jsonl
 */
async function captureTranscript(sandbox: AnySandbox): Promise<string | undefined> {
  try {
    // Get the working directory to construct the transcript path
    const workdir = sandbox.getWorkingDirectory();
    // Claude Code uses the path with slashes replaced by dashes
    const projectPath = workdir.replace(/\//g, '-');
    const claudeProjectDir = `~/.claude/projects/${projectPath}`;

    // Find the most recent .jsonl file (the transcript)
    const findResult = await sandbox.runShell(
      `ls -t ${claudeProjectDir}/*.jsonl 2>/dev/null | head -1`
    );

    if (findResult.exitCode !== 0 || !findResult.stdout.trim()) {
      return undefined;
    }

    const transcriptPath = findResult.stdout.trim();
    const content = await sandbox.readFile(transcriptPath);
    return content;
  } catch {
    // Transcript capture is best-effort
    return undefined;
  }
}

/**
 * Create Claude Code agent with specified authentication method.
 */
export function createClaudeCodeAgent({ useVercelAiGateway }: { useVercelAiGateway: boolean }): Agent {
  return {
    name: useVercelAiGateway ? 'vercel-ai-gateway/claude-code' : 'claude-code',
    displayName: useVercelAiGateway ? 'Claude Code (Vercel AI Gateway)' : 'Claude Code',

    getApiKeyEnvVar(): string {
      return useVercelAiGateway ? AI_GATEWAY.apiKeyEnvVar : ANTHROPIC_DIRECT.apiKeyEnvVar;
    },

    getDefaultModel(): ModelTier {
      return 'opus';
    },

    async run(fixturePath: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const startTime = Date.now();
    let sandbox: AnySandbox | null = null;
    let agentOutput = '';
    let aborted = false;
    let sandboxStopped = false;

    // Handle abort signal
    const abortHandler = () => {
      aborted = true;
      if (sandbox && !sandboxStopped) {
        sandboxStopped = true;
        sandbox.stop().catch(() => {});
      }
    };

    if (options.signal) {
      if (options.signal.aborted) {
        return {
          success: false,
          output: '',
          error: 'Aborted before start',
          duration: 0,
        };
      }
      options.signal.addEventListener('abort', abortHandler);
    }

    try {
      // Collect files from fixture
      const allFiles = await collectLocalFiles(fixturePath);
      const { workspaceFiles, testFiles } = splitTestFiles(allFiles);

      // Check for abort before expensive operations
      if (aborted) {
        return {
          success: false,
          output: '',
          error: 'Aborted',
          duration: Date.now() - startTime,
        };
      }

      // Create sandbox
      sandbox = await createSandbox({
        timeout: options.timeout,
        runtime: 'node24',
        backend: options.sandbox,
      });

      // Check for abort after sandbox creation (abort may have fired during create)
      if (aborted) {
        return {
          success: false,
          output: '',
          error: 'Aborted',
          duration: Date.now() - startTime,
          sandboxId: sandbox.sandboxId,
        };
      }

      // Upload workspace files (excluding tests)
      await sandbox.uploadFiles(workspaceFiles);

      // Run setup function if provided
      if (options.setup) {
        await options.setup(sandbox);
      }

      // Install dependencies
      const installResult = await sandbox.runCommand('npm', ['install']);
      if (installResult.exitCode !== 0) {
        throw new Error(`npm install failed: ${installResult.stderr}`);
      }

      // Install Claude Code CLI globally
      const cliInstall = await sandbox.runCommand('npm', [
        'install',
        '-g',
        '@anthropic-ai/claude-code',
      ]);
      if (cliInstall.exitCode !== 0) {
        throw new Error(`Claude Code install failed: ${cliInstall.stderr}`);
      }

      // Verify no test files in sandbox
      await verifyNoTestFiles(sandbox);

      // Run Claude Code with appropriate authentication
      const claudeResult = await sandbox.runCommand(
        'claude',
        ['--print', '--model', options.model, '--dangerously-skip-permissions', options.prompt],
        {
          env: useVercelAiGateway
            ? {
                // AI Gateway configuration for Claude Code
                ANTHROPIC_BASE_URL: AI_GATEWAY.baseUrl,
                ANTHROPIC_AUTH_TOKEN: options.apiKey,
                ANTHROPIC_API_KEY: '',
              }
            : {
                // Direct Anthropic API
                ANTHROPIC_API_KEY: options.apiKey,
              },
        }
      );

      agentOutput = claudeResult.stdout + claudeResult.stderr;

      if (claudeResult.exitCode !== 0) {
        // Extract meaningful error from output (last few lines usually contain the error)
        const errorLines = agentOutput.trim().split('\n').slice(-5).join('\n');
        return {
          success: false,
          output: agentOutput,
          error: errorLines || `Claude Code exited with code ${claudeResult.exitCode}`,
          duration: Date.now() - startTime,
          sandboxId: sandbox.sandboxId,
        };
      }

      // Upload test files for validation
      await sandbox.uploadFiles(testFiles);

      // Create vitest config for EVAL.ts/tsx
      await createVitestConfig(sandbox);

      // Capture the Claude Code transcript
      const transcript = await captureTranscript(sandbox);

      // Run validation scripts
      const validationResults = await runValidation(sandbox, options.scripts ?? []);

      // Capture generated files
      const generatedFiles = await captureGeneratedFiles(sandbox);

      return {
        success: validationResults.allPassed,
        output: agentOutput,
        transcript,
        duration: Date.now() - startTime,
        testResult: validationResults.test,
        scriptsResults: validationResults.scripts,
        sandboxId: sandbox.sandboxId,
        generatedFiles,
      };
    } catch (error) {
      // Check if this was an abort
      if (aborted) {
        return {
          success: false,
          output: agentOutput,
          error: 'Aborted',
          duration: Date.now() - startTime,
          sandboxId: sandbox?.sandboxId,
        };
      }
      return {
        success: false,
        output: agentOutput,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
        sandboxId: sandbox?.sandboxId,
      };
    } finally {
      // Clean up abort listener
      if (options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      if (sandbox && !sandboxStopped) {
        sandboxStopped = true;
        await sandbox.stop();
      }
    }
  },
};
}
