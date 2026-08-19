import { describe, it, expect, afterEach } from 'vitest';
import { resolveJudgeRuntime } from './orchestrator.js';
import { JUDGE_RUNNER_PATH } from '../shared.js';
import { getAgent } from '../index.js';
import type { AgentRunOptions } from '../types.js';

const RUNNER_PATH = '__agent_eval__/run.mjs';

const baseOptions: AgentRunOptions = {
  prompt: 'do it',
  model: 'claude-sonnet-4-5',
  timeout: 600_000,
  apiKey: 'codegen-key',
};

describe('resolveJudgeRuntime', () => {
  const savedGatewayKey = process.env.AI_GATEWAY_API_KEY;
  afterEach(() => {
    if (savedGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = savedGatewayKey;
  });

  it('self-grades with the codegen agent+model when judge is unset', () => {
    const def = getAgent('vercel-ai-gateway/claude-code').definition;
    const rt = resolveJudgeRuntime(def, baseOptions);

    expect(rt.isSelf).toBe(true);
    expect(rt.runnerSource).toBeNull();
    expect(rt.config.runnerPath).toBe(RUNNER_PATH);
    expect(rt.config.model).toBe('claude-sonnet-4-5'); // codegen model
    expect(rt.authEnv.ANTHROPIC_AUTH_TOKEN).toBe('codegen-key'); // codegen auth
    expect(rt.config.disableBundledSkills).toBeUndefined();
  });

  it('pins the judge model but reuses the codegen runner when the agent matches', () => {
    const def = getAgent('vercel-ai-gateway/claude-code').definition;
    const rt = resolveJudgeRuntime(def, {
      ...baseOptions,
      disableBundledSkills: true,
      judge: { model: 'claude-opus-4-8' }, // agent omitted → same as codegen
    });

    expect(rt.isSelf).toBe(true);
    expect(rt.runnerSource).toBeNull(); // no second runner shipped
    expect(rt.config.runnerPath).toBe(RUNNER_PATH);
    expect(rt.config.model).toBe('claude-opus-4-8'); // PINNED, not codegen's sonnet
    expect(rt.authEnv.ANTHROPIC_AUTH_TOKEN).toBe('codegen-key'); // same-agent auth reused
    expect(rt.config.disableBundledSkills).toBe(true);
  });

  it('resolves a different judge agent with its own runner, model, and auth', () => {
    process.env.AI_GATEWAY_API_KEY = 'judge-gateway-key';
    const codegen = getAgent('codex').definition; // codegen is codex...
    const rt = resolveJudgeRuntime(codegen, {
      ...baseOptions,
      disableBundledSkills: true,
      judge: { agent: 'vercel-ai-gateway/claude-code', model: 'claude-opus-4-8' }, // ...judge is Claude
    });

    expect(rt.isSelf).toBe(false);
    expect(rt.config.runnerPath).toBe(JUDGE_RUNNER_PATH); // ships a separate judge-run.mjs
    expect(typeof rt.runnerSource).toBe('string');
    expect((rt.runnerSource ?? '').length).toBeGreaterThan(0); // the Claude runner source
    expect(rt.config.model).toBe('claude-opus-4-8'); // judge model
    // Judge uses ITS OWN gateway auth (resolved from AI_GATEWAY_API_KEY), not codex's.
    expect(rt.authEnv.ANTHROPIC_BASE_URL).toBeTruthy();
    expect(rt.authEnv.ANTHROPIC_AUTH_TOKEN).toBe('judge-gateway-key');
    expect(rt.config.disableBundledSkills).toBe(true);
  });

  it('rejects a pinned judge that cannot disable bundled skills', () => {
    const codegen = getAgent('vercel-ai-gateway/claude-code').definition;
    expect(() =>
      resolveJudgeRuntime(codegen, {
        ...baseOptions,
        disableBundledSkills: true,
        judge: { agent: 'gemini', model: 'gemini-2.5-pro' },
      })
    ).toThrow('Agent gemini does not support disableBundledSkills');
  });
});
