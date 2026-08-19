/**
 * Claude Code agent — host-side definition + the thin Agent wrapper.
 *
 * The definition is pure data/auth; the actual CLI invocation + transcript capture
 * live in ./run.mjs (shipped into the sandbox by the orchestrator). The wrapper
 * keeps the public Agent interface identical so the registry / runner are untouched.
 */

import { fileURLToPath } from 'node:url';

import type { Agent, AgentRunOptions } from '../types.js';
import type { ModelTier } from '../../types.js';
import { AI_GATEWAY, ANTHROPIC_DIRECT } from '../shared.js';
import type { AgentDefinition } from '../plugin/contract.js';
import { runWithDefinition } from '../plugin/orchestrator.js';

/**
 * Build the Claude Code plugin definition.
 *
 * Auth has three mutually-exclusive modes, preserved exactly from the old adapter:
 *   1. Vercel AI Gateway  → ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (+ empty ANTHROPIC_API_KEY)
 *   2. OAuth (CLAUDE_CODE_OAUTH_TOKEN present in the host env) → CLAUDE_CODE_OAUTH_TOKEN
 *   3. Direct API (fallback) → ANTHROPIC_API_KEY
 * getApiKeyEnvVar() and authEnv() must agree on the mode — both read process.env at
 * call time, so the host's key resolution and the sandbox env stay consistent.
 */
export function createClaudeCodeDefinition({ useVercelAiGateway }: { useVercelAiGateway: boolean }): AgentDefinition {
  return {
    name: useVercelAiGateway ? 'vercel-ai-gateway/claude-code' : 'claude-code',
    displayName: useVercelAiGateway ? 'Claude Code (Vercel AI Gateway)' : 'Claude Code',
    defaultModel: 'opus',
    o11yAgentName: 'claude-code',
    bundledSkillsControl: 'configurable',
    // Resolve run.mjs next to this file (works in src during dev and in dist after
    // the build copies run.mjs alongside the compiled agent.js).
    runnerPath: fileURLToPath(new URL('./run.mjs', import.meta.url)),

    getApiKeyEnvVar(): string {
      if (useVercelAiGateway) return AI_GATEWAY.apiKeyEnvVar;
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN';
      return ANTHROPIC_DIRECT.apiKeyEnvVar;
    },

    install(options: AgentRunOptions) {
      // Project deps (retried once), then the Claude Code CLI globally.
      const cliPackage = (options.agentOptions?.cliPackage as string) || '@anthropic-ai/claude-code';
      return [
        { kind: 'command', cmd: 'npm', args: ['install'], retryOnce: true, errorPrefix: 'npm install failed', errorBody: 'last10' },
        { kind: 'command', cmd: 'npm', args: ['install', '-g', cliPackage], errorPrefix: 'Claude Code install failed', errorBody: 'stderr' },
      ];
    },

    // Claude Code is configured purely via env — no config files.
    configFiles() {
      return [];
    },

    authEnv(options: AgentRunOptions): Record<string, string> {
      if (useVercelAiGateway) {
        return {
          ANTHROPIC_BASE_URL: AI_GATEWAY.baseUrl,
          ANTHROPIC_AUTH_TOKEN: options.apiKey,
          ANTHROPIC_API_KEY: '',
        };
      }
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        return { CLAUDE_CODE_OAUTH_TOKEN: options.apiKey };
      }
      return { ANTHROPIC_API_KEY: options.apiKey };
    },
  };
}

/**
 * Create the Claude Code Agent. Thin wrapper over the generic orchestrator so the
 * Agent interface (and thus registry.ts / index.ts / runner.ts) is unchanged.
 */
export function createClaudeCodeAgent({ useVercelAiGateway }: { useVercelAiGateway: boolean }): Agent {
  const definition = createClaudeCodeDefinition({ useVercelAiGateway });
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
