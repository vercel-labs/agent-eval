import { describe, it, expect } from 'vitest';
import {
  validateConfig,
  resolveConfig,
  resolveEvalNames,
  CONFIG_DEFAULTS,
} from './config.js';
import { registerAgent } from './agents/index.js';
import type { Agent } from './agents/types.js';
import type { AgentDefinition } from './agents/plugin/contract.js';

describe('validateConfig', () => {
  it('accepts valid minimal config', () => {
    const config = { agent: 'claude-code' };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('accepts valid full config', () => {
    const config = {
      agent: 'claude-code',
      model: 'opus',
      evals: ['eval-1', 'eval-2'],
      runs: 5,
      earlyExit: false,
      scripts: ['build', 'lint'],
      validation: 'none',
      timeout: 600,
      brands: [
        {
          id: 'vercel',
          name: 'Vercel',
          domain: 'vercel.com',
          aliases: ['Vercel Platform'],
          isYourBrand: true,
        },
      ],
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('accepts a reusable sandbox template', () => {
    const sandboxTemplate = {
      key: 'deps-v1',
      identity: () => 'shared-deps',
      prepare: async () => {},
    };
    const validated = validateConfig({ agent: 'claude-code', sandboxTemplate }).sandboxTemplate;
    expect(validated?.key).toBe('deps-v1');
    expect(validated?.identity).toBeTypeOf('function');
    expect(validated?.prepare).toBeTypeOf('function');
  });

  it('rejects a sandbox template without a non-empty key', () => {
    expect(() =>
      validateConfig({ agent: 'claude-code', sandboxTemplate: { key: '', prepare: async () => {} } })
    ).toThrow('Invalid experiment configuration');
  });

  it('accepts array of models', () => {
    const config = {
      agent: 'claude-code',
      model: ['opus', 'sonnet', 'haiku'],
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('accepts function evals filter', () => {
    const config = {
      agent: 'claude-code',
      evals: (name: string) => name.startsWith('auth-'),
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('accepts a custom agent identifier for registry resolution', () => {
    const config = { agent: 'my-custom-agent' };
    expect(validateConfig(config).agent).toBe('my-custom-agent');
  });

  it('rejects an empty agent identifier', () => {
    const config = { agent: '' };
    expect(() => validateConfig(config)).toThrow('Invalid experiment configuration');
  });

  it('rejects non-positive runs', () => {
    const config = { agent: 'claude-code', runs: 0 };
    expect(() => validateConfig(config)).toThrow('Invalid experiment configuration');
  });

  it('keeps webResearch through validation (zod strips unknown keys)', () => {
    const config = { agent: 'claude-code', webResearch: true };
    expect(validateConfig(config).webResearch).toBe(true);
  });

  it('rejects non-boolean webResearch', () => {
    const config = { agent: 'claude-code', webResearch: 'yes' };
    expect(() => validateConfig(config)).toThrow('Invalid experiment configuration');
  });

  it('accepts a pinned judge (model only, agent defaults to codegen)', () => {
    const config = { agent: 'claude-code', judge: { model: 'claude-opus-4-8' } };
    expect(validateConfig(config).judge).toEqual({ model: 'claude-opus-4-8' });
  });

  it('accepts a pinned judge with an explicit agent', () => {
    const config = {
      agent: 'codex',
      judge: { agent: 'vercel-ai-gateway/claude-code', model: 'claude-opus-4-8' },
    };
    expect(validateConfig(config).judge).toEqual({
      agent: 'vercel-ai-gateway/claude-code',
      model: 'claude-opus-4-8',
    });
  });

  it('rejects a judge without a model (pinning the model is required)', () => {
    const config = { agent: 'claude-code', judge: { agent: 'claude-code' } };
    expect(() => validateConfig(config)).toThrow('Invalid experiment configuration');
  });

  it('rejects a judge with an invalid agent', () => {
    const config = { agent: 'claude-code', judge: { agent: 'nope', model: 'x' } };
    expect(() => validateConfig(config)).toThrow('Invalid experiment configuration');
  });
});

describe('resolveConfig', () => {
  it('applies defaults for minimal config', () => {
    const config = { agent: 'claude-code' as const };
    const resolved = resolveConfig(config);

    expect(resolved.agent).toBe('claude-code');
    expect(resolved.model).toBe('native-default');
    expect(resolved.runs).toBe(CONFIG_DEFAULTS.runs);
    expect(resolved.earlyExit).toBe(CONFIG_DEFAULTS.earlyExit);
    expect(resolved.validation).toBe(CONFIG_DEFAULTS.validation);
    expect(resolved.evals).toBe('*');
    expect(resolved.modelPolicy).toBe('native-default');
  });

  it('preserves provided values', () => {
    const config = {
      agent: 'claude-code' as const,
      model: 'haiku' as const,
      runs: 10,
      earlyExit: false,
    };
    const resolved = resolveConfig(config);

    expect(resolved.model).toBe('haiku');
    expect(resolved.modelPolicy).toBe('agent-default');
    expect(resolved.runs).toBe(10);
    expect(resolved.earlyExit).toBe(false);
  });

  it('resolves an agent registered by an experiment module', () => {
    const definition: AgentDefinition = {
      name: 'config-test-custom-agent',
      displayName: 'Config Test Custom Agent',
      defaultModel: 'custom-default',
      o11yAgentName: 'claude-code',
      runnerPath: '/custom/run.mjs',
      getApiKeyEnvVar: () => 'CUSTOM_AGENT_API_KEY',
      install: () => [],
      configFiles: () => [],
      authEnv: () => ({}),
    };
    const customAgent: Agent = {
      name: definition.name,
      displayName: definition.displayName,
      getApiKeyEnvVar: definition.getApiKeyEnvVar,
      getDefaultModel: () => definition.defaultModel,
      run: async () => ({ success: true, output: '', duration: 0 }),
      definition,
    };
    registerAgent(customAgent);

    expect(resolveConfig({ agent: customAgent.name }).agent).toBe(customAgent.name);
  });

  it('rejects an unregistered custom agent during resolution', () => {
    expect(() => resolveConfig({ agent: 'unregistered-config-test-agent' })).toThrow(
      'Unknown agent: unregistered-config-test-agent'
    );
  });

  it('passes sandboxTemplate through and leaves it undefined by default', () => {
    const sandboxTemplate = { key: 'deps-v1', prepare: async () => {} };
    expect(resolveConfig({ agent: 'claude-code' as const }).sandboxTemplate).toBeUndefined();
    expect(resolveConfig({ agent: 'claude-code' as const, sandboxTemplate }).sandboxTemplate).toBe(
      sandboxTemplate
    );
  });

  it('passes webResearch through and leaves it undefined by default', () => {
    expect(resolveConfig({ agent: 'claude-code' as const }).webResearch).toBeUndefined();
    expect(resolveConfig({ agent: 'claude-code' as const, webResearch: true }).webResearch).toBe(true);
  });

  it('passes judge through and leaves it undefined by default', () => {
    expect(resolveConfig({ agent: 'claude-code' as const }).judge).toBeUndefined();
    expect(
      resolveConfig({ agent: 'claude-code' as const, judge: { model: 'claude-opus-4-8' } }).judge
    ).toEqual({ model: 'claude-opus-4-8' });
  });

});

describe('resolveEvalNames', () => {
  const availableEvals = ['auth-login', 'auth-logout', 'ui-button', 'api-endpoint'];

  it('returns all evals for "*" filter', () => {
    const result = resolveEvalNames('*', availableEvals);
    expect(result).toEqual(availableEvals);
  });

  it('returns single eval for string filter', () => {
    const result = resolveEvalNames('auth-login', availableEvals);
    expect(result).toEqual(['auth-login']);
  });

  it('filters evals with function', () => {
    const result = resolveEvalNames((name) => name.startsWith('auth-'), availableEvals);
    expect(result).toEqual(['auth-login', 'auth-logout']);
  });

  it('throws for non-existent single eval', () => {
    expect(() => resolveEvalNames('non-existent', availableEvals)).toThrow(
      'Eval "non-existent" not found'
    );
  });

  it('supports glob patterns for nested directories', () => {
    const nestedEvals = [
      'vercel-cli/deploy',
      'vercel-cli/link',
      'vercel-cli/env',
      'flags/create',
      'flags/update',
      'analytics/track',
    ];

    // Match all vercel-cli evals
    expect(resolveEvalNames('vercel-cli/*', nestedEvals)).toEqual([
      'vercel-cli/deploy',
      'vercel-cli/link',
      'vercel-cli/env',
    ]);

    // Match all flags evals
    expect(resolveEvalNames('flags/*', nestedEvals)).toEqual(['flags/create', 'flags/update']);

    // Match specific nested eval
    expect(resolveEvalNames('vercel-cli/deploy', nestedEvals)).toEqual(['vercel-cli/deploy']);

    // Match all deploy evals across folders
    expect(resolveEvalNames('*/deploy', nestedEvals)).toEqual(['vercel-cli/deploy']);
  });

  it('supports glob patterns in arrays', () => {
    const nestedEvals = [
      'vercel-cli/deploy',
      'vercel-cli/link',
      'flags/create',
      'analytics/track',
    ];

    const result = resolveEvalNames(['vercel-cli/*', 'analytics/*'], nestedEvals);
    expect(result).toEqual(['vercel-cli/deploy', 'vercel-cli/link', 'analytics/track']);
  });

  it('throws when glob pattern matches nothing', () => {
    expect(() => resolveEvalNames('nonexistent/*', availableEvals)).toThrow(
      'No evals matched pattern "nonexistent/*"'
    );
  });

  it('handles special characters in eval names correctly', () => {
    // Test that dots and parentheses work correctly with glob patterns
    const specialCharsEvals = [
      'test.eval',
      'test-eval',
      'vercel-cli/deploy.test',
      'vercel-cli/deploy-test',
      'folder(1)/eval',
      'web-analytics/page-views',
    ];

    // Literal match - dot should match only dot, not any character
    expect(resolveEvalNames('test.eval', specialCharsEvals)).toEqual(['test.eval']);
    expect(resolveEvalNames('test.eval', specialCharsEvals)).not.toContain('test-eval');

    // Glob pattern with dot - should match literal dot
    expect(resolveEvalNames('vercel-cli/*.test', specialCharsEvals)).toEqual([
      'vercel-cli/deploy.test',
    ]);
    expect(resolveEvalNames('vercel-cli/*.test', specialCharsEvals)).not.toContain(
      'vercel-cli/deploy-test'
    );

    // Parentheses in eval names work with wildcards
    expect(resolveEvalNames('folder(1)/*', specialCharsEvals)).toEqual(['folder(1)/eval']);
    
    // Wildcard patterns work correctly
    expect(resolveEvalNames('web-analytics/*', specialCharsEvals)).toEqual(['web-analytics/page-views']);
  });
});
