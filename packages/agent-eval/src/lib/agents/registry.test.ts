import { describe, expect, it } from 'vitest';
import type { Agent } from './types.js';
import { getAgent, hasAgent, registerAgent } from './registry.js';

function customAgent(name: string): Agent {
  return {
    name,
    displayName: name,
    getApiKeyEnvVar: () => 'CUSTOM_API_KEY',
    getDefaultModel: () => 'custom-default',
    run: async () => ({ success: true, output: '', duration: 0 }),
  };
}

describe('agent registry', () => {
  it('registers a custom one-shot agent without requiring a plugin definition', () => {
    const agent = customAgent('registry-test-custom');

    registerAgent(agent);

    expect(hasAgent(agent.name)).toBe(true);
    expect(getAgent(agent.name)).toBe(agent);
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
