/**
 * OpenAI Codex agent — host-side definition + the thin Agent wrapper.
 *
 * The definition is pure data/auth/config; the actual CLI invocation + transcript
 * capture live in ./run.mjs (shipped into the sandbox by the orchestrator). The
 * wrapper keeps the public Agent interface identical so the registry / runner are
 * untouched.
 *
 * Codex is the one agent that needs BOTH a config file (a TOML profile written to
 * the absolute path `~/.codex/default.config.toml`) AND a host-computed value that
 * the runner must reproduce verbatim on the CLI (`-c model_reasoning_effort=...`,
 * `-c model_verbosity=...`, `--model ...`). Those CLI values MUST match the values
 * baked into the TOML, so they are derived ONCE on the host (from parseModelString)
 * and handed to the runner via `runnerExtra()` → `input.extra`. parseModelString
 * stays host-side (and exported) so the unit tests keep importing it.
 */

import { fileURLToPath } from 'node:url';

import type { Agent, AgentRunOptions } from '../types.js';
import type { ModelTier } from '../../types.js';
import { AI_GATEWAY, OPENAI_DIRECT } from '../shared.js';
import type { AgentDefinition, ConfigFile, InstallStep } from '../plugin/contract.js';
import { runWithDefinition } from '../plugin/orchestrator.js';

/**
 * Parse model string with optional query parameters.
 * e.g. "gpt-5.2-codex?reasoningEffort=high" → { model: "gpt-5.2-codex", reasoningEffort: "high" }
 *
 * Stays host-side (and exported) — the unit tests import it, and the resulting
 * values must be baked into BOTH the TOML config (configFiles) and the runner CLI
 * args (runnerExtra), so it must be computed exactly once on the host.
 */
export function parseModelString(model: string): { model: string; reasoningEffort?: string } {
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
 * Parse the run's model option into { model, reasoningEffort }, or all-undefined
 * for native-default runs. Used by BOTH configFiles() (the TOML profile) and
 * runnerExtra() (the CLI args), which MUST agree — so the parse happens once.
 */
function parseOptionsModel(options: AgentRunOptions): { model?: string; reasoningEffort?: string } {
  return options.model ? parseModelString(options.model) : { model: undefined, reasoningEffort: undefined };
}

/**
 * Default reasoning effort and verbosity baked into the generated Codex
 * profile.
 *
 * The Codex CLI itself defaults both `model_reasoning_effort` and
 * `model_verbosity` to `"low"`, but the default Codex model
 * (`gpt-5.2-codex`) only accepts `"medium"` for both — so an out-of-the-box
 * `codex exec` against the AI Gateway fails with:
 *   "Unsupported value: 'low' is not supported with the 'gpt-5.2-codex'
 *    model. Supported values are: 'medium'."
 * (the error covers both the `reasoning.effort` and `text.verbosity` request
 * parameters, depending on which the model rejected first).
 *
 * `"medium"` is also a valid value for the non-codex GPT-5.x models, so it's
 * a safe default. Callers can override reasoning effort per-run via
 * `model: "gpt-5.2-codex?reasoningEffort=high"`.
 */
const DEFAULT_REASONING_EFFORT = 'medium';
const DEFAULT_MODEL_VERBOSITY = 'medium';
const WEB_RESEARCH_PROTOCOL = 'live-v1';

/**
 * Generate Codex profile config content.
 *
 * `reasoningEffort` and `model_verbosity` are written into the profile so a
 * fresh `codex exec` doesn't pick up the CLI defaults of `"low"`, which are
 * rejected by `gpt-5.2-codex`. Defaults to `"medium"` when `reasoningEffort`
 * is omitted.
 *
 * Stays host-side (and exported) — the unit tests import it directly.
 */
export function generateCodexConfig(
  model: string | undefined,
  useVercelAiGateway: boolean,
  reasoningEffort?: string,
  webResearch?: boolean,
  disableBundledSkills?: boolean,
): string {
  // Codex replaced the legacy boolean [tools].web_search setting with this
  // top-level mode. Custom providers must also declare standalone support or
  // the CLI omits the tool before it sends a Responses request.
  const webSearchSetting = webResearch ? `web_search = "live"\n` : '';
  const bundledSkillsSection = disableBundledSkills
    ? `\n[skills.bundled]\nenabled = false\n`
    : '';
  if (useVercelAiGateway) {
    // AI Gateway uses prefixed model names like "openai/gpt-5.2-codex".
    // Native-default runs intentionally omit model and reasoning overrides.
    const fullModel = model ? (model.includes('/') ? model : `openai/${model}`) : undefined;
    return `# Codex configuration for Vercel AI Gateway
model_provider = "vercel"
${fullModel ? `model = "${fullModel}"\n` : ''}${model ? `model_reasoning_effort = "${reasoningEffort ?? DEFAULT_REASONING_EFFORT}"\nmodel_verbosity = "${DEFAULT_MODEL_VERBOSITY}"\n` : ''}${webSearchSetting}
[model_providers.vercel]
name = "Vercel AI Gateway"
base_url = "${AI_GATEWAY.openAiBaseUrl}"
env_key = "${AI_GATEWAY.apiKeyEnvVar}"
wire_api = "responses"
${webResearch ? 'supports_standalone_web_search = true\n' : ''}${bundledSkillsSection}`;
  } else {
    // Direct OpenAI API — use the built-in "openai" provider (no custom provider needed).
    // Native-default runs intentionally omit model and reasoning overrides.
    const directModel = model ? (model.includes('/') ? model.split('/').pop()! : model) : undefined;
    return `# Direct OpenAI API configuration
model_provider = "openai"
${directModel ? `model = "${directModel}"\n` : ''}${model ? `model_reasoning_effort = "${reasoningEffort ?? DEFAULT_REASONING_EFFORT}"\nmodel_verbosity = "${DEFAULT_MODEL_VERBOSITY}"\n` : ''}${webSearchSetting}${bundledSkillsSection}`;
  }
}

/**
 * Build the Codex plugin definition.
 *
 * Auth is two mutually-exclusive modes, preserved exactly from the old adapter:
 *   1. Vercel AI Gateway → AI_GATEWAY_API_KEY (the gateway "vercel" provider's env_key)
 *   2. Direct OpenAI API → OPENAI_API_KEY (the built-in "openai" provider's env_key)
 * The runner additionally pipes the same key into `codex login --with-api-key` over
 * stdin (reading it from process.env, never from the argv JSON).
 */
export function createCodexDefinition({ useVercelAiGateway }: { useVercelAiGateway: boolean }): AgentDefinition {
  return {
    name: useVercelAiGateway ? 'vercel-ai-gateway/codex' : 'codex',
    displayName: useVercelAiGateway ? 'OpenAI Codex (Vercel AI Gateway)' : 'OpenAI Codex',
    defaultModel: 'openai/gpt-5.2-codex',
    o11yAgentName: 'codex',
    bundledSkillsControl: 'configurable',
    // Resolve run.mjs next to this file (works in src during dev and in dist after
    // the build copies run.mjs alongside the compiled agent.js).
    runnerPath: fileURLToPath(new URL('./run.mjs', import.meta.url)),

    getApiKeyEnvVar(): string {
      return useVercelAiGateway ? AI_GATEWAY.apiKeyEnvVar : OPENAI_DIRECT.apiKeyEnvVar;
    },

    install(_options: AgentRunOptions): InstallStep[] {
      // Project deps (retried once), then the Codex CLI globally. Error wording is
      // preserved verbatim: 'npm install failed (exit code N):\n<last 10>' and
      // 'Codex CLI install failed: <stderr>'.
      return [
        { kind: 'command', cmd: 'npm', args: ['install'], retryOnce: true, errorPrefix: 'npm install failed', errorBody: 'last10' },
        { kind: 'command', cmd: 'npm', args: ['install', '-g', '@openai/codex'], errorPrefix: 'Codex CLI install failed', errorBody: 'stderr' },
      ];
    },

    configFiles(options: AgentRunOptions): ConfigFile[] {
      // Recent Codex CLI versions reject the old top-level `profile = "default"`
      // key in config.toml and instead load `$CODEX_HOME/<profile>.config.toml`
      // when `--profile <profile>` is set. For explicit models, reasoning_effort
      // is baked into the profile (rather than passed via -c at runtime) so the
      // value is visible in saved configs and so the CLI's own default of "low"
      // can't sneak through. For native-default runs we omit these settings.
      const parsed = parseOptionsModel(options);
      const configContent = generateCodexConfig(
        parsed.model,
        useVercelAiGateway,
        parsed.reasoningEffort,
        options.webResearch,
        options.disableBundledSkills,
      );
      // Absolute `~` path writeFiles can't target → heredoc via shell. Combines the
      // old `mkdir -p ~/.codex` + `cat > ~/.codex/default.config.toml << 'EOF'`.
      return [
        {
          viaShell: `mkdir -p ~/.codex && cat > ~/.codex/default.config.toml << 'EOF'\n${configContent}\nEOF`,
        },
      ];
    },

    authEnv(options: AgentRunOptions): Record<string, string> {
      // env_key the generated TOML expects: AI_GATEWAY_API_KEY for the "vercel"
      // provider, OPENAI_API_KEY for the built-in "openai" provider. The runner
      // also reads this same env to pipe the key into `codex login`.
      const envVar = useVercelAiGateway ? AI_GATEWAY.apiKeyEnvVar : OPENAI_DIRECT.apiKeyEnvVar;
      return { [envVar]: options.apiKey };
    },

    /**
     * Host-computed values the runner must reproduce verbatim on the CLI. These
     * derive from parseModelString and MUST match the TOML written in
     * configFiles(), so they are computed here (host-side) and threaded into the
     * runner via input.extra rather than re-deriving parseModelString in run.mjs.
     *
     *  - cliModel:                value for `--model` (gateway keeps the prefix,
     *                             direct OpenAI strips it), or null to omit.
     *  - reasoningEffort:         value for `-c model_reasoning_effort=...`, or null.
     *  - verbosity:               value for `-c model_verbosity=...` (only when a
     *                             model is set), or null to omit.
     *
     * (The login env var is chosen inside run.mjs from process.env — AI_GATEWAY_API_KEY
     * else OPENAI_API_KEY — since authEnv() sets exactly one, so no flag is needed here.)
     */
    runnerExtra(options: AgentRunOptions): Record<string, unknown> {
      const parsed = parseOptionsModel(options);
      const baseModel = parsed.model;
      // Direct OpenAI API needs unprefixed model names (e.g. "gpt-5.2-codex" not
      // "openai/gpt-5.2-codex"); the gateway keeps the prefix as-is.
      const cliModel = baseModel
        ? (useVercelAiGateway ? baseModel : (baseModel.includes('/') ? baseModel.split('/').pop()! : baseModel))
        : undefined;
      // Pass reasoning effort and verbosity via -c too; CLI flags have the highest
      // precedence and we've observed Codex CLI silently falling back to its "low"
      // defaults for both fields even when the profile sets them. Both default to
      // "medium" for compatibility with gpt-5.2-codex. Omitted on native-default.
      const reasoningEffort = baseModel ? (parsed.reasoningEffort ?? DEFAULT_REASONING_EFFORT) : undefined;
      const verbosity = baseModel ? DEFAULT_MODEL_VERBOSITY : undefined;
      return {
        cliModel: cliModel ?? null,
        reasoningEffort: reasoningEffort ?? null,
        verbosity: verbosity ?? null,
      };
    },

    fingerprintExtra(config): Record<string, unknown> | undefined {
      return config.webResearch
        ? { webResearchProtocol: WEB_RESEARCH_PROTOCOL }
        : undefined;
    },
  };
}

/**
 * Create the Codex Agent. Thin wrapper over the generic orchestrator so the Agent
 * interface (and thus registry.ts / index.ts / runner.ts) is unchanged.
 */
export function createCodexAgent({ useVercelAiGateway }: { useVercelAiGateway: boolean }): Agent {
  const definition = createCodexDefinition({ useVercelAiGateway });
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
