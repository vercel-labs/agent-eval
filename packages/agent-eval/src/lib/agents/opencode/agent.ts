/**
 * OpenCode agent — host-side definition + the thin Agent wrapper.
 *
 * The definition is pure data/auth/config; the actual CLI invocation + transcript
 * capture live in ./run.mjs (shipped into the sandbox by the orchestrator). The
 * wrapper keeps the public Agent interface identical so the registry / runner are
 * untouched.
 *
 * OpenCode only supports the Vercel AI Gateway (no direct provider APIs), so there
 * is a single variant: `vercel-ai-gateway/opencode`.
 *
 * `generateOpenCodeConfig` (the pure host-side config generator) STAYS in this file
 * and is exported so the existing unit tests keep importing it. The transcript /
 * observed-model parsing helpers (`extractObservedModelFromOpenCodeOutput`,
 * `extractSessionIdFromTranscript`, `extractObservedModelFromSessionExport`) moved
 * INTO ./run.mjs (so the tested logic is exactly what the sandbox runs) and the
 * test now imports them from there — see the test import change in the migration
 * notes.
 */

import { fileURLToPath } from 'node:url';

import type { Agent, AgentRunOptions } from '../types.js';
import type { ModelTier } from '../../types.js';
import { AI_GATEWAY } from '../shared.js';
import type { AgentDefinition, ConfigFile, InstallStep } from '../plugin/contract.js';
import { runWithDefinition } from '../plugin/orchestrator.js';

/**
 * Additional provider configuration for models not yet available in the
 * default Vercel AI Gateway (e.g., early access / unreleased models).
 *
 * Preserved verbatim from the old adapter — passed through agentOptions.extraProviders.
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
 * Resolve a model override into the id the OpenCode CLI expects.
 *
 * OpenCode reads `--model` as `<providerID>/<modelID>` and the generated
 * opencode.json only configures the `vercel` (AI Gateway) provider. A canonical
 * gateway id like `anthropic/claude-sonnet-5` therefore selects a *provider*
 * named `anthropic` — which is not configured and has no key in the sandbox —
 * and the CLI dies at session start ("Unexpected server error") on every task.
 * The gateway form OpenCode understands is `vercel/anthropic/claude-sonnet-5`.
 *
 * So: prefix `vercel/` unless the caller already targets a configured provider
 * (`vercel` itself, or a key in agentOptions.extraProviders — the escape hatch
 * for unreleased models). Mirrors codex's `openai/` prefixing in
 * generateCodexConfig, and the package's own defaultModel shape
 * (`vercel/anthropic/claude-sonnet-4`). A bare id with no `/` (never a valid
 * gateway id) is prefixed too, trading the opaque provider error for the
 * gateway's model-not-found.
 *
 * Stays host-side (and exported for the unit tests) — the resolution needs
 * extraProviders, which only the host knows.
 */
export function resolveOpenCodeModel(
  model: string,
  extraProviders?: Record<string, OpenCodeProviderConfig>
): string {
  const providerID = model.split('/')[0];
  if (providerID === 'vercel' || (extraProviders && Object.hasOwn(extraProviders, providerID))) {
    return model;
  }
  return `vercel/${model}`;
}

/**
 * Generate OpenCode config file content.
 * Configures the Vercel AI Gateway provider, plus any additional providers.
 *
 * STAYS host-side + exported (the unit test imports it). The content is written
 * verbatim into `opencode.json` in the sandbox by the orchestrator. Behavior is
 * identical to the old adapter, including writing the resolved apiKey into the
 * config (falling back to the `{env:AI_GATEWAY_API_KEY}` placeholder).
 */
export function generateOpenCodeConfig(
  extraProviders?: Record<string, OpenCodeProviderConfig>,
  apiKey?: string,
  timeoutMs?: number,
  webResearch?: boolean
): string {
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
      // OpenCode has no native web search; Exa-backed search is enabled via
      // OPENCODE_ENABLE_EXA=1 alongside these tool permissions.
      ...(webResearch ? { webfetch: 'allow', websearch: 'allow' } : {}),
    },
  }, null, 2);
}

/**
 * Build the OpenCode plugin definition.
 *
 * Auth is single-mode: the Vercel AI Gateway. authEnv() also carries the Exa
 * websearch toggle (OPENCODE_ENABLE_EXA) when webResearch is on — it rides in
 * process.env alongside the gateway key, exactly as the old adapter set it on the
 * CLI's spawn env. The matching tool permissions are written into opencode.json by
 * generateOpenCodeConfig.
 */
export function createOpenCodeDefinition(): AgentDefinition {
  return {
    name: 'vercel-ai-gateway/opencode',
    displayName: 'OpenCode (Vercel AI Gateway)',
    defaultModel: 'vercel/anthropic/claude-sonnet-4',
    o11yAgentName: 'vercel-ai-gateway/opencode',
    bundledSkillsControl: 'not-applicable',
    // Resolve run.mjs next to this file (works in src during dev and in dist after
    // the build copies run.mjs alongside the compiled agent.js).
    runnerPath: fileURLToPath(new URL('./run.mjs', import.meta.url)),

    // OpenCode only supports the Vercel AI Gateway, never direct provider APIs.
    getApiKeyEnvVar(): string {
      return AI_GATEWAY.apiKeyEnvVar;
    },

    install(options: AgentRunOptions): InstallStep[] {
      // Project deps (retried once, last-10-lines wording), then the OpenCode CLI.
      // The CLI has two mutually-exclusive install paths preserved from the old
      // adapter:
      //   - binaryUrl set → curl a custom binary into $HOME/.local/bin (e.g. a
      //     patched build for unreleased models). Error body is stdout+stderr.
      //   - otherwise     → `npm install -g opencode-ai`. Error body is stderr.
      const binaryUrl = options.agentOptions?.binaryUrl as string | undefined;

      const steps: InstallStep[] = [
        {
          kind: 'command',
          cmd: 'npm',
          args: ['install'],
          retryOnce: true,
          errorPrefix: 'npm install failed',
          errorBody: 'last10',
        },
      ];

      if (binaryUrl) {
        // Download a custom binary (e.g. a patched build for unreleased models).
        // Invoked as the old adapter did: `bash -c "<line>"` via a 'command' step,
        // so the curl line is byte-identical. On failure the orchestrator renders
        // `OpenCode CLI install failed: <stderr>`; the old adapter rendered
        // `OpenCode CLI install failed: <stdout> <stderr>` — for `curl -fsSL`
        // stdout is empty on failure, so the only difference is a dropped leading
        // space (see behaviorNotes / contractAdditions for the exact-parity option).
        steps.push({
          kind: 'command',
          cmd: 'bash',
          args: [
            '-c',
            `mkdir -p $HOME/.local/bin && curl -fsSL "${binaryUrl}" -o $HOME/.local/bin/opencode && chmod +x $HOME/.local/bin/opencode`,
          ],
          errorPrefix: 'OpenCode CLI install failed',
          errorBody: 'stderr',
        });
      } else {
        steps.push({
          kind: 'command',
          cmd: 'npm',
          args: ['install', '-g', 'opencode-ai'],
          errorPrefix: 'OpenCode CLI install failed',
          errorBody: 'stderr',
        });
      }

      return steps;
    },

    // OpenCode is configured via a project-local opencode.json (writeFiles target,
    // relative to cwd — not a `~` path, so no viaShell heredoc needed).
    configFiles(options: AgentRunOptions): ConfigFile[] {
      const extraProviders = options.agentOptions?.extraProviders as
        | Record<string, OpenCodeProviderConfig>
        | undefined;
      const content = generateOpenCodeConfig(
        extraProviders,
        options.apiKey,
        options.timeout,
        options.webResearch
      );
      return [{ path: 'opencode.json', content }];
    },

    authEnv(options: AgentRunOptions): Record<string, string> {
      return {
        [AI_GATEWAY.apiKeyEnvVar]: options.apiKey,
        // Exa-backed websearch is gated behind this env var in the OpenCode CLI;
        // the matching tool permissions are written into opencode.json by
        // generateOpenCodeConfig.
        ...(options.webResearch ? { OPENCODE_ENABLE_EXA: '1' } : {}),
      };
    },

    /**
     * Host-computed value the runner passes as `--model`: the model override
     * resolved against the configured providers (see resolveOpenCodeModel).
     * Computed here because extraProviders is host-side knowledge; the runner
     * also uses cliModel-vs-model to report observations back in the caller's
     * namespace (see normalizeObservedModel in run.mjs). null on native-default.
     */
    runnerExtra(options: AgentRunOptions): Record<string, unknown> {
      const extraProviders = options.agentOptions?.extraProviders as
        | Record<string, OpenCodeProviderConfig>
        | undefined;
      return {
        cliModel: options.model ? resolveOpenCodeModel(options.model, extraProviders) : null,
      };
    },
  };
}

/**
 * Create the OpenCode Agent. Thin wrapper over the generic orchestrator so the
 * Agent interface (and thus registry.ts / index.ts / runner.ts) is unchanged.
 */
export function createOpenCodeAgent(): Agent {
  const definition = createOpenCodeDefinition();
  return {
    name: definition.name,
    displayName: definition.displayName,
    getApiKeyEnvVar: definition.getApiKeyEnvVar,
    getDefaultModel(): ModelTier {
      return definition.defaultModel;
    },
    run: (fixturePath, options) => runWithDefinition(definition, fixturePath, options),
    definition,
  };
}
