/**
 * Gemini CLI agent — host-side definition + the thin Agent wrapper.
 *
 * Mirrors the Claude Code exemplar: the definition is pure data/auth, while the
 * actual CLI invocation + transcript capture live in ./run.mjs (shipped into the
 * sandbox by the orchestrator). The wrapper keeps the public Agent interface
 * identical so the registry / runner are untouched.
 *
 * Gemini uses DIRECT Google Gemini API access only (no AI Gateway variant in the
 * old adapter), configured purely via env — no config files.
 */

import { fileURLToPath } from 'node:url';

import type { Agent, AgentRunOptions } from '../types.js';
import type { ModelTier } from '../../types.js';
import { GEMINI_DIRECT } from '../shared.js';
import type { AgentDefinition } from '../plugin/contract.js';
import { runWithDefinition } from '../plugin/orchestrator.js';

/**
 * Build the Gemini CLI plugin definition.
 *
 * Auth is a single mode, preserved exactly from the old adapter: the resolved
 * apiKey is exported as GEMINI_API_KEY. getApiKeyEnvVar() and authEnv() agree on
 * that env var so the host's key resolution and the sandbox env stay consistent.
 */
export function createGeminiDefinition(): AgentDefinition {
  return {
    name: 'gemini',
    displayName: 'Gemini CLI',
    defaultModel: 'gemini-3-pro-preview',
    o11yAgentName: 'gemini',
    // Resolve run.mjs next to this file (works in src during dev and in dist after
    // the build copies run.mjs alongside the compiled agent.js).
    runnerPath: fileURLToPath(new URL('./run.mjs', import.meta.url)),

    getApiKeyEnvVar(): string {
      return GEMINI_DIRECT.apiKeyEnvVar;
    },

    install(_options: AgentRunOptions) {
      // Project deps (retried once), then the Gemini CLI globally.
      // Error wording matches the old adapter verbatim:
      //   npm install   → `npm install failed (exit code N):\n<last 10 lines>`
      //   gemini-cli    → `Gemini CLI install failed: <stderr>`
      return [
        { kind: 'command', cmd: 'npm', args: ['install'], retryOnce: true, errorPrefix: 'npm install failed', errorBody: 'last10' },
        { kind: 'command', cmd: 'npm', args: ['install', '-g', '@google/gemini-cli'], errorPrefix: 'Gemini CLI install failed', errorBody: 'stderr' },
      ];
    },

    // Gemini CLI is configured purely via env — no config files.
    configFiles() {
      return [];
    },

    // Recorded as provenance.agentCliVersion.
    versionCommand() {
      return { kind: 'command', cmd: 'gemini', args: ['--version'] };
    },

    authEnv(options: AgentRunOptions): Record<string, string> {
      return { [GEMINI_DIRECT.apiKeyEnvVar]: options.apiKey };
    },
  };
}

/**
 * Create the Gemini CLI Agent. Thin wrapper over the generic orchestrator so the
 * Agent interface (and thus registry.ts / index.ts / runner.ts) is unchanged.
 */
export function createGeminiAgent(): Agent {
  const definition = createGeminiDefinition();
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
