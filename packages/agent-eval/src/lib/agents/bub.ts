/**
 * Bub agent implementation.
 * Uses direct Bub CLI access.
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
  BUB_DIRECT,
  initGitAndCommit,
  injectTranscriptContext,
} from './shared.js';

/** Union type for sandbox implementations */
type AnySandbox = SandboxManager | DockerSandboxManager;

/**
 * Shell-escape a string for single-quoted bash usage.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Extract transcript from Bub tapes.
 * Bub persists session tapes under $BUB_HOME/tapes/<session>.jsonl.
 */
async function captureTranscript(sandbox: AnySandbox, bubHome: string): Promise<string | undefined> {
  try {
    const findResult = await sandbox.runShell(
      `ls -t ${shellQuote(`${bubHome}/tapes`)}/*.jsonl 2>/dev/null | head -1`
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
 * Create Bub agent.
 */
export function createBubAgent(): Agent {
  return {
    name: 'bub',
    displayName: 'Bub',

    getApiKeyEnvVar(): string {
      return BUB_DIRECT.apiKeyEnvVar;
    },

    getDefaultModel(): ModelTier {
      return 'openrouter:qwen/qwen3-coder-next';
    },

    async run(fixturePath: string, options: AgentRunOptions): Promise<AgentRunResult> {
      const startTime = Date.now();
      let sandbox: AnySandbox | null = null;
      let agentOutput = '';
      let transcript: string | undefined;
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

        // Check for abort after sandbox creation
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

        await initGitAndCommit(sandbox);

        // Run setup function if provided
        if (options.setup) {
          await options.setup(sandbox);
        }

        // Install fixture dependencies so Bub operates in a realistic workspace.
        let installResult = await sandbox.runCommand('npm', ['install']);
        if (installResult.exitCode !== 0) {
          installResult = await sandbox.runCommand('npm', ['install']);
        }
        if (installResult.exitCode !== 0) {
          const output = (installResult.stdout + installResult.stderr).trim().split('\n').slice(-10).join('\n');
          throw new Error(`npm install failed (exit code ${installResult.exitCode}):\n${output}`);
        }

        // Install uv and Bub CLI as a tool, similar to a standalone binary install.
        const bubInstall = await sandbox.runShell(
          [
            'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"',
            'curl -LsSf https://astral.sh/uv/install.sh | sh',
            'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"',
            'uv tool install --from git+https://github.com/bubbuild/bub.git bub',
          ].join(' && ')
        );
        if (bubInstall.exitCode !== 0) {
          throw new Error(`Bub install failed: ${bubInstall.stderr}`);
        }

        // Verify no test files in sandbox
        await verifyNoTestFiles(sandbox);

        const bubbleHome = `${sandbox.getWorkingDirectory()}/.bub`;
        const env: Record<string, string> = {
          [BUB_DIRECT.apiKeyEnvVar]: options.apiKey,
          BUB_HOME: bubbleHome,
          BUB_MODEL: options.model,
          BUB_RUNTIME_ENABLED: '1',
        };

        if (options.model.startsWith('openrouter:')) {
          env.OPENROUTER_API_KEY = options.apiKey;
        }

        // Run Bub with the prompt
        const bubResult = await sandbox.runShell(
          [
            'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"',
            `bub --workspace ${shellQuote(sandbox.getWorkingDirectory())} run ${shellQuote(options.prompt)}`,
          ].join(' && '),
          env
        );

        agentOutput = bubResult.stdout + bubResult.stderr;

        // Capture transcript after Bub runs
        transcript = await captureTranscript(sandbox, bubbleHome);

        if (bubResult.exitCode !== 0) {
          // Extract meaningful error from output
          const errorLines = agentOutput.trim().split('\n').slice(-5).join('\n');
          return {
            success: false,
            output: agentOutput,
            transcript,
            error: errorLines || `Bub exited with code ${bubResult.exitCode}`,
            duration: Date.now() - startTime,
            sandboxId: sandbox.sandboxId,
          };
        }

        // Upload test files for validation
        await sandbox.uploadFiles(testFiles);

        // Create vitest config for EVAL.ts/tsx
        await createVitestConfig(sandbox);

        // Inject transcript context so EVAL.ts tests can assert on agent behavior
        await injectTranscriptContext(sandbox, transcript, 'bub', options.model);

        // Run validation scripts
        const validationResults = await runValidation(sandbox, options.scripts ?? []);

        // Capture generated files
        const { generatedFiles, deletedFiles } = await captureGeneratedFiles(sandbox);

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
        // Check if this was an abort
        if (aborted) {
          return {
            success: false,
            output: agentOutput,
            transcript,
            error: 'Aborted',
            duration: Date.now() - startTime,
            sandboxId: sandbox?.sandboxId,
          };
        }
        return {
          success: false,
          output: agentOutput,
          transcript,
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
