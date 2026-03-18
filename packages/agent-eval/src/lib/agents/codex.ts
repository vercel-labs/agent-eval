/**
 * OpenAI Codex CLI agent implementation.
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
  OPENAI_DIRECT,
  initGitAndCommit,
  injectTranscriptContext,
} from './shared.js';

/** Union type for sandbox implementations */
type AnySandbox = SandboxManager | DockerSandboxManager;

/**
 * Parse model string with optional query parameters.
 * e.g. "gpt-5.2-codex?reasoningEffort=high" → { model: "gpt-5.2-codex", reasoningEffort: "high" }
 */
function parseModelString(model: string): { model: string; reasoningEffort?: string } {
  const qIndex = model.indexOf('?');
  if (qIndex === -1) return { model };

  const base = model.slice(0, qIndex);
  const query = model.slice(qIndex + 1);
  let reasoningEffort: string | undefined;

  for (const pair of query.split('&')) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = pair.slice(0, eqIndex);
    const value = decodeURIComponent(pair.slice(eqIndex + 1));
    if (key === 'reasoningEffort') {
      reasoningEffort = value;
    }
  }

  return { model: base, reasoningEffort };
}

/**
 * Extract transcript from Codex JSON output.
 * When run with --json, Codex outputs JSONL to stdout with the full transcript.
 */
function extractTranscriptFromOutput(output: string): string | undefined {
  if (!output || !output.trim()) {
    return undefined;
  }

  // The --json output is already the transcript in JSONL format
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
 * Generate Codex config.toml content.
 */
function generateCodexConfig(model: string, useVercelAiGateway: boolean): string {
  if (useVercelAiGateway) {
    // AI Gateway uses prefixed model names like "openai/gpt-5.2-codex"
    const fullModel = model.includes('/') ? model : `openai/${model}`;
    return `# Codex configuration for Vercel AI Gateway
profile = "default"

[model_providers.vercel]
name = "Vercel AI Gateway"
base_url = "${AI_GATEWAY.openAiBaseUrl}"
env_key = "${AI_GATEWAY.apiKeyEnvVar}"
wire_api = "responses"

[profiles.default]
model_provider = "vercel"
model = "${fullModel}"
`;
  } else {
    // Direct OpenAI API — use the built-in "openai" provider (no custom provider needed)
    const directModel = model.includes('/') ? model.split('/').pop()! : model;
    return `# Direct OpenAI API configuration
profile = "default"

[profiles.default]
model_provider = "openai"
model = "${directModel}"
`;
  }
}

/**
 * Create Codex agent with specified authentication method.
 */
export function createCodexAgent({ useVercelAiGateway }: { useVercelAiGateway: boolean }): Agent {
  return {
    name: useVercelAiGateway ? 'vercel-ai-gateway/codex' : 'codex',
    displayName: useVercelAiGateway ? 'OpenAI Codex (Vercel AI Gateway)' : 'OpenAI Codex',

    getApiKeyEnvVar(): string {
      return useVercelAiGateway ? AI_GATEWAY.apiKeyEnvVar : OPENAI_DIRECT.apiKeyEnvVar;
    },

    getDefaultModel(): ModelTier {
      return 'openai/gpt-5.2-codex';
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

      // Install Codex CLI globally
      const cliInstall = await sandbox.runCommand('npm', [
        'install',
        '-g',
        '@openai/codex',
      ]);
      if (cliInstall.exitCode !== 0) {
        throw new Error(`Codex CLI install failed: ${cliInstall.stderr}`);
      }

      // Parse model string for query parameters (e.g. "gpt-5.2-codex?reasoningEffort=high")
      const { model: baseModel, reasoningEffort } = parseModelString(options.model);

      // Create Codex config directory and config file
      await sandbox.runShell('mkdir -p ~/.codex');
      const configContent = generateCodexConfig(baseModel, useVercelAiGateway);
      await sandbox.runShell(`cat > ~/.codex/config.toml << 'EOF'
${configContent}
EOF`);

      // Verify no test files in sandbox
      await verifyNoTestFiles(sandbox);

      // Build Codex CLI command
      const envVarToSet = useVercelAiGateway ? AI_GATEWAY.apiKeyEnvVar : OPENAI_DIRECT.apiKeyEnvVar;
      const escapedPrompt = options.prompt.replace(/'/g, "'\\''");
      const reasoningFlag = reasoningEffort ? ` -c model_reasoning_effort="${reasoningEffort}"` : '';
      // Direct OpenAI API needs unprefixed model names (e.g. "gpt-5.2-codex" not "openai/gpt-5.2-codex")
      const cliModel = useVercelAiGateway ? baseModel : (baseModel.includes('/') ? baseModel.split('/').pop()! : baseModel);
      // codex login sets up bearer auth for the CLI; the built-in openai provider requires it
      const codexResult = await sandbox.runShell(
        `echo '${options.apiKey}' | codex login --with-api-key && codex exec --model ${cliModel} --dangerously-bypass-approvals-and-sandbox --json --skip-git-repo-check${reasoningFlag} '${escapedPrompt}'`,
        { [envVarToSet]: options.apiKey }
      );

      agentOutput = codexResult.stdout + codexResult.stderr;
      transcript = extractTranscriptFromOutput(agentOutput);

      if (codexResult.exitCode !== 0) {
        // Extract meaningful error from output (last few lines usually contain the error)
        const errorLines = agentOutput.trim().split('\n').slice(-5).join('\n');
        return {
          success: false,
          output: agentOutput,
          transcript,
          error: errorLines || `Codex CLI exited with code ${codexResult.exitCode}`,
          duration: Date.now() - startTime,
          sandboxId: sandbox.sandboxId,
        };
      }

      // Upload test files for validation
      await sandbox.uploadFiles(testFiles);

      // Create vitest config for EVAL.ts/tsx
      await createVitestConfig(sandbox);

      // Inject transcript context so EVAL.ts tests can assert on agent behavior
      await injectTranscriptContext(sandbox, transcript, 'codex', options.model);

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
