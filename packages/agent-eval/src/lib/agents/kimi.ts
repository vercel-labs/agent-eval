/**
 * Kimi CLI agent implementation.
 * Supports Vercel AI Gateway (via openai_legacy provider) or direct Moonshot API.
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
  MOONSHOT_DIRECT,
  initGitAndCommit,
  injectTranscriptContext,
} from './shared.js';

/** Union type for sandbox implementations */
type AnySandbox = SandboxManager | DockerSandboxManager;

export interface CreateKimiAgentOptions {
  /** Route via Vercel AI Gateway (OpenAI-compatible) vs direct Moonshot API. */
  useVercelAiGateway: boolean;
}

/**
 * Extract transcript from Kimi CLI stream-json output.
 * `kimi --print --output-format stream-json` emits JSONL rows of
 * `{role: "assistant"|"tool", content, tool_calls?, tool_call_id?}`.
 */
function extractTranscriptFromOutput(output: string): string | undefined {
  if (!output || !output.trim()) {
    return undefined;
  }
  const lines = output.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('{') && trimmed.endsWith('}');
  });
  if (lines.length === 0) {
    return undefined;
  }
  return lines.join('\n');
}

/**
 * Generate the Kimi config.toml that wires a single `[providers.gateway]` provider
 * (type = openai_legacy) to the chosen endpoint, and defines a single `[models.<id>]`
 * that references it. The CLI is then invoked with `--model <id>`.
 */
function generateKimiConfig(params: {
  modelId: string;
  providerModelId: string;
  baseUrl: string;
  apiKey: string;
}): string {
  const { modelId, providerModelId, baseUrl, apiKey } = params;
  return [
    `default_model = ${JSON.stringify(modelId)}`,
    '',
    '[providers.gateway]',
    'type = "openai_legacy"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    `api_key = ${JSON.stringify(apiKey)}`,
    '',
    `[models.${modelId}]`,
    'provider = "gateway"',
    `model = ${JSON.stringify(providerModelId)}`,
    'max_context_size = 256000',
    '',
  ].join('\n');
}

/**
 * Model ID mapping.
 *
 * When using Vercel AI Gateway, Kimi models are served under the `moonshotai/*`
 * namespace (e.g. `moonshotai/kimi-k2-0905`). When using Moonshot directly,
 * Moonshot's own names apply (e.g. `kimi-k2-0905-preview`).
 *
 * The caller passes `options.model` as the *gateway/provider* model id; we use
 * a local id (without slashes, which TOML doesn't allow in the section key) for
 * the `[models.<id>]` section and `--model` flag.
 */
function toLocalModelId(providerModelId: string): string {
  // Replace anything that isn't TOML-bare-key-safe with a dash.
  return providerModelId.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * Create Kimi CLI agent. Pass `useVercelAiGateway: true` to route via the Vercel
 * AI Gateway (recommended — no Moonshot account required) or `false` to hit
 * Moonshot's API directly via MOONSHOT_API_KEY.
 */
export function createKimiAgent(options: CreateKimiAgentOptions): Agent {
  const { useVercelAiGateway } = options;
  const name = useVercelAiGateway ? 'vercel-ai-gateway/kimi' : 'kimi';
  const displayName = useVercelAiGateway ? 'Kimi CLI (Vercel AI Gateway)' : 'Kimi CLI';
  const apiKeyEnvVar = useVercelAiGateway
    ? AI_GATEWAY.apiKeyEnvVar
    : MOONSHOT_DIRECT.apiKeyEnvVar;
  const baseUrl = useVercelAiGateway
    ? AI_GATEWAY.openAiBaseUrl
    : MOONSHOT_DIRECT.baseUrl;
  const defaultModel: ModelTier = useVercelAiGateway
    ? 'moonshotai/kimi-k2-0905'
    : 'kimi-k2-0905-preview';

  return {
    name,
    displayName,

    getApiKeyEnvVar(): string {
      return apiKeyEnvVar;
    },

    getDefaultModel(): ModelTier {
      return defaultModel;
    },

    async run(fixturePath: string, runOptions: AgentRunOptions): Promise<AgentRunResult> {
      const startTime = Date.now();
      let sandbox: AnySandbox | null = null;
      let agentOutput = '';
      let transcript: string | undefined;
      let aborted = false;
      let sandboxStopped = false;

      const abortHandler = () => {
        aborted = true;
        if (sandbox && !sandboxStopped) {
          sandboxStopped = true;
          sandbox.stop().catch(() => {});
        }
      };

      if (runOptions.signal) {
        if (runOptions.signal.aborted) {
          return {
            success: false,
            output: '',
            error: 'Aborted before start',
            duration: 0,
          };
        }
        runOptions.signal.addEventListener('abort', abortHandler);
      }

      try {
        const allFiles = await collectLocalFiles(fixturePath);
        const { workspaceFiles, testFiles } = splitTestFiles(allFiles);

        if (aborted) {
          return { success: false, output: '', error: 'Aborted', duration: Date.now() - startTime };
        }

        sandbox = await createSandbox({
          timeout: runOptions.timeout,
          runtime: 'node24',
          backend: runOptions.sandbox,
        });

        if (aborted) {
          return {
            success: false,
            output: '',
            error: 'Aborted',
            duration: Date.now() - startTime,
            sandboxId: sandbox.sandboxId,
          };
        }

        await sandbox.uploadFiles(workspaceFiles);
        await initGitAndCommit(sandbox);

        if (runOptions.setup) {
          await runOptions.setup(sandbox);
        }

        // Install npm deps for the fixture (required by validation scripts / vitest).
        let installResult = await sandbox.runCommand('npm', ['install']);
        if (installResult.exitCode !== 0) {
          installResult = await sandbox.runCommand('npm', ['install']);
        }
        if (installResult.exitCode !== 0) {
          const output = (installResult.stdout + installResult.stderr).trim().split('\n').slice(-10).join('\n');
          throw new Error(`npm install failed (exit code ${installResult.exitCode}):\n${output}`);
        }

        // Install Kimi CLI via uv (which bootstraps Python if needed).
        // uv installs to $HOME/.local/bin, which we prepend to PATH below.
        const kimiInstall = await sandbox.runShell(
          [
            'set -e',
            'curl -LsSf https://astral.sh/uv/install.sh | sh',
            'export PATH="$HOME/.local/bin:$PATH"',
            'uv tool install kimi-cli',
            'kimi --version',
          ].join(' && ')
        );
        if (kimiInstall.exitCode !== 0) {
          throw new Error(
            `Kimi CLI install failed: ${(kimiInstall.stdout + kimiInstall.stderr).slice(-500)}`
          );
        }

        // Write the config.toml that routes Kimi through the chosen provider.
        const providerModelId = runOptions.model;
        const localModelId = toLocalModelId(providerModelId);
        const configContent = generateKimiConfig({
          modelId: localModelId,
          providerModelId,
          baseUrl,
          apiKey: runOptions.apiKey,
        });
        await sandbox.writeFiles({ 'kimi-config.toml': configContent });

        await verifyNoTestFiles(sandbox);

        // Run Kimi in non-interactive print mode with stream-json output.
        // --yolo is implicit with --print, but we pass it explicitly for clarity.
        const kimiResult = await sandbox.runShell(
          [
            'export PATH="$HOME/.local/bin:$PATH"',
            `kimi --config-file kimi-config.toml --model ${JSON.stringify(localModelId)} --print --yolo --output-format stream-json --prompt ${JSON.stringify(runOptions.prompt)}`,
          ].join(' && '),
          {
            [apiKeyEnvVar]: runOptions.apiKey,
          }
        );

        agentOutput = kimiResult.stdout + kimiResult.stderr;
        transcript = extractTranscriptFromOutput(agentOutput);

        if (kimiResult.exitCode !== 0) {
          const errorLines = agentOutput.trim().split('\n').slice(-5).join('\n');
          return {
            success: false,
            output: agentOutput,
            transcript,
            error: errorLines || `Kimi CLI exited with code ${kimiResult.exitCode}`,
            duration: Date.now() - startTime,
            sandboxId: sandbox.sandboxId,
          };
        }

        await sandbox.uploadFiles(testFiles);
        await createVitestConfig(sandbox);
        await injectTranscriptContext(sandbox, transcript, name, runOptions.model);

        const validationResults = await runValidation(sandbox, runOptions.scripts ?? []);
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
        if (runOptions.signal) {
          runOptions.signal.removeEventListener('abort', abortHandler);
        }
        if (sandbox && !sandboxStopped) {
          sandboxStopped = true;
          await sandbox.stop();
        }
      }
    },
  };
}
