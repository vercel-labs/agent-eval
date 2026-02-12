/**
 * Cursor CLI agent implementation.
 * Uses direct Cursor API access.
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
  CURSOR_DIRECT,
  initGitAndCommit,
} from './shared.js';

/** Union type for sandbox implementations */
type AnySandbox = SandboxManager | DockerSandboxManager;

/**
 * Extract transcript from Cursor CLI stream-json output.
 * When run with --output-format stream-json, Cursor outputs JSONL (newline-delimited JSON).
 */
function extractTranscriptFromOutput(output: string): string | undefined {
  if (!output || !output.trim()) {
    return undefined;
  }

  // The --output-format stream-json output contains JSON events, one per line
  // Filter to only include lines that look like JSON objects
  const lines = output.split('\n').filter(line => {
    const trimmed = line.trim();
    return trimmed.startsWith('{') && trimmed.endsWith('}');
  });

  if (lines.length === 0) {
    return undefined;
  }

  return lines.join('\n');
}

/**
 * Create Cursor CLI agent with direct API authentication.
 */
export function createCursorAgent(): Agent {
  return {
    name: 'cursor',
    displayName: 'Cursor CLI',

    getApiKeyEnvVar(): string {
      return CURSOR_DIRECT.apiKeyEnvVar;
    },

    getDefaultModel(): ModelTier {
      return 'composer-1.5';
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

        // Install Cursor CLI globally using official installation script
        const cliInstall = await sandbox.runShell(
          'curl https://cursor.com/install -fsSL | bash'
        );
        if (cliInstall.exitCode !== 0) {
          throw new Error(`Cursor CLI install failed: ${cliInstall.stderr}`);
        }

        // Verify no test files in sandbox
        await verifyNoTestFiles(sandbox);

        // Run Cursor CLI with direct API access
        // --print: non-interactive mode (required for scripts/headless)
        // --force: auto-approve all tool operations
        // --output-format stream-json: structured JSONL transcript (only works with --print)
        const cursorResult = await sandbox.runCommand(
          'agent',
          [
            options.prompt,
            '--print',
            '--force',
            '--model',
            options.model,
            '--output-format',
            'stream-json',
          ],
          {
            env: {
              [CURSOR_DIRECT.apiKeyEnvVar]: options.apiKey,
            },
          }
        );

        agentOutput = cursorResult.stdout + cursorResult.stderr;

        if (cursorResult.exitCode !== 0) {
          // Extract meaningful error from output (last few lines usually contain the error)
          const errorLines = agentOutput.trim().split('\n').slice(-5).join('\n');
          return {
            success: false,
            output: agentOutput,
            error: errorLines || `Cursor CLI exited with code ${cursorResult.exitCode}`,
            duration: Date.now() - startTime,
            sandboxId: sandbox.sandboxId,
          };
        }

        // Upload test files for validation
        await sandbox.uploadFiles(testFiles);

        // Create vitest config for EVAL.ts/tsx
        await createVitestConfig(sandbox);

        // Extract transcript from Cursor output
        const transcript = extractTranscriptFromOutput(agentOutput);

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
