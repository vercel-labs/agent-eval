/**
 * OpenCode CLI agent implementation.
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
  initGitAndCommit,
  injectTranscriptContext,
} from './shared.js';

/** Union type for sandbox implementations */
type AnySandbox = SandboxManager | DockerSandboxManager;

/**
 * Extract transcript from OpenCode JSON output.
 * When run with --format json, OpenCode outputs JSON events to stdout.
 */
function extractTranscriptFromOutput(output: string): string | undefined {
  if (!output || !output.trim()) {
    return undefined;
  }

  // The --format json output contains JSON events, one per line
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
 * Additional provider configuration for models not yet available in the
 * default Vercel AI Gateway (e.g., early access / unreleased models).
 */
export interface OpenCodeProviderConfig {
  npm?: string;
  options?: Record<string, unknown>;
  models?: Record<string, {
    name?: string;
    tool_call?: boolean;
    reasoning?: boolean;
    attachment?: boolean;
    temperature?: boolean;
    limit?: { context: number; output: number };
  }>;
}

/**
 * Generate OpenCode config file content.
 * Configures the Vercel AI Gateway provider, plus any additional providers.
 */
function generateOpenCodeConfig(extraProviders?: Record<string, OpenCodeProviderConfig>, apiKey?: string, timeoutMs?: number): string {
  const vercelBase: Record<string, unknown> = {
    options: {
      apiKey: apiKey || '{env:AI_GATEWAY_API_KEY}',
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    },
  };
  const { vercel: vercelExtra, ...otherProviders } = extraProviders || {};

  const providers: Record<string, unknown> = {
    vercel: {
      ...vercelBase,
      ...vercelExtra,
      options: { ...(vercelBase.options as Record<string, unknown>), ...vercelExtra?.options },
    },
    ...otherProviders,
  };

  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: providers,
    permission: {
      write: 'allow',
      edit: 'allow',
      bash: 'allow',
    },
  }, null, 2);
}

/**
 * Create OpenCode agent with Vercel AI Gateway authentication.
 * Note: OpenCode only supports Vercel AI Gateway, not direct provider APIs.
 */
export function createOpenCodeAgent(): Agent {
  return {
    name: 'vercel-ai-gateway/opencode',
    displayName: 'OpenCode (Vercel AI Gateway)',

    getApiKeyEnvVar(): string {
      return AI_GATEWAY.apiKeyEnvVar;
    },

    getDefaultModel(): ModelTier {
      return 'vercel/anthropic/claude-sonnet-4';
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

        // Install OpenCode CLI
        const binaryUrl = options.agentOptions?.binaryUrl as string | undefined;
        const extraProviders = options.agentOptions?.extraProviders as Record<string, OpenCodeProviderConfig> | undefined;

        if (binaryUrl) {
          // Download custom binary (e.g., patched build for unreleased models)
          const cliInstall = await sandbox.runCommand('bash', [
            '-c',
            `mkdir -p $HOME/.local/bin && curl -fsSL "${binaryUrl}" -o $HOME/.local/bin/opencode && chmod +x $HOME/.local/bin/opencode`,
          ]);
          if (cliInstall.exitCode !== 0) {
            throw new Error(`OpenCode CLI install failed: ${cliInstall.stdout} ${cliInstall.stderr}`);
          }
        } else {
          const cliInstall = await sandbox.runCommand('npm', [
            'install',
            '-g',
            'opencode-ai',
          ]);
          if (cliInstall.exitCode !== 0) {
            throw new Error(`OpenCode CLI install failed: ${cliInstall.stderr}`);
          }
        }

        // Create OpenCode config file in the project directory
        const configContent = generateOpenCodeConfig(extraProviders, options.apiKey, options.timeout);
        await sandbox.writeFiles({
          'opencode.json': configContent,
        });

        // Verify no test files in sandbox
        await verifyNoTestFiles(sandbox);

        // Run OpenCode CLI using run mode for non-interactive execution
        // Use --format json for structured output (transcript)
        const opencodeResult = await sandbox.runCommand(
          'opencode',
          [
            'run',
            options.prompt,
            '--model',
            options.model,
            '--format',
            'json',
          ],
          {
            env: {
              [AI_GATEWAY.apiKeyEnvVar]: options.apiKey,
            },
          }
        );

        agentOutput = opencodeResult.stdout + opencodeResult.stderr;
        transcript = extractTranscriptFromOutput(agentOutput);

        if (opencodeResult.exitCode !== 0) {
          // Extract meaningful error from output (last few lines usually contain the error)
          const errorLines = agentOutput.trim().split('\n').slice(-5).join('\n');
          return {
            success: false,
            output: agentOutput,
            transcript,
            error: errorLines || `OpenCode CLI exited with code ${opencodeResult.exitCode}`,
            duration: Date.now() - startTime,
            sandboxId: sandbox.sandboxId,
          };
        }

        // Upload test files for validation
        await sandbox.uploadFiles(testFiles);

        // Create vitest config for EVAL.ts/tsx
        await createVitestConfig(sandbox);

        // Inject transcript context so EVAL.ts tests can assert on agent behavior
        await injectTranscriptContext(sandbox, transcript, 'vercel-ai-gateway/opencode', options.model);

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
