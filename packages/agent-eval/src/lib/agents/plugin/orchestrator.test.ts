import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createSandbox } = vi.hoisted(() => ({ createSandbox: vi.fn() }));
vi.mock('../../sandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sandbox.js')>()),
  createSandbox,
}));

import { resolveJudgeRuntime, runCredentials, runWithDefinition } from './orchestrator.js';
import { LocalSandbox, writeTestRunner } from './local-sandbox.test-support.js';
import type { AgentDefinition } from './contract.js';
import { JUDGE_RUNNER_PATH } from '../shared.js';
import { getAgent, registerAgent } from '../index.js';
import { ConcurrencyLimiter, runExperiment } from '../../runner.js';
import type { AgentRunOptions } from '../types.js';

const RUNNER_PATH = '__agent_eval__/run.mjs';

const baseOptions: AgentRunOptions = {
  prompt: 'do it',
  model: 'claude-sonnet-4-5',
  timeout: 600_000,
  apiKey: 'codegen-key',
};

describe('sandbox cleanup', () => {
  let workDir: string;
  let fixtureDir: string;
  let sandboxes: LocalSandbox[];
  let def: AgentDefinition;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'agent-eval-cleanup-'));
    fixtureDir = join(workDir, 'fixture');
    mkdirSync(fixtureDir);
    sandboxes = [];
    def = {
      name: 'cleanup-test-agent', displayName: 'Cleanup Test Agent', defaultModel: 'none',
      runnerPath: writeTestRunner(workDir, "result.output = 'ok';"),
      getApiKeyEnvVar: () => 'TEST_KEY', install: () => [], configFiles: () => [], authEnv: () => ({}),
    };
    createSandbox.mockImplementation(async () => {
      const sandbox = new LocalSandbox();
      sandboxes.push(sandbox);
      return sandbox;
    });
  });

  afterEach(() => {
    for (const sandbox of sandboxes) sandbox.dispose();
    rmSync(workDir, { recursive: true, force: true });
    createSandbox.mockReset();
    vi.restoreAllMocks();
  });

  it('awaits the stop already requested by an abort before settling the run', async () => {
    const controller = new AbortController();
    const stop = Promise.withResolvers<void>();
    const uploading = Promise.withResolvers<void>();
    let stopCalls = 0;
    createSandbox.mockImplementation(async () => {
      const sandbox = new LocalSandbox();
      sandboxes.push(sandbox);
      vi.spyOn(sandbox, 'uploadFiles').mockImplementation(async () => {
        uploading.resolve();
        await new Promise<void>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('upload aborted')), { once: true });
        });
      });
      vi.spyOn(sandbox, 'stop').mockImplementation(async () => {
        stopCalls++;
        await stop.promise;
        sandbox.stopped = true;
      });
      return sandbox;
    });
    const run = runWithDefinition(def, fixtureDir, { ...baseOptions, signal: controller.signal });
    let settled = false;
    void run.finally(() => { settled = true; });
    await uploading.promise;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(settled).toBe(false);
      expect(sandboxes[0].stopped).toBe(false);
    } finally {
      stop.resolve();
      await run;
    }
    expect(stopCalls).toBe(1);
    expect(sandboxes[0].stopped).toBe(true);
  });

  it('does not create a verifier when cancelled during codegen cleanup', async () => {
    const controller = new AbortController();
    createSandbox.mockImplementation(async () => {
      const sandbox = new LocalSandbox();
      sandboxes.push(sandbox);
      vi.spyOn(sandbox, 'stop').mockImplementation(async () => {
        controller.abort();
        sandbox.stopped = true;
      });
      return sandbox;
    });
    const run = runWithDefinition(def, fixtureDir, {
      ...baseOptions, validation: 'none', verifier: 'separate', signal: controller.signal, requireCleanup: true,
    });
    expect((await run).error).toBe('Aborted');
    expect(sandboxes).toHaveLength(1);
  });

  it.each([undefined, 1])('makes a codegen stop failure fatal only with concurrency %s', async (cap) => {
    createSandbox.mockImplementation(async () => {
      const sandbox = new LocalSandbox();
      sandboxes.push(sandbox);
      if (sandboxes.length === 1) {
        vi.spyOn(sandbox, 'stop').mockRejectedValue(new Error('stop unavailable'));
      }
      return sandbox;
    });
    registerAgent({
      name: def.name, displayName: def.displayName, definition: def,
      getDefaultModel: () => def.defaultModel, getApiKeyEnvVar: def.getApiKeyEnvVar,
      run: (path, options) => runWithDefinition(def, path, options),
    });
    const run = runExperiment({
      config: {
        agent: def.name, model: 'none', evals: '*', runs: 1, earlyExit: false,
        scripts: [], timeout: 30, validation: 'none', verifier: 'separate',
      },
      fixtures: [{ name: 'eval', path: fixtureDir, prompt: 'test', isModule: true }],
      apiKey: 'test-key', resultsDir: join(workDir, 'results'), experimentName: 'cleanup',
      concurrencyLimiter: cap ? new ConcurrencyLimiter(cap) : undefined,
    });
    if (cap) {
      await expect(run).rejects.toThrow(/Failed to stop sandbox .*stop unavailable/);
      expect(sandboxes).toHaveLength(1);
    } else {
      expect((await run).evals[0].runs[0].result.status).toBe('passed');
      expect(sandboxes).toHaveLength(2);
      expect(sandboxes[1].stopped).toBe(true);
    }
  });

  it('keeps a shared runner slot until the real orchestrator finishes abort cleanup, including the last eval', async () => {
    const gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
    createSandbox.mockImplementation(async () => {
      const sandbox = new LocalSandbox();
      sandboxes.push(sandbox);
      const gate = Promise.withResolvers<void>();
      const upload = Promise.withResolvers<void>();
      gates.push(gate);
      vi.spyOn(sandbox, 'uploadFiles').mockImplementation(() => upload.promise);
      vi.spyOn(sandbox, 'stop').mockImplementation(async () => {
        upload.reject(new Error('upload aborted'));
        await gate.promise;
        sandbox.stopped = true;
      });
      return sandbox;
    });
    registerAgent({
      name: def.name, displayName: def.displayName, definition: def,
      getDefaultModel: () => def.defaultModel, getApiKeyEnvVar: def.getApiKeyEnvVar,
      run: (path, options) => runWithDefinition(def, path, options),
    });
    const completed: string[] = [];
    const experiment = runExperiment({
      config: { agent: def.name, model: 'none', evals: '*', runs: 1, earlyExit: false, scripts: [], timeout: 0.1 },
      fixtures: ['first', 'last'].map((name) => ({ name, path: fixtureDir, prompt: 'test', isModule: true })),
      apiKey: 'test-key', resultsDir: join(workDir, 'results'), experimentName: 'cleanup',
      concurrencyLimiter: new ConcurrencyLimiter(1),
      onProgress: (event) => { if (event.type === 'eval:complete') completed.push(event.evalName); },
    });
    let settled = false;
    void experiment.then(() => { settled = true; });
    await vi.waitFor(() => expect(completed).toEqual(['first']));
    try {
      expect(sandboxes).toHaveLength(1);
      expect(sandboxes[0].stopped).toBe(false);
      gates[0].resolve();
      await vi.waitFor(() => expect(completed).toEqual(['first', 'last']));
      expect(sandboxes).toHaveLength(2);
      expect(sandboxes[0].stopped).toBe(true);
      expect(settled).toBe(false);
    } finally {
      for (const gate of gates) gate.resolve();
      await experiment;
    }
    expect(sandboxes.every((sandbox) => sandbox.stopped)).toBe(true);
  });

  it('cleans up a sandbox whose creation finishes after cancellation', async () => {
    const controller = new AbortController();
    const created = Promise.withResolvers<LocalSandbox>();
    createSandbox.mockImplementation(() => created.promise);
    const run = runWithDefinition(def, fixtureDir, { ...baseOptions, signal: controller.signal });
    await vi.waitFor(() => expect(createSandbox).toHaveBeenCalledOnce());
    controller.abort();
    const sandbox = new LocalSandbox();
    sandboxes.push(sandbox);
    created.resolve(sandbox);
    expect((await run).error).toBe('Aborted');
    expect(sandbox.stopped).toBe(true);
    expect(sandbox.commands).toHaveLength(0);
  });
});

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

  it("keeps the codegen agent's agentOptions out of a different judge agent's setup", () => {
    process.env.AI_GATEWAY_API_KEY = 'judge-gateway-key';
    const pi = getAgent('vercel-ai-gateway/pi-coding-agent').definition;
    const claudeJudge = resolveJudgeRuntime(pi, {
      ...baseOptions,
      agentOptions: { cliPackage: '@earendil-works/pi-coding-agent@1.3.0' },
      judge: { agent: 'vercel-ai-gateway/claude-code', model: 'claude-opus-4-8' },
    });
    const claudeInstall = claudeJudge.judgeDef.install(claudeJudge.judgeOptions);
    expect(claudeInstall[1].args).toEqual(['install', '-g', '@anthropic-ai/claude-code']);

    const opencode = getAgent('vercel-ai-gateway/opencode').definition;
    const piJudge = resolveJudgeRuntime(opencode, {
      ...baseOptions,
      agentOptions: { extraProviders: { vercel: { options: { timeout: 1 } } } },
      judge: { agent: 'vercel-ai-gateway/pi-coding-agent', model: 'anthropic/claude-sonnet-4.5' },
    });
    const piConfig = piJudge.judgeDef.configFiles(piJudge.judgeOptions).map((file) => file.viaShell ?? '');
    expect(piConfig.some((script) => script.includes('models.json'))).toBe(false);
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

describe('runCredentials', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is just the codegen key when the judge self-grades', () => {
    const def = getAgent('vercel-ai-gateway/claude-code').definition;

    expect(runCredentials(def, baseOptions)).toEqual(['codegen-key']);
  });

  it('adds the key of a judge pinned to a different agent', () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'judge-gateway-key');
    const def = getAgent('codex').definition;

    expect(
      runCredentials(def, { ...baseOptions, judge: { agent: 'vercel-ai-gateway/claude-code', model: 'claude-opus-4-8' } })
    ).toEqual(['codegen-key', 'judge-gateway-key']);
  });

  it('includes every agentEnv value', () => {
    const def = getAgent('vercel-ai-gateway/claude-code').definition;

    expect(
      runCredentials(def, { ...baseOptions, agentEnv: { DEPLOY_TOKEN: 'dpl_live_7a1f0c9e44b2', REGION: 'iad1' } })
    ).toEqual(['codegen-key', 'dpl_live_7a1f0c9e44b2', 'iad1']);
  });

  it('falls back to the codegen key when the judge cannot be resolved', () => {
    const def = getAgent('codex').definition;

    expect(runCredentials(def, { ...baseOptions, judge: { agent: 'not-registered', model: 'm' } })).toEqual(['codegen-key']);
  });
});
