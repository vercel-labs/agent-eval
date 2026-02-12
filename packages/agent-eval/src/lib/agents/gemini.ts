/**
 * Gemini CLI agent implementation.
 * Uses direct Google Gemini API access.
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
  GEMINI_DIRECT,
  initGitAndCommit,
} from './shared.js';

/** Union type for sandbox implementations */
type AnySandbox = SandboxManager | DockerSandboxManager;

/**
 * Extract transcript from Gemini stream-json output.
 * When run with --output-format stream-json, Gemini outputs JSONL (newline-delimited JSON).
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
 * Create Gemini CLI agent with direct API authentication.
 */
export function createGeminiAgent(): Agent {
  return {
    name: 'gemini',
    displayName: 'Gemini CLI',

    getApiKeyEnvVar(): string {
      return GEMINI_DIRECT.apiKeyEnvVar;
    },

    getDefaultModel(): ModelTier {
      return 'gemini-3-pro-preview';
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

        // Install Gemini CLI globally
        const cliInstall = await sandbox.runCommand('npm', [
          'install',
          '-g',
          '@google/gemini-cli',
        ]);
        if (cliInstall.exitCode !== 0) {
          throw new Error(`Gemini CLI install failed: ${cliInstall.stderr}`);
        }

        // Verify no test files in sandbox
        await verifyNoTestFiles(sandbox);

        // Run Gemini CLI with direct API access
        // Using stream-json format for detailed event transcript (similar to Codex's --json)
        const geminiResult = await sandbox.runCommand(
          'gemini',
          [
            '--prompt',
            options.prompt,
            '--model',
            options.model,
            '--approval-mode',
            'yolo',
            '--output-format',
            'stream-json',
          ],
          {
            env: {
              [GEMINI_DIRECT.apiKeyEnvVar]: options.apiKey,
            },
          }
        );

        agentOutput = geminiResult.stdout + geminiResult.stderr;

        if (geminiResult.exitCode !== 0) {
          // Extract meaningful error from output (last few lines usually contain the error)
          const errorLines = agentOutput.trim().split('\n').slice(-5).join('\n');
          return {
            success: false,
            output: agentOutput,
            error: errorLines || `Gemini CLI exited with code ${geminiResult.exitCode}`,
            duration: Date.now() - startTime,
            sandboxId: sandbox.sandboxId,
          };
        }

        // Upload test files for validation
        await sandbox.uploadFiles(testFiles);

        // Create vitest config for EVAL.ts/tsx
        await createVitestConfig(sandbox);

        // Extract transcript from the Gemini stream-json output (JSONL format)
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
