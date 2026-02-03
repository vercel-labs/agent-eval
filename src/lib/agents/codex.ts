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
} from './shared.js';

/** Union type for sandbox implementations */
type AnySandbox = SandboxManager | DockerSandboxManager;

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
 * For direct mode, we embed the API key directly since env_key doesn't work reliably in the sandbox.
 */
function generateCodexConfig(model: string, useVercelAiGateway: boolean, apiKey?: string): string {
  const fullModel = model.includes('/') ? model : `openai/${model}`;

  if (useVercelAiGateway) {
    return `# Codex configuration for Vercel AI Gateway
profile = "default"

[model_providers.vercel]
name = "Vercel AI Gateway"
base_url = "${AI_GATEWAY.openAiBaseUrl}"
env_key = "${AI_GATEWAY.apiKeyEnvVar}"
wire_api = "chat"

[profiles.default]
model_provider = "vercel"
model = "${fullModel}"
`;
  } else {
    // For direct mode, embed the API key directly in config
    // This is safe because the sandbox is ephemeral and isolated
    return `# Direct OpenAI API configuration
profile = "default"

[model_providers.openai]
name = "OpenAI"
base_url = "${OPENAI_DIRECT.baseUrl}"
api_key = "${apiKey}"
wire_api = "chat"

[profiles.default]
model_provider = "openai"
model = "${fullModel}"
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

      // Install Codex CLI globally
      const cliInstall = await sandbox.runCommand('npm', [
        'install',
        '-g',
        '@openai/codex',
      ]);
      if (cliInstall.exitCode !== 0) {
        throw new Error(`Codex CLI install failed: ${cliInstall.stderr}`);
      }

      // Create Codex config directory and config file
      await sandbox.runShell('mkdir -p ~/.codex');
      const configContent = generateCodexConfig(
        options.model,
        useVercelAiGateway,
        useVercelAiGateway ? undefined : options.apiKey
      );
      await sandbox.runShell(`cat > ~/.codex/config.toml << 'EOF'
${configContent}
EOF`);

      // Verify no test files in sandbox
      await verifyNoTestFiles(sandbox);

      // Run Codex CLI using exec mode for non-interactive execution
      // Use --dangerously-bypass-approvals-and-sandbox since Vercel sandbox provides isolation
      // Use --json for structured output and --skip-git-repo-check since sandbox is not a git repo
      // Model is configured in config.toml, so we don't pass --model here
      const codexResult = await sandbox.runCommand(
        'codex',
        [
          'exec',
          '--dangerously-bypass-approvals-and-sandbox',
          '--json',
          '--skip-git-repo-check',
          options.prompt,
        ],
        {
          env: useVercelAiGateway
            ? {
                [AI_GATEWAY.apiKeyEnvVar]: options.apiKey,
              }
            : {
                [OPENAI_DIRECT.apiKeyEnvVar]: options.apiKey,
              },
        }
      );

      agentOutput = codexResult.stdout + codexResult.stderr;

      if (codexResult.exitCode !== 0) {
        // Extract meaningful error from output (last few lines usually contain the error)
        const errorLines = agentOutput.trim().split('\n').slice(-5).join('\n');
        return {
          success: false,
          output: agentOutput,
          error: errorLines || `Codex CLI exited with code ${codexResult.exitCode}`,
          duration: Date.now() - startTime,
          sandboxId: sandbox.sandboxId,
        };
      }

      // Upload test files for validation
      await sandbox.uploadFiles(testFiles);

      // Create vitest config for EVAL.ts/tsx
      await createVitestConfig(sandbox);

      // Extract transcript from the Codex JSON output (--json flag outputs JSONL)
      const transcript = extractTranscriptFromOutput(agentOutput);

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
