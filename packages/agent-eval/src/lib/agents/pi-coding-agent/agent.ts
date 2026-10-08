/**
 * PI coding agent (`pi`, @earendil-works/pi-coding-agent) — host-side definition +
 * the thin Agent wrapper.
 *
 * The definition is pure data/auth/config; the actual CLI invocation + transcript
 * capture live in ./run.mjs (shipped into the sandbox by the orchestrator). PI
 * only ever runs as a child process of that runner, inside the sandbox — its SDK
 * is never imported into the evaluator process, so a PI failure is an agent-run
 * failure, not an evaluator crash.
 *
 * PI is multi-provider, but like OpenCode it only runs through the Vercel AI
 * Gateway here (PI's built-in `vercel-ai-gateway` provider), so there is no
 * gateway/direct fork: a single agent, always authenticated with
 * AI_GATEWAY_API_KEY. See {@link PiAgentOptions} for what agentOptions accepts.
 */

import { fileURLToPath } from 'node:url';

import type { Agent, AgentRunOptions } from '../types.js';
import type { ModelTier } from '../../types.js';
import { AI_GATEWAY } from '../shared.js';
import type { AgentDefinition, ConfigFile, InstallStep } from '../plugin/contract.js';
import { runWithDefinition } from '../plugin/orchestrator.js';

/**
 * Additional provider configuration for PI's `models.json`, e.g. gateway models
 * PI's built-in catalog does not list yet. Passed through
 * agentOptions.extraProviders verbatim — see PI's "Custom Models" docs for every
 * field.
 */
export interface PiProviderConfig {
  baseUrl?: string;
  /** 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai' */
  api?: string;
  headers?: Record<string, string>;
  models?: Array<{ id: string } & Record<string, unknown>>;
  [key: string]: unknown;
}

/** What `agentOptions` accepts for the PI agent. */
export interface PiAgentOptions {
  /** Extra entries for PI's `~/.pi/agent/models.json`. Runs always use the
   * `vercel-ai-gateway` provider, so this extends or overrides that provider. */
  extraProviders?: Record<string, PiProviderConfig>;
  /** PI thinking level: off | minimal | low | medium | high | xhigh | max. */
  thinking?: string;
  /** npm package (optionally versioned) to install instead of the latest PI. */
  cliPackage?: string;
}

const DEFAULT_CLI_PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * Generate PI's `models.json` from `agentOptions.extraProviders`, or undefined
 * when there are none. Passed through as-is.
 */
export function generatePiModelsConfig(
  extraProviders: Record<string, PiProviderConfig> | undefined
): string | undefined {
  if (!extraProviders || Object.keys(extraProviders).length === 0) return undefined;
  return JSON.stringify({ providers: extraProviders }, null, 2);
}

/** Heredoc a config file into PI's global agent dir (an absolute `~` path writeFiles can't target). */
function writePiAgentFile(file: string, content: string): ConfigFile {
  const marker = `PI_${file.replace(/\W/g, '_').toUpperCase()}_EOF`;
  return { viaShell: `mkdir -p ~/.pi/agent && cat > ~/.pi/agent/${file} << '${marker}'\n${content}\n${marker}` };
}

/**
 * Build the PI plugin definition.
 *
 * getApiKeyEnvVar() and authEnv() agree on AI_GATEWAY_API_KEY, so the host's key
 * resolution and the sandbox env stay consistent.
 */
export function createPiCodingAgentDefinition(): AgentDefinition {
  return {
    name: 'vercel-ai-gateway/pi-coding-agent',
    displayName: 'PI Coding Agent (Vercel AI Gateway)',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    o11yAgentName: 'vercel-ai-gateway/pi-coding-agent',
    // PI ships no vendor-bundled skills; it only discovers caller-installed ones.
    bundledSkillsControl: 'not-applicable',
    // Resolve run.mjs next to this file (works in src during dev and in dist after
    // the build copies run.mjs alongside the compiled agent.js).
    runnerPath: fileURLToPath(new URL('./run.mjs', import.meta.url)),

    // PI only supports the Vercel AI Gateway here, never direct provider APIs.
    getApiKeyEnvVar(): string {
      return AI_GATEWAY.apiKeyEnvVar;
    },

    install(options: AgentRunOptions): InstallStep[] {
      // Project deps (retried once), then the PI CLI globally.
      const cliPackage = (options.agentOptions as PiAgentOptions | undefined)?.cliPackage || DEFAULT_CLI_PACKAGE;
      return [
        { kind: 'command', cmd: 'npm', args: ['install'], retryOnce: true, errorPrefix: 'npm install failed', errorBody: 'last10' },
        { kind: 'command', cmd: 'npm', args: ['install', '-g', cliPackage], errorPrefix: 'PI coding agent install failed', errorBody: 'stderr' },
      ];
    },

    // The gateway provider needs no config. Extra providers go to PI's global
    // agent dir, which stays out of the workspace (and so out of the captured diff).
    configFiles(options: AgentRunOptions): ConfigFile[] {
      const piOptions = options.agentOptions as PiAgentOptions | undefined;
      const files: ConfigFile[] = [];
      const models = generatePiModelsConfig(piOptions?.extraProviders);
      if (models) files.push(writePiAgentFile('models.json', models));
      return files;
    },

    authEnv(options: AgentRunOptions): Record<string, string> {
      return {
        // No update check / install ping from inside an eval sandbox.
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
        [AI_GATEWAY.apiKeyEnvVar]: options.apiKey,
      };
    },

    /**
     * Host-threaded `--thinking` level. Rides in extra (not agentOptions) because
     * extra is what both runner entry points ship — the orchestrator and the
     * judge's eval-helper. null when unset.
     */
    runnerExtra(options: AgentRunOptions): Record<string, unknown> {
      return { thinking: (options.agentOptions as PiAgentOptions | undefined)?.thinking ?? null };
    },
  };
}

/**
 * Create the PI Agent. Thin wrapper over the generic orchestrator so the Agent
 * interface (and thus registry.ts / index.ts / runner.ts) is unchanged.
 */
export function createPiCodingAgent(): Agent {
  const definition = createPiCodingAgentDefinition();
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
