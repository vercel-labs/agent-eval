import { describe, expect, it } from 'vitest';
import {
  agentInstallSteps,
  createProtectedPathMatcher,
  projectInstallSteps,
  VERIFIER_PROTECTED_PATHS,
} from './verifier.js';
import { getAgent } from './index.js';
import type { InstallStep } from './plugin/contract.js';

describe('VERIFIER_PROTECTED_PATHS', () => {
  const isProtected = createProtectedPathMatcher(VERIFIER_PROTECTED_PATHS);

  it.each([
    'EVAL.ts',
    'EVAL.tsx',
    'PROMPT.md',
    'packages/app/EVAL.ts',
    'vitest.config.ts',
    'vitest.config.mts',
    'apps/web/vitest.workspace.json',
    '__agent_eval__/results.json',
    'node_modules/vitest/dist/index.js',
    'packages/app/node_modules/.bin/vitest',
  ])('protects %s', (path) => {
    expect(isProtected(path)).toBe(true);
  });

  it.each(['src/EVAL.test.ts', 'EVAL.ts.bak', 'vite.config.ts', 'package.json', 'src/index.ts', 'README.md'])(
    'leaves %s to the agent',
    (path) => {
      expect(isProtected(path)).toBe(false);
    }
  );
});

describe('install steps the verifier re-runs', () => {
  const step = (name: string, scope?: InstallStep['scope']): InstallStep => ({
    kind: 'shell',
    script: name,
    errorPrefix: name,
    errorBody: 'stderr',
    ...(scope ? { scope } : {}),
  });

  it('splits a scoped definition into project dependencies and the agent CLI', () => {
    const def = getAgent('vercel-ai-gateway/claude-code').definition;
    const steps = def.install({ prompt: '', timeout: 1, apiKey: '' });

    expect(projectInstallSteps(steps).map((s) => [s.cmd, ...(s.args ?? [])].join(' '))).toEqual(['npm install']);
    expect(agentInstallSteps(steps).map((s) => [s.cmd, ...(s.args ?? [])].join(' '))).toEqual([
      'npm install -g @anthropic-ai/claude-code',
    ]);
  });

  it('runs every step for a definition that marks no scope, since it cannot tell them apart', () => {
    const steps = [step('pnpm install'), step('curl agent | sh')];

    expect(projectInstallSteps(steps)).toEqual(steps);
    expect(agentInstallSteps(steps)).toEqual(steps);
  });

  it('marks the project install of every built-in agent', () => {
    for (const name of ['claude-code', 'codex', 'vercel-ai-gateway/opencode', 'vercel-ai-gateway/fx', 'gemini', 'cursor']) {
      const steps = getAgent(name).definition.install({ prompt: '', timeout: 1, apiKey: '' });
      expect(projectInstallSteps(steps).map((s) => s.args?.join(' '))).toEqual(['install']);
    }
  });
});
