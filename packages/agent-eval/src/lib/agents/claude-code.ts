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
  initGitAndCommit,
  injectTranscriptContext,
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
    return content || undefined;
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
      if (useVercelAiGateway) return AI_GATEWAY.apiKeyEnvVar;
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN';
      return ANTHROPIC_DIRECT.apiKeyEnvVar;
    },

    getDefaultModel(): ModelTier {
      return 'opus';
    },

    async run(fixturePath: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const startTime = Date.now();
    let sandbox: AnySandbox | null = null;
    let agentOutput = '';
    let transcript: string | undefined;
    let aborted = false;
    let sandboxStopped = false;
    let hasReturned = false;

    const captureTranscriptBestEffort = async () => {
      if (!sandbox || sandboxStopped || transcript) return;
      transcript = await captureTranscript(sandbox);
    };

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
          hasReturned = true;
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
        hasReturned = true;
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
        hasReturned = true;
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
	  
	  await initGitAndCommit(sandbox);

      // Run setup function if provided
      if (options.setup) {
        await options.setup(sandbox);
      }

      // Install dependencies
      let installResult = await sandbox.runCommand('npm', ['install']);
      if (installResult.exitCode !== 0) {
        installResult = await sandbox.runCommand('npm', ['install']);
      }
      if (installResult.exitCode !== 0) {
        const output = (installResult.stdout + installResult.stderr).trim().split('\n').slice(-10).join('\n');
        throw new Error(`npm install failed (exit code ${installResult.exitCode}):\n${output}`);
      }

      // Install Claude Code CLI globally
      const cliPackage = (options.agentOptions?.cliPackage as string) || '@anthropic-ai/claude-code';
      const cliInstall = await sandbox.runCommand('npm', [
        'install',
        '-g',
        cliPackage,
      ]);
      if (cliInstall.exitCode !== 0) {
        throw new Error(`Claude Code install failed: ${cliInstall.stderr}`);
      }

      // Verify no test files in sandbox
      await verifyNoTestFiles(sandbox);

      // Build sandbox environment based on authentication method.
      // Note: options.apiKey is always resolved from process.env[getApiKeyEnvVar()]
      // by the CLI (cli.ts), so the env-var check here is consistent with getApiKeyEnvVar().
      let claudeEnv: Record<string, string>;
      if (useVercelAiGateway) {
        claudeEnv = {
          ANTHROPIC_BASE_URL: AI_GATEWAY.baseUrl,
          ANTHROPIC_AUTH_TOKEN: options.apiKey,
          ANTHROPIC_API_KEY: '',
        };
      } else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        claudeEnv = {
          CLAUDE_CODE_OAUTH_TOKEN: options.apiKey,
        };
      } else {
        claudeEnv = {
          ANTHROPIC_API_KEY: options.apiKey,
        };
      }

      // Build CLI arguments
      const cliArgs = ['--print', '--model', options.model, '--dangerously-skip-permissions'];
      const effort = options.agentOptions?.effort as string | undefined;
      if (effort) {
        cliArgs.push('--effort', effort);
      }
      cliArgs.push(options.prompt);

      // Run Claude Code with appropriate authentication
      const claudeResult = await sandbox.runCommand(
        'claude',
        cliArgs,
        {
          env: claudeEnv,
        }
      );

      agentOutput = claudeResult.stdout + claudeResult.stderr;

      if (claudeResult.exitCode !== 0) {
        await captureTranscriptBestEffort();
        // Extract meaningful error from output (last few lines usually contain the error)
        const errorLines = agentOutput.trim().split('\n').slice(-5).join('\n');
        hasReturned = true;
        return {
          success: false,
          output: agentOutput,
          transcript,
          error: errorLines || `Claude Code exited with code ${claudeResult.exitCode}`,
          duration: Date.now() - startTime,
          sandboxId: sandbox.sandboxId,
        };
      }

      // Upload test files for validation
      await sandbox.uploadFiles(testFiles);

      // Create vitest config for EVAL.ts/tsx
      await createVitestConfig(sandbox);

      // Capture transcript before validation when available
      await captureTranscriptBestEffort();

      // Inject transcript context so EVAL.ts tests can assert on agent behavior
      await injectTranscriptContext(sandbox, transcript, 'claude-code', options.model);

      // Run validation scripts
      const validationResults = await runValidation(sandbox, options.scripts ?? []);

      // Capture generated files
      const { generatedFiles, deletedFiles } = await captureGeneratedFiles(sandbox);

      hasReturned = true;
      return {
        success: validationResults.allPassed,
        output: agentOutput,
        transcript,
        duration: Date.now() - startTime,
        testResult: validationResults.test,
        scriptsResults: validationResults.scripts,
        sandboxId: sandbox.sandboxId,
        generatedFiles,
        deletedFiles,
      };
    } catch (error) {
      await captureTranscriptBestEffort();
      // Check if this was an abort
      if (aborted) {
        hasReturned = true;
        return {
          success: false,
          output: agentOutput,
          transcript,
          error: 'Aborted',
          duration: Date.now() - startTime,
          sandboxId: sandbox?.sandboxId,
        };
      }
      hasReturned = true;
      return {
        success: false,
        output: agentOutput,
        transcript,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
        sandboxId: sandbox?.sandboxId,
      };
    } finally {
      // If we're about to return and sandbox is still up, try one final transcript capture.
      if (hasReturned) {
        await captureTranscriptBestEffort();
      }
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
