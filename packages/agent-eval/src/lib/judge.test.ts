import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_JUDGE_MODEL, getJudgeRuntimeSource, resolveJudgeEnv } from './judge.js';

// --- unit: host-side env resolution (what we forward into the sandbox vitest) ---
describe('resolveJudgeEnv', () => {
  beforeEach(() => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.AGENT_EVAL_JUDGE_MODEL;
    delete process.env.AGENT_EVAL_JUDGE_BASE_URL;
  });

  it('returns undefined without a gateway credential', () => {
    expect(resolveJudgeEnv()).toBeUndefined();
  });

  it('uses the default judge model when none is configured', () => {
    process.env.AI_GATEWAY_API_KEY = 'k';
    expect(resolveJudgeEnv()).toEqual({
      AI_GATEWAY_API_KEY: 'k',
      AGENT_EVAL_JUDGE_MODEL: DEFAULT_JUDGE_MODEL,
    });
  });

  it('respects AGENT_EVAL_JUDGE_MODEL and an explicit override', () => {
    process.env.AI_GATEWAY_API_KEY = 'k';
    process.env.AGENT_EVAL_JUDGE_MODEL = 'anthropic/from-env';
    expect(resolveJudgeEnv()?.AGENT_EVAL_JUDGE_MODEL).toBe('anthropic/from-env');
    expect(resolveJudgeEnv('explicit/model')?.AGENT_EVAL_JUDGE_MODEL).toBe('explicit/model');
  });

  it('falls back to VERCEL_OIDC_TOKEN', () => {
    process.env.VERCEL_OIDC_TOKEN = 'oidc';
    expect(resolveJudgeEnv()?.AI_GATEWAY_API_KEY).toBe('oidc');
  });

  it('forwards a custom base url when set', () => {
    process.env.AI_GATEWAY_API_KEY = 'k';
    process.env.AGENT_EVAL_JUDGE_BASE_URL = 'http://example/v1';
    expect(resolveJudgeEnv()?.AGENT_EVAL_JUDGE_BASE_URL).toBe('http://example/v1');
  });
});

// --- the runtime artifact that ships in the package + gets injected ---
describe('judge runtime artifact', () => {
  it('exposes helpers + the matcher and stays sandbox-portable', () => {
    const src = getJudgeRuntimeSource();
    expect(src).toContain('export function transcript');
    expect(src).toContain('export function diff');
    expect(src).toContain('toSatisfyCriterion');
    expect(src).toContain("import { expect } from 'vitest'");
    // Must not import anything beyond vitest + node builtins — it runs inside the
    // eval fixture's sandbox, which only has the fixture's own deps.
    expect(src).not.toMatch(/from ['"](?!vitest|node:)/);
  });
});

// --- e2e: the injected runtime, driven through a real vitest matcher, gateway stubbed ---
describe('toSatisfyCriterion (e2e, stubbed gateway)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-eval-judge-'));
  const realFetch = globalThis.fetch;
  let lastBody: { model: string; messages: unknown[] };
  let nextVerdict: { pass: boolean; reason: string };
  let rt: typeof import('./judge-runtime.mjs');

  const stubFetch = (respond: () => unknown) => {
    globalThis.fetch = (async (_url: string | URL, init: { body: string }) => {
      lastBody = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => respond(), text: async () => '' };
    }) as unknown as typeof fetch;
  };

  beforeAll(async () => {
    writeFileSync(
      join(tmp, 'transcript.json'),
      JSON.stringify({
        events: [
          { type: 'message', role: 'assistant', content: 'Opening React DevTools to inspect.' },
          { type: 'tool_call', tool: { name: 'shell', args: { command: 'agent-browser react devtools' } } },
        ],
      })
    );

    process.env.AGENT_EVAL_DIR = tmp;
    process.env.AGENT_EVAL_JUDGE_BASE_URL = 'http://stub.local/v1';
    process.env.AGENT_EVAL_JUDGE_MODEL = 'stub/model';
    process.env.AI_GATEWAY_API_KEY = 'stub-key';

    stubFetch(() => ({ choices: [{ message: { content: JSON.stringify(nextVerdict) } }] }));

    // Import the EXACT artifact that gets injected into the sandbox. Importing it
    // registers `toSatisfyCriterion` on this file's vitest `expect`.
    rt = await import('./judge-runtime.mjs');
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the normalized transcript as evidence', () => {
    const t = rt.transcript();
    expect(t).toContain('Opening React DevTools');
    expect(t).toContain('[tool:shell]');
  });

  it('passes when the judge returns pass, sending criterion + evidence to the gateway', async () => {
    nextVerdict = { pass: true, reason: 'used devtools' };
    await (expect(rt.transcript()) as { toSatisfyCriterion(c: string): Promise<void> }).toSatisfyCriterion(
      'used React DevTools to diagnose'
    );
    expect(lastBody.model).toBe('stub/model');
    expect(JSON.stringify(lastBody.messages)).toContain('used React DevTools to diagnose');
    expect(JSON.stringify(lastBody.messages)).toContain('Opening React DevTools');
  });

  it('fails (rejects) when the judge returns fail, surfacing the reason', async () => {
    nextVerdict = { pass: false, reason: 'no devtools used' };
    await expect(
      (expect(rt.transcript()) as { toSatisfyCriterion(c: string): Promise<void> }).toSatisfyCriterion(
        'used React DevTools to diagnose'
      )
    ).rejects.toThrow(/no devtools used/);
  });

  it('tolerates prose / fenced JSON in the model output', async () => {
    stubFetch(() => ({
      choices: [{ message: { content: '```json\n{"pass": true, "reason": "ok"}\n```' } }],
    }));
    await expect(rt.judge('evidence', 'criterion')).resolves.toEqual({ pass: true, reason: 'ok' });
  });
});
