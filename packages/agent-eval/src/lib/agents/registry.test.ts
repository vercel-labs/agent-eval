import { describe, expect, it } from 'vitest';
import type { Agent } from './types.js';
import { getAgent, hasAgent, registerAgent } from './registry.js';
import type { AgentDefinition } from './plugin/contract.js';

function customDefinition(name: string): AgentDefinition {
  return {
    name,
    displayName: name,
    defaultModel: 'custom-default',
    o11yAgentName: 'claude-code',
    runnerPath: '/custom/run.mjs',
    getApiKeyEnvVar: () => 'CUSTOM_API_KEY',
    install: () => [],
    configFiles: () => [],
    authEnv: () => ({}),
  };
}

function customAgent(name: string): Agent {
  const definition = customDefinition(name);
  return {
    name,
    displayName: name,
    getApiKeyEnvVar: definition.getApiKeyEnvVar,
    getDefaultModel: () => definition.defaultModel,
    run: async () => ({ success: true, output: '', duration: 0 }),
    definition,
  };
}

describe('agent registry', () => {
  it('registers a custom agent and preserves its required definition', () => {
    const agent = customAgent('registry-test-custom');

    registerAgent(agent);

    expect(hasAgent(agent.name)).toBe(true);
    expect(getAgent(agent.name)).toBe(agent);
    expect(getAgent(agent.name).definition).toBe(agent.definition);
  });

  it('allows a registration to be refreshed under the same stable name', () => {
    const replacement = customAgent('registry-test-replacement');

    registerAgent(customAgent('registry-test-replacement'));
    registerAgent(replacement);

    expect(getAgent(replacement.name)).toBe(replacement);
  });

  it('rejects empty names', () => {
    expect(() => registerAgent(customAgent(''))).toThrow(
      'Agent name must be a non-empty string.'
    );
  });
});
