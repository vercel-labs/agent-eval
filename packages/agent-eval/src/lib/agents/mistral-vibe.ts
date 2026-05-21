/**
 * Mistral Vibe CLI agent implementation.
 * Uses direct Mistral API access.
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
  MISTRAL_DIRECT,
  initGitAndCommit,
  injectTranscriptContext,
  prepareNeutralWorkspace,
} from './shared.js';

/** Union type for sandbox implementations */
type AnySandbox = SandboxManager | DockerSandboxManager;

/**
 * Extract transcript from Mistral Vibe streaming JSON output.
 * When run with --output streaming, Vibe emits one OpenAI-compat LLMMessage per line.
 */
function extractTranscriptFromOutput(output: string): string | undefined {
  if (!output || !output.trim()) {
    return undefined;
  }

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
 * Create Mistral Vibe CLI agent with direct API authentication.
 */
export function createMistralVibeAgent(): Agent {
  return {
    name: 'mistral-vibe',
    displayName: 'Mistral Vibe CLI',

    getApiKeyEnvVar(): string {
      return MISTRAL_DIRECT.apiKeyEnvVar;
    },

    getDefaultModel(): ModelTier {
      return 'mistral-medium-3.5';
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
        const neutralWorkspace = await prepareNeutralWorkspace(sandbox);

        // Install dependencies
        let installResult = await sandbox.runCommand('npm', ['install']);
        if (installResult.exitCode !== 0) {
          installResult = await sandbox.runCommand('npm', ['install']);
        }
        if (installResult.exitCode !== 0) {
          const output = (installResult.stdout + installResult.stderr).trim().split('\n').slice(-10).join('\n');
          throw new Error(`npm install failed (exit code ${installResult.exitCode}):\n${output}`);
        }

        // Install Mistral Vibe CLI via uv (downloads Python 3.12 if needed).
        // uv installs to $HOME/.local/bin; we prepend it to PATH in every later runShell.
        // Fetch the uv tarball directly via Node — node:*-slim images have no curl/wget,
        // and upstream's install.sh shells out to curl, so we bypass it entirely.
        const cliInstall = await sandbox.runShell(
          [
            'set -e',
            'mkdir -p "$HOME/.local/bin"',
            `node -e "const fs=require('fs');const arch=process.arch==='arm64'?'aarch64':'x86_64';fetch('https://github.com/astral-sh/uv/releases/latest/download/uv-'+arch+'-unknown-linux-gnu.tar.gz').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.arrayBuffer()}).then(b=>fs.writeFileSync('/tmp/uv.tar.gz',Buffer.from(b)))"`,
            'tar -xzf /tmp/uv.tar.gz --strip-components=1 -C "$HOME/.local/bin"',
            'export PATH="$HOME/.local/bin:$PATH"',
            'uv tool install mistral-vibe',
            'vibe --version',
          ].join(' && ')
        );
        if (cliInstall.exitCode !== 0) {
          const output = (cliInstall.stdout + cliInstall.stderr).trim().split('\n').slice(-10).join('\n');
          throw new Error(`Mistral Vibe CLI install failed (exit code ${cliInstall.exitCode}):\n${output}`);
        }

        // Verify no test files in sandbox
        await verifyNoTestFiles(sandbox);

        // Run Mistral Vibe in programmatic mode.
        // --prompt <text>: programmatic mode (auto-selects auto-approve profile).
        // --trust: bypass workdir trust dialog (required for non-interactive).
        // --max-turns N: bound runaway agents.
        // --output streaming: newline-delimited LLMMessage JSON per turn.
        // Model + telemetry suppression are controlled via VIBE_* env vars.
        const escapedPrompt = JSON.stringify(options.prompt);
        const maxTurns = (options.agentOptions?.maxTurns as number | undefined) ?? 50;

        const vibeResult = await sandbox.runShell(
          [
            'export PATH="$HOME/.local/bin:$PATH"',
            `vibe --prompt ${escapedPrompt} --trust --max-turns ${maxTurns} --output streaming`,
          ].join(' && '),
          {
            [MISTRAL_DIRECT.apiKeyEnvVar]: options.apiKey,
            VIBE_ACTIVE_MODEL: options.model,
            VIBE_ENABLE_AUTO_UPDATE: 'false',
            VIBE_ENABLE_TELEMETRY: 'false',
            VIBE_ENABLE_OTEL: 'false',
            ...neutralWorkspace.env,
          }
        );

        agentOutput = vibeResult.stdout + vibeResult.stderr;
        transcript = extractTranscriptFromOutput(agentOutput);

        if (vibeResult.exitCode !== 0) {
          const errorLines = agentOutput.trim().split('\n').slice(-5).join('\n');
          return {
            success: false,
            output: agentOutput,
            transcript,
            error: errorLines || `Mistral Vibe CLI exited with code ${vibeResult.exitCode}`,
            duration: Date.now() - startTime,
            sandboxId: sandbox.sandboxId,
          };
        }

        // Upload test files for validation
        await sandbox.uploadFiles(testFiles);

        // Create vitest config for EVAL.ts/tsx
        await createVitestConfig(sandbox);

        // Inject transcript context so EVAL.ts tests can assert on agent behavior
        await injectTranscriptContext(sandbox, transcript, 'mistral-vibe', options.model);

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
