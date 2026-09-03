/**
 * Cursor CLI agent — host-side definition + the thin Agent wrapper.
 *
 * The definition is pure data/auth; the actual CLI invocation + transcript capture
 * live in ./run.mjs (shipped into the sandbox by the orchestrator). The wrapper
 * keeps the public Agent interface identical so the registry / runner are untouched.
 *
 * Cursor uses direct Cursor API access only (no gateway branch), so auth is a single
 * env var (CURSOR_API_KEY). It writes no config files — everything is CLI flags + env.
 */

import { fileURLToPath } from 'node:url';

import type { Agent, AgentRunOptions } from '../types.js';
import type { ModelTier } from '../../types.js';
import { CURSOR_DIRECT } from '../shared.js';
import type { AgentDefinition } from '../plugin/contract.js';
import { runWithDefinition } from '../plugin/orchestrator.js';

/**
 * Build the Cursor CLI plugin definition.
 *
 * Preserved exactly from the old adapter:
 *   - install: project `npm install` (retried once) then the official install script
 *     `curl https://cursor.com/install -fsSL | bash` (a SHELL step, since it pipes).
 *     The installer writes `~/.local/bin/agent` and exits 0 without putting that
 *     directory on PATH, so we also assert the binary exists at that path.
 *   - no config files.
 *   - auth: CURSOR_API_KEY only (direct API, no gateway mode).
 *   - o11y parser name: 'cursor'.
 *   - default model tier: 'composer-1.5'.
 */
export function createCursorDefinition(): AgentDefinition {
  return {
    name: 'cursor',
    displayName: 'Cursor CLI',
    defaultModel: 'composer-1.5',
    o11yAgentName: 'cursor',
    // Resolve run.mjs next to this file (works in src during dev and in dist after
    // the build copies run.mjs alongside the compiled agent.js).
    runnerPath: fileURLToPath(new URL('./run.mjs', import.meta.url)),

    getApiKeyEnvVar(): string {
      return CURSOR_DIRECT.apiKeyEnvVar;
    },

    install(_options: AgentRunOptions) {
      // Project deps (retried once), then the Cursor CLI via the official installer.
      // The installer pipes curl→bash, so it must be a 'shell' step (not 'command').
      return [
        {
          kind: 'command',
          cmd: 'npm',
          args: ['install'],
          retryOnce: true,
          errorPrefix: 'npm install failed',
          errorBody: 'last10',
        },
        {
          kind: 'shell',
          // Official installer exits 0 even when ~/.local/bin is not on PATH.
          // Fail here if the symlink never landed, instead of a later ENOENT.
          script:
            'curl https://cursor.com/install -fsSL | bash && test -x "$HOME/.local/bin/agent"',
          errorPrefix: 'Cursor CLI install failed',
          errorBody: 'stderr',
        },
      ];
    },

    // Cursor is configured purely via CLI flags + env — no config files.
    configFiles() {
      return [];
    },

    authEnv(options: AgentRunOptions): Record<string, string> {
      // Direct API only: a single key env var. (The neutral-workspace env is merged
      // on top by the orchestrator.)
      return { [CURSOR_DIRECT.apiKeyEnvVar]: options.apiKey };
    },
  };
}

/**
 * Create the Cursor CLI Agent. Thin wrapper over the generic orchestrator so the
 * Agent interface (and thus registry.ts / index.ts / runner.ts) is unchanged.
 *
 * NOTE: keeps the old no-arg signature — index.ts calls `createCursorAgent()`.
 */
export function createCursorAgent(): Agent {
  const definition = createCursorDefinition();
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
