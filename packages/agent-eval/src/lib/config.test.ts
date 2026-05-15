import { describe, it, expect } from 'vitest';
import {
  validateConfig,
  resolveConfig,
  resolveEvalNames,
  CONFIG_DEFAULTS,
} from './config.js';

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
      maxTurns: 20,
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

  it('rejects invalid agent', () => {
    const config = { agent: 'invalid-agent' };
    expect(() => validateConfig(config)).toThrow('Invalid experiment configuration');
  });

  it('rejects non-positive runs', () => {
    const config = { agent: 'claude-code', runs: 0 };
    expect(() => validateConfig(config)).toThrow('Invalid experiment configuration');
  });

  it('rejects non-positive maxTurns', () => {
    const config = { agent: 'claude-code', maxTurns: 0 };
    expect(() => validateConfig(config)).toThrow('Invalid experiment configuration');
  });
});

describe('resolveConfig', () => {
  it('applies defaults for minimal config', () => {
    const config = { agent: 'claude-code' as const };
    const resolved = resolveConfig(config);

    expect(resolved.agent).toBe('claude-code');
    expect(resolved.model).toBe('opus');
    expect(resolved.runs).toBe(CONFIG_DEFAULTS.runs);
    expect(resolved.earlyExit).toBe(CONFIG_DEFAULTS.earlyExit);
    expect(resolved.validation).toBe(CONFIG_DEFAULTS.validation);
    expect(resolved.evals).toBe('*');
  });

  it('preserves provided values', () => {
    const config = {
      agent: 'claude-code' as const,
      model: 'haiku' as const,
      runs: 10,
      earlyExit: false,
      maxTurns: 12,
    };
    const resolved = resolveConfig(config);

    expect(resolved.model).toBe('haiku');
    expect(resolved.runs).toBe(10);
    expect(resolved.earlyExit).toBe(false);
    expect(resolved.maxTurns).toBe(12);
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
