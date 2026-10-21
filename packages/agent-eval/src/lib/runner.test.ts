import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getEventListeners } from 'node:events';
import { SandboxCleanupError } from './sandbox-cleanup.js';
import { runExperiment, StartRateLimiter, ConcurrencyLimiter } from './runner.js';
import type { ResolvedExperimentConfig, RunnableExperimentConfig, EvalFixture, ProgressEvent } from './types.js';
import type { Agent, AgentRunResult } from './agents/types.js';
import type { AgentDefinition } from './agents/plugin/contract.js';
import * as agentsIndex from './agents/index.js';

let TEST_DIR: string;

// Captured before any test fakes timers, so flush() can always drain pending
// promise callbacks.
const realSetImmediate = setImmediate;
const flush = () => new Promise<void>((resolve) => realSetImmediate(resolve));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PASSED: AgentRunResult = {
  success: true,
  output: 'Agent output',
  duration: 6000,
  testResult: { success: true, output: 'Test passed' },
  scriptsResults: {},
};

interface FakeRun {
  fixturePath: string;
  /** Settles the agent's work; the sandbox is stopped after it. */
  work: ReturnType<typeof deferred<AgentRunResult>>;
  /** Resolve to let the sandbox's stop() complete. Already resolved unless the test gates teardown. */
  teardown: ReturnType<typeof deferred<void>>;
}

const FAKE_DEFINITION: AgentDefinition = {
  name: 'fake-agent',
  displayName: 'Fake Agent',
  defaultModel: 'mock-model',
  o11yAgentName: 'claude-code',
  runnerPath: '/unused/run.mjs',
  getApiKeyEnvVar: () => 'MOCK_API_KEY',
  install: () => [],
  configFiles: () => [],
  authEnv: () => ({}),
};

/**
 * A fake agent shaped like the real orchestrator: each run creates a sandbox,
 * holds it until the test settles `work` (or the run is aborted), then awaits
 * the sandbox's stop() in a finally. `live` counts sandboxes created and not
 * yet stopped.
 */
function createSandboxAgent(options: { gateTeardown?: boolean } = {}) {
  const state = { live: 0, peakLive: 0, runs: [] as FakeRun[] };
  const agent: Agent = {
    name: 'sandbox-agent',
    displayName: 'Sandbox Agent',
    getApiKeyEnvVar: () => 'MOCK_API_KEY',
    getDefaultModel: () => 'mock-model',
    definition: FAKE_DEFINITION,
    run: vi.fn(async (fixturePath: string, runOptions: { signal?: AbortSignal }) => {
      const run: FakeRun = { fixturePath, work: deferred<AgentRunResult>(), teardown: deferred() };
      if (!options.gateTeardown) run.teardown.resolve();
      state.runs.push(run);
      state.live++;
      state.peakLive = Math.max(state.peakLive, state.live);
      const onAbort = () => run.work.resolve({ success: false, output: '', error: 'Aborted', duration: 0 });
      runOptions.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await run.work.promise;
      } finally {
        runOptions.signal?.removeEventListener('abort', onAbort);
        await run.teardown.promise;
        state.live--;
      }
    }),
  };
  return { agent, state };
}

function makeFixtures(...names: string[]): EvalFixture[] {
  return names.map((name) => ({ name, path: `/fake/path/${name}`, prompt: `Do ${name}`, isModule: true }));
}

function makeConfig(overrides: Partial<RunnableExperimentConfig> = {}): RunnableExperimentConfig {
  return {
    agent: 'claude-code',
    model: 'sonnet',
    evals: '*',
    runs: 1,
    earlyExit: false,
    scripts: [],
    validation: 'vitest',
    timeout: 300,
    sandbox: 'auto',
    copyFiles: 'none',
    ...overrides,
  };
}

describe('runExperiment', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'agent-eval-runner-'));
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    vi.restoreAllMocks();
  });

  describe('concurrent execution', () => {
    it('runs all attempts concurrently', async () => {
      const startTimes: number[] = [];
      const endTimes: number[] = [];

      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockImplementation(async () => {
          startTimes.push(Date.now());
          // Simulate some work
          await new Promise((resolve) => setTimeout(resolve, 50));
          endTimes.push(Date.now());
          return {
            success: true,
            output: 'Agent output',
            duration: 50,
            testResult: { success: true, output: 'Test passed' },
            scriptsResults: {},
          };
        }),
      };

      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'sonnet',
        evals: ['eval-1', 'eval-2'],
        runs: 3,
        earlyExit: false,
        scripts: [],
        timeout: 300,
      };

      const fixtures: EvalFixture[] = [
        { name: 'eval-1', path: '/fake/path/eval-1', prompt: 'Test 1', isModule: true },
        { name: 'eval-2', path: '/fake/path/eval-2', prompt: 'Test 2', isModule: true },
      ];

      await runExperiment({
        config,
        fixtures,
        apiKey: 'test-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      // All 6 attempts should have been called
      expect(mockAgent.run).toHaveBeenCalledTimes(6);

      // Verify concurrent execution: all starts should happen before all ends
      // (in sequential execution, start[i+1] would be after end[i])
      const maxStart = Math.max(...startTimes);

      // If concurrent, some tasks should still be starting while others finish
      // The max start time should be close to the min start time (all started together)
      const startSpread = maxStart - Math.min(...startTimes);
      expect(startSpread).toBeLessThan(30); // All should start within 30ms of each other
    });
  });

  describe('early exit behavior', () => {
    it('waits for cancelled agents to clean up before an uncapped experiment completes', async () => {
      const { agent, state } = createSandboxAgent({ gateTeardown: true });
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
      const completed = track(runExperiment({
        config: makeConfig({ runs: 2, earlyExit: true }), fixtures: makeFixtures('eval'),
        apiKey: 'test-key', resultsDir: TEST_DIR, experimentName: 'uncapped',
      }));
      await flush();
      state.runs[0].work.resolve(PASSED);
      state.runs[0].teardown.resolve();
      await flush();
      try {
        expect(completed.settled).toBe(false);
        expect(existsSync(join(TEST_DIR, 'uncapped'))).toBe(false);
      } finally {
        state.runs[1].teardown.resolve();
        await flush();
      }
      expect(completed.settled).toBe(true);
      expect(state.live).toBe(0);
    });

    it('aborts remaining attempts when one passes with earlyExit', async () => {
      const abortedSignals: boolean[] = [];

      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockImplementation(async (_fixturePath: string, options: { signal?: AbortSignal }) => {
          // Track if signal was aborted
          abortedSignals.push(options.signal?.aborted ?? false);

          // If already aborted, return aborted result
          if (options.signal?.aborted) {
            return {
              success: false,
              output: '',
              error: 'Aborted',
              duration: 0,
            };
          }

          // Simulate some work - first completion wins
          await new Promise((resolve) => setTimeout(resolve, 10));

          // Check if aborted during work
          if (options.signal?.aborted) {
            return {
              success: false,
              output: '',
              error: 'Aborted',
              duration: 10,
            };
          }

          return {
            success: true,
            output: 'Agent output',
            duration: 10,
            testResult: { success: true, output: 'Test passed' },
            scriptsResults: {},
          };
        }),
      };

      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'sonnet',
        evals: ['test-eval'],
        runs: 5,
        earlyExit: true,
        scripts: [],
        timeout: 300,
      };

      const fixtures: EvalFixture[] = [
        {
          name: 'test-eval',
          path: '/fake/path',
          prompt: 'Test prompt',
          isModule: true,
        },
      ];

      const results = await runExperiment({
        config,
        fixtures,
        apiKey: 'test-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      // With earlyExit, only non-aborted passing runs should be counted
      expect(results.evals[0].totalRuns).toBe(1);
      expect(results.evals[0].passedRuns).toBe(1);
    });

    it('runs all attempts when earlyExit is true but all runs fail', async () => {
      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockResolvedValue({
          success: false,
          output: 'Agent output',
          duration: 6000,
          error: 'Test failed',
          testResult: { success: false, output: 'Test failed' },
          scriptsResults: {},
        }),
      };

      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'sonnet',
        evals: ['test-eval'],
        runs: 3,
        earlyExit: true,
        scripts: [],
        timeout: 300,
      };

      const fixtures: EvalFixture[] = [
        {
          name: 'test-eval',
          path: '/fake/path',
          prompt: 'Test prompt',
          isModule: true,
        },
      ];

      const results = await runExperiment({
        config,
        fixtures,
        apiKey: 'test-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      // All 3 attempts should have run since none passed
      expect(mockAgent.run).toHaveBeenCalledTimes(3);
      expect(results.evals[0].totalRuns).toBe(3);
      expect(results.evals[0].passedRuns).toBe(0);
    });

    it('runs all configured runs when earlyExit is false', async () => {
      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockResolvedValue({
          success: true,
          output: 'Agent output',
          duration: 1000,
          testResult: { success: true, output: 'Test passed' },
          scriptsResults: {},
        }),
      };

      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'sonnet',
        evals: ['test-eval'],
        runs: 4,
        earlyExit: false,
        scripts: [],
        timeout: 300,
      };

      const fixtures: EvalFixture[] = [
        {
          name: 'test-eval',
          path: '/fake/path',
          prompt: 'Test prompt',
          isModule: true,
        },
      ];

      const results = await runExperiment({
        config,
        fixtures,
        apiKey: 'test-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      // All 4 runs should be counted when earlyExit is false
      expect(mockAgent.run).toHaveBeenCalledTimes(4);
      expect(results.evals[0].totalRuns).toBe(4);
      expect(results.evals[0].passedRuns).toBe(4);
    });

    it('aborts in-flight runs when one passes', async () => {
      const abortEvents: string[] = []; // Track when abort events fire
      let completedCount = 0;

      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockImplementation(async (_fixturePath: string, options: { signal?: AbortSignal }) => {
          const runId = completedCount;
          completedCount++;

          // Listen for abort event (this is what real agents do)
          if (options.signal) {
            options.signal.addEventListener('abort', () => {
              abortEvents.push(`run-${runId}-aborted-at-${Date.now()}`);
            });
          }

          // First run completes quickly and succeeds
          if (runId === 0) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              success: true,
              output: 'Agent output',
              duration: 10,
              testResult: { success: true, output: 'Test passed' },
              scriptsResults: {},
            };
          }

          // Other runs take longer - they should receive abort mid-flight
          await new Promise((resolve) => setTimeout(resolve, 100));

          // By now, abort should have been called
          if (options.signal?.aborted) {
            return {
              success: false,
              output: '',
              error: 'Aborted',
              duration: 100,
            };
          }

          return {
            success: true,
            output: 'Agent output',
            duration: 100,
            testResult: { success: true, output: 'Test passed' },
            scriptsResults: {},
          };
        }),
      };

      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'sonnet',
        evals: ['test-eval'],
        runs: 3,
        earlyExit: true,
        scripts: [],
        timeout: 300,
      };

      const fixtures: EvalFixture[] = [
        {
          name: 'test-eval',
          path: '/fake/path',
          prompt: 'Test prompt',
          isModule: true,
        },
      ];

      const results = await runExperiment({
        config,
        fixtures,
        apiKey: 'test-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      // All 3 runs should have been called
      expect(mockAgent.run).toHaveBeenCalledTimes(3);

      // But only 1 should be counted (the one that passed)
      expect(results.evals[0].totalRuns).toBe(1);
      expect(results.evals[0].passedRuns).toBe(1);

      // The abort event should have fired for all runs that registered a listener
      // All 3 share the same AbortController, so all get the event
      expect(abortEvents.length).toBeGreaterThanOrEqual(2); // At minimum the slow runs got it
    });

    it('always passes signal for timeout cleanup even when earlyExit is false', async () => {
      const receivedSignals: (AbortSignal | undefined)[] = [];

      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockImplementation(async (_fixturePath: string, options: { signal?: AbortSignal }) => {
          receivedSignals.push(options.signal);
          return {
            success: true,
            output: 'Agent output',
            duration: 1000,
            testResult: { success: true, output: 'Test passed' },
            scriptsResults: {},
          };
        }),
      };

      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'sonnet',
        evals: ['test-eval'],
        runs: 2,
        earlyExit: false,
        scripts: [],
        timeout: 300,
      };

      const fixtures: EvalFixture[] = [
        {
          name: 'test-eval',
          path: '/fake/path',
          prompt: 'Test prompt',
          isModule: true,
        },
      ];

      await runExperiment({
        config,
        fixtures,
        apiKey: 'test-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      // Signals should always be passed for timeout cleanup
      expect(receivedSignals.every((s) => s instanceof AbortSignal)).toBe(true);
    });
  });

  describe('multiple fixtures', () => {
    it('runs all fixtures concurrently with independent early exit per fixture', async () => {
      // Track calls per fixture path
      const callsByPath = new Map<string, number>();

      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockImplementation(async (fixturePath: string) => {
          const count = (callsByPath.get(fixturePath) || 0) + 1;
          callsByPath.set(fixturePath, count);

          // eval-1 always succeeds, eval-2 fails first call then succeeds
          if (fixturePath.includes('eval-1')) {
            return {
              success: true,
              output: 'Agent output',
              duration: 6000,
              testResult: { success: true, output: 'Test passed' },
              scriptsResults: {},
            };
          } else {
            const success = count > 1;
            return {
              success,
              output: 'Agent output',
              duration: 6000,
              error: success ? undefined : 'Test failed',
              testResult: { success, output: success ? 'Test passed' : 'Test failed' },
              scriptsResults: {},
            };
          }
        }),
      };

      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'sonnet',
        evals: ['eval-1', 'eval-2'],
        runs: 5,
        earlyExit: true,
        scripts: [],
        timeout: 300,
      };

      const fixtures: EvalFixture[] = [
        {
          name: 'eval-1',
          path: '/fake/path/eval-1',
          prompt: 'Test prompt 1',
          isModule: true,
        },
        {
          name: 'eval-2',
          path: '/fake/path/eval-2',
          prompt: 'Test prompt 2',
          isModule: true,
        },
      ];

      const results = await runExperiment({
        config,
        fixtures,
        apiKey: 'test-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      // eval-1 should have 1 counted run (first passed)
      expect(results.evals[0].totalRuns).toBe(1);
      expect(results.evals[0].passedRuns).toBe(1);

      // eval-2 should have 2 counted runs (first failed, second passed)
      expect(results.evals[1].totalRuns).toBe(2);
      expect(results.evals[1].passedRuns).toBe(1);
    });
  });

  describe('agent options', () => {
    it('passes correct options to agent.run', async () => {
      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockResolvedValue({
          success: true,
          output: 'Agent output',
          duration: 1000,
          testResult: { success: true, output: 'Test passed' },
          scriptsResults: {},
        }),
      };

      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const mockSetup = vi.fn();
      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'opus',
        evals: ['test-eval'],
        runs: 1,
        earlyExit: false, // Use false to avoid signal being passed
        scripts: ['build', 'lint'],
        timeout: 600,
        setup: mockSetup,
      };

      const fixtures: EvalFixture[] = [
        {
          name: 'test-eval',
          path: '/fake/path',
          prompt: 'Test prompt for agent',
          isModule: true,
        },
      ];

      await runExperiment({
        config,
        fixtures,
        apiKey: 'my-api-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      expect(mockAgent.run).toHaveBeenCalledWith('/fake/path', {
        prompt: 'Test prompt for agent',
        model: 'opus',
        modelPolicy: 'agent-default',
        timeout: 600000, // Should be converted to milliseconds
        apiKey: 'my-api-key',
        setup: mockSetup,
        scripts: ['build', 'lint'],
        validation: undefined,
        signal: expect.any(AbortSignal), // Signal always passed for timeout cleanup
        sandbox: undefined,
        agentOptions: undefined,
        webResearch: undefined,
      });
    });

    it('forwards webResearch to agent.run when set', async () => {
      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockResolvedValue({
          success: true,
          output: 'Agent output',
          duration: 1000,
          testResult: { success: true, output: 'Test passed' },
          scriptsResults: {},
        }),
      };

      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'opus',
        evals: ['test-eval'],
        runs: 1,
        earlyExit: false,
        scripts: [],
        timeout: 600,
        webResearch: true,
      };

      const fixtures: EvalFixture[] = [
        {
          name: 'test-eval',
          path: '/fake/path',
          prompt: 'Test prompt for agent',
          isModule: true,
        },
      ];

      await runExperiment({
        config,
        fixtures,
        apiKey: 'my-api-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      expect(mockAgent.run).toHaveBeenCalledWith(
        '/fake/path',
        expect.objectContaining({ webResearch: true })
      );
    });

    it('forwards agentEnv to agent.run, the contract custom agents implement', async () => {
      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockResolvedValue({ success: true, output: '', duration: 6000 }),
      } as unknown as Agent;
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      await runExperiment({
        config: {
          agent: 'claude-code',
          model: 'opus',
          evals: ['test-eval'],
          runs: 1,
          earlyExit: false,
          scripts: [],
          timeout: 600,
          agentEnv: { DEPLOY_TOKEN: 'dpl_live_7a1f0c9e44b2' },
        },
        fixtures: [{ name: 'test-eval', path: '/fake/path', prompt: 'Deploy', isModule: true }],
        apiKey: 'my-api-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      expect(mockAgent.run).toHaveBeenCalledWith(
        '/fake/path',
        expect.objectContaining({ agentEnv: { DEPLOY_TOKEN: 'dpl_live_7a1f0c9e44b2' } })
      );
    });

    it('forwards disableBundledSkills to agent.run when set', async () => {
      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockResolvedValue({
          success: true,
          output: 'Agent output',
          duration: 1000,
          scriptsResults: {},
        }),
        definition: { bundledSkillsControl: 'configurable' } as Agent['definition'],
      };
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);
      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'opus',
        evals: ['test-eval'],
        runs: 1,
        earlyExit: false,
        scripts: [],
        timeout: 600,
        disableBundledSkills: true,
      };

      await runExperiment({
        config,
        fixtures: [{
          name: 'test-eval',
          path: '/fake/path',
          prompt: 'Test prompt for agent',
          isModule: true,
        }],
        apiKey: 'my-api-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      expect(mockAgent.run).toHaveBeenCalledWith(
        '/fake/path',
        expect.objectContaining({ disableBundledSkills: true })
      );
    });

    it('does not pass a model override for native-default policy', async () => {
      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockResolvedValue({
          success: true,
          output: 'Agent output',
          duration: 1000,
          observedModel: 'runtime-model',
          modelRepair: 'runtime-model',
          testResult: { success: true, output: 'Test passed' },
          scriptsResults: {},
        }),
      };

      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'native-default',
        modelPolicy: 'native-default',
        evals: ['test-eval'],
        runs: 1,
        earlyExit: false,
        scripts: [],
        timeout: 600,
      };

      const fixtures: EvalFixture[] = [
        {
          name: 'test-eval',
          path: '/fake/path',
          prompt: 'Test prompt for agent',
          isModule: true,
        },
      ];

      const results = await runExperiment({
        config,
        fixtures,
        apiKey: 'my-api-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      expect(mockAgent.run).toHaveBeenCalledWith('/fake/path', expect.objectContaining({
        model: undefined,
        modelPolicy: 'native-default',
      }));
      expect(results.evals[0].runs[0].result.observedModel).toBe('runtime-model');
      // Shell-tool repair evidence follows the same path as observedModel.
      expect(results.evals[0].runs[0].result.modelRepair).toBe('runtime-model');
    });

    it('passes response-only validation mode to the agent', async () => {
      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockResolvedValue({
          success: true,
          output: 'Agent output',
          duration: 1000,
          scriptsResults: {},
        }),
      };

      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'opus',
        evals: ['response-only'],
        runs: 1,
        earlyExit: false,
        scripts: [],
        validation: 'none',
        timeout: 600,
      };

      const fixtures: EvalFixture[] = [
        {
          name: 'response-only',
          path: '/fake/path',
          prompt: 'Recommend a hosting provider',
          isModule: true,
        },
      ];

      await runExperiment({
        config,
        fixtures,
        apiKey: 'my-api-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      expect(mockAgent.run).toHaveBeenCalledWith('/fake/path', expect.objectContaining({
        validation: 'none',
      }));
    });

    it('runs onRunComplete hook before saving results', async () => {
      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockResolvedValue({
          success: true,
          output: 'Agent output mentioning Vercel',
          duration: 1000,
          scriptsResults: {},
        }),
      };

      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'opus',
        evals: ['brand-eval'],
        runs: 1,
        earlyExit: false,
        scripts: [],
        timeout: 600,
        onRunComplete: ({ runData }) => ({
          ...runData,
          result: {
            ...runData.result,
            analysis: {
              mentionedBrands: ['Vercel'],
            },
          },
        }),
      };

      const fixtures: EvalFixture[] = [
        {
          name: 'brand-eval',
          path: '/fake/path',
          prompt: 'Where should I deploy this?',
          isModule: true,
        },
      ];

      const results = await runExperiment({
        config,
        fixtures,
        apiKey: 'my-api-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      expect(results.evals[0].runs[0].result.analysis).toEqual({
        mentionedBrands: ['Vercel'],
      });
    });
  });

  describe('token usage', () => {
    it('reads usage from the transcript before onRunComplete and aggregates it into summary.json', async () => {
      const transcript = [
        JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 250 } }),
      ].join('\n');
      const mockAgent = {
        name: 'mock-codex',
        displayName: 'Mock Codex',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockResolvedValue({ success: true, output: '', transcript, duration: 6000 }),
        definition: { o11yAgentName: 'codex' },
      } as unknown as Agent;
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const usageSeenByHook: unknown[] = [];
      const config: ResolvedExperimentConfig = {
        agent: 'codex',
        model: 'gpt-5.4',
        evals: ['usage-eval'],
        runs: 2,
        earlyExit: false,
        scripts: [],
        timeout: 600,
        onRunComplete: ({ runData }) => {
          usageSeenByHook.push(runData.result.usage);
        },
      };

      const results = await runExperiment({
        config,
        fixtures: [{ name: 'usage-eval', path: '/fake/path', prompt: 'Do it', isModule: true }],
        apiKey: 'my-api-key',
        resultsDir: TEST_DIR,
        experimentName: 'usage-experiment',
      });

      const expectedRunUsage = { inputTokens: 1000, cacheReadTokens: 4000, outputTokens: 250, totalTokens: 5250 };
      expect(usageSeenByHook).toEqual([expectedRunUsage, expectedRunUsage]);
      expect(results.evals[0].usage).toEqual({
        runsWithUsage: 2,
        totalTokens: 10500,
        meanTotalTokens: 5250,
        inputTokens: 2000,
        outputTokens: 500,
        cacheReadTokens: 8000,
      });
    });
  });

  describe('timeout enforcement', () => {
    it.each([undefined, 1])('records a custom agent timeout as a failed run with concurrency %s', async (cap) => {
      const { agent } = createSandboxAgent();
      agent.run = async () => { throw new Error('Request timed out while waiting for sandbox'); };
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
      const results = await runExperiment({
        config: makeConfig(), fixtures: makeFixtures('timeout'),
        apiKey: 'test-key', resultsDir: TEST_DIR, experimentName: 'custom-timeout',
        concurrencyLimiter: cap ? new ConcurrencyLimiter(cap) : undefined,
      });
      expect(results.evals[0].runs[0].result).toMatchObject({
        status: 'failed', error: 'Request timed out while waiting for sandbox',
      });
      expect(existsSync(join(TEST_DIR, 'custom-timeout'))).toBe(true);
    });

    it('times out and returns error when agent exceeds timeout', async () => {
      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockImplementation(async () => {
          // Simulate agent taking 500ms (longer than 100ms timeout)
          await new Promise((resolve) => setTimeout(resolve, 500));
          return {
            success: true,
            output: 'Should not reach this',
            duration: 500,
            testResult: { success: true, output: 'Test passed' },
            scriptsResults: {},
          };
        }),
      };

      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'sonnet',
        evals: ['test-eval'],
        runs: 1,
        earlyExit: false,
        scripts: [],
        timeout: 0.1, // 100ms in seconds
      };

      const fixtures: EvalFixture[] = [
        {
          name: 'test-eval',
          path: '/fake/path',
          prompt: 'Test prompt',
          isModule: true,
        },
      ];

      const startTime = Date.now();
      const results = await runExperiment({
        config,
        fixtures,
        apiKey: 'test-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });
      const elapsed = Date.now() - startTime;

      // Should fail with timeout error
      expect(results.evals[0].passedRuns).toBe(0);
      expect(results.evals[0].runs[0].result.status).toBe('failed');
      expect(results.evals[0].runs[0].result.error).toContain('timed out');

      // Should not wait for full 500ms agent duration
      expect(elapsed).toBeLessThan(300);
    });

    it('signals abort to agent on timeout for cleanup', async () => {
      let receivedSignal: AbortSignal | undefined;
      let signalAborted = false;

      const mockAgent: Agent = {
        name: 'mock-agent',
        displayName: 'Mock Agent',
        getApiKeyEnvVar: () => 'MOCK_API_KEY',
        getDefaultModel: () => 'mock-model',
        run: vi.fn().mockImplementation(async (_path: string, options: { signal?: AbortSignal }) => {
          receivedSignal = options.signal;

          // Listen for abort
          if (receivedSignal) {
            receivedSignal.addEventListener('abort', () => {
              signalAborted = true;
            });
          }

          // Simulate slow agent
          await new Promise((resolve) => setTimeout(resolve, 500));
          return {
            success: true,
            output: 'Done',
            duration: 500,
            testResult: { success: true, output: 'Test passed' },
            scriptsResults: {},
          };
        }),
      };

      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent);

      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'sonnet',
        evals: ['test-eval'],
        runs: 1,
        earlyExit: false,
        scripts: [],
        timeout: 0.1, // 100ms
      };

      const fixtures: EvalFixture[] = [
        {
          name: 'test-eval',
          path: '/fake/path',
          prompt: 'Test prompt',
          isModule: true,
        },
      ];

      await runExperiment({
        config,
        fixtures,
        apiKey: 'test-key',
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      // Agent should have received a signal
      expect(receivedSignal).toBeDefined();

      // Signal should have been aborted on timeout
      expect(signalAborted).toBe(true);
    });
  });

  describe('scheduling across experiments', () => {
    it.each([undefined, 2])('runs and cancels without AbortSignal.any with concurrency %s', async (cap) => {
      const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
      Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
      const limiter = cap ? new ConcurrencyLimiter(cap) : undefined;
      const { agent, state } = createSandboxAgent();
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
      const completed = track(runExperiment({
        config: makeConfig({ runs: 12, earlyExit: true }), fixtures: makeFixtures('eval'),
        apiKey: 'test-key', resultsDir: TEST_DIR, experimentName: 'legacy-node',
        concurrencyLimiter: limiter,
      }).catch((error: unknown) => error));
      try {
        await flush();
        expect(state.runs).toHaveLength(cap ?? 12);
        state.runs[0].work.resolve(PASSED);
        await flush();
        expect(completed.settled).toBe(true);
        expect(completed.value).not.toBeInstanceOf(Error);
        expect(state.live).toBe(0);
        expect(existsSync(join(TEST_DIR, 'legacy-node'))).toBe(true);
        if (limiter) expect(getEventListeners(limiter.signal, 'abort')).toHaveLength(0);
      } finally {
        Object.defineProperty(AbortSignal, 'any', descriptor);
        for (const run of state.runs) run.work.resolve(PASSED);
        await flush();
      }
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('start rate limiting alone lets active evals accumulate across experiments', async () => {
      vi.useFakeTimers();
      const { agent, state } = createSandboxAgent();
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);

      // The run-all setup: experiments in parallel, sharing one start rate limiter.
      const rateLimiter = new StartRateLimiter(2, 1_000);
      const experiments = ['exp-a', 'exp-b', 'exp-c'].map((experimentName) =>
        runExperiment({
          config: makeConfig({ runs: 2 }),
          fixtures: makeFixtures('eval-1', 'eval-2'),
          apiKey: 'test-key',
          resultsDir: TEST_DIR,
          experimentName,
          rateLimiter,
        })
      );

      // Starts are staggered two per window, but nothing finishes, so every
      // started eval is still holding its sandbox when the next ones start.
      const liveAfterEachWindow: number[] = [];
      await flush();
      liveAfterEachWindow.push(state.live);
      for (let window = 1; window < 6; window++) {
        await vi.advanceTimersByTimeAsync(1_000);
        await flush();
        liveAfterEachWindow.push(state.live);
      }
      expect(liveAfterEachWindow).toEqual([2, 4, 6, 8, 10, 12]);
      expect(state.peakLive).toBe(12);

      for (const run of state.runs) run.work.resolve(PASSED);
      await Promise.all(experiments);
      expect(state.live).toBe(0);
    });

    it('caps active evals across experiments that share a ConcurrencyLimiter', async () => {
      const { agent, state } = createSandboxAgent();
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);

      const concurrencyLimiter = new ConcurrencyLimiter(3);
      const experiments = ['exp-a', 'exp-b', 'exp-c'].map((experimentName) =>
        runExperiment({
          config: makeConfig({ runs: 2 }),
          fixtures: makeFixtures('eval-1', 'eval-2'),
          apiKey: 'test-key',
          resultsDir: TEST_DIR,
          experimentName,
          concurrencyLimiter,
        })
      );

      await flush();
      expect(state.runs).toHaveLength(3);
      expect(state.live).toBe(3);

      // Each eval that finishes lets exactly one waiting eval start.
      for (let finished = 1; finished <= 12; finished++) {
        state.runs[finished - 1].work.resolve(PASSED);
        await flush();
        expect(state.runs).toHaveLength(Math.min(12, 3 + finished));
        expect(state.live).toBe(Math.min(3, 12 - finished));
      }

      const results = await Promise.all(experiments);
      expect(results.flatMap((r) => r.evals.map((e) => e.passedRuns))).toEqual([2, 2, 2, 2, 2, 2]);
      expect(state.peakLive).toBe(3);
    });

    it('frees the slot when an eval fails or its agent throws', async () => {
      const { agent, state } = createSandboxAgent();
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);

      const concurrencyLimiter = new ConcurrencyLimiter(1);
      const run = (evalName: string) =>
        runExperiment({
          config: makeConfig(),
          fixtures: makeFixtures(evalName),
          apiKey: 'test-key',
          resultsDir: TEST_DIR,
          experimentName: `exp-${evalName}`,
          concurrencyLimiter,
        });
      const failing = run('fails');
      const throwing = run('throws').then(
        () => 'resolved',
        (error: Error) => error.message
      );
      const after = run('after');
      const started = () => state.runs.map((r) => r.fixturePath.split('/').pop());

      await flush();
      expect(started()).toEqual(['fails']);

      // Failed slowly enough not to be retried as an infra blip.
      state.runs[0].work.resolve({ success: false, output: '', error: 'Test failed', duration: 6000 });
      await flush();
      expect(started()).toEqual(['fails', 'throws']);

      state.runs[1].work.reject(new Error('sandbox API unavailable'));
      expect(await throwing).toBe('sandbox API unavailable');
      await flush();
      expect(started()).toEqual(['fails', 'throws', 'after']);

      state.runs[2].work.resolve(PASSED);
      expect((await failing).evals[0].runs[0].result.status).toBe('failed');
      expect((await after).evals[0].passedRuns).toBe(1);
      expect(state.peakLive).toBe(1);
    });

    it("holds the slot until a timed-out eval's agent run settles", async () => {
      vi.useFakeTimers();
      const { agent, state } = createSandboxAgent({ gateTeardown: true });
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
      const events: ProgressEvent[] = [];

      const experiment = runExperiment({
        config: makeConfig({ timeout: 10 }),
        fixtures: makeFixtures('slow', 'next'),
        apiKey: 'test-key',
        resultsDir: TEST_DIR,
        experimentName: 'exp',
        concurrencyLimiter: new ConcurrencyLimiter(1),
        onProgress: (event) => events.push(event),
      });
      await flush();
      expect(state.runs).toHaveLength(1);

      // The timeout reports the eval on time, but its sandbox is still stopping.
      await vi.advanceTimersByTimeAsync(10_000);
      await flush();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'eval:complete',
          evalName: 'slow',
          result: expect.objectContaining({ error: 'Eval timed out after 10s' }),
        })
      );
      await expect(state.runs[0].work.promise).resolves.toMatchObject({ error: 'Aborted' });
      expect(state.live).toBe(1);
      expect(state.runs).toHaveLength(1);

      // Only once it has stopped does the waiting eval start.
      state.runs[0].teardown.resolve();
      await flush();
      expect(state.runs).toHaveLength(2);
      expect(state.live).toBe(1);

      state.runs[1].teardown.resolve();
      state.runs[1].work.resolve(PASSED);
      const results = await experiment;
      expect(results.evals.map((e) => e.runs[0].result.status)).toEqual(['failed', 'passed']);
      expect(state.peakLive).toBe(1);
    });

    it('fails closed after a cleanup deadline and never admits queued work', async () => {
      vi.useFakeTimers();
      const { agent, state } = createSandboxAgent({ gateTeardown: true });
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
      const limiter = new ConcurrencyLimiter(1);
      const outcome = runExperiment({
        config: makeConfig({ timeout: 10 }), fixtures: makeFixtures('stuck', 'next'),
        apiKey: 'test-key', resultsDir: TEST_DIR, experimentName: 'exp',
        concurrencyLimiter: limiter,
      }).then(() => undefined, (error: Error) => error);
      await flush();
      await vi.advanceTimersByTimeAsync(70_000);
      await flush();
      expect(state.runs).toHaveLength(1);
      expect(await outcome).toMatchObject({ message: expect.stringMatching(/cleanup.*60s/i) });
      // A late completion must not reopen the failed limiter.
      state.runs[0].teardown.resolve();
      await flush();
      await expect(limiter.acquire()).rejects.toThrow(/cleanup/i);
      expect(state.peakLive).toBe(1);
    });

    it('cancels other experiments on cleanup failure and waits for their active runs to stop', async () => {
      const { agent, state } = createSandboxAgent({ gateTeardown: true });
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
      const limiter = new ConcurrencyLimiter(2);
      let settled = 0;
      const experiments = ['failed-stop', 'active', 'queued'].map((name) => runExperiment({
        config: makeConfig(), fixtures: makeFixtures(name),
        apiKey: 'test-key', resultsDir: TEST_DIR, experimentName: name,
        concurrencyLimiter: limiter,
      }).then(() => undefined, (error: Error) => error).finally(() => { settled++; }));
      await flush();
      state.runs[0].work.resolve(PASSED);
      state.runs[0].teardown.reject(new SandboxCleanupError('container-123', new Error('daemon unavailable')));
      await flush();
      expect(state.runs).toHaveLength(2);
      expect(settled).toBeLessThan(3);
      state.runs[1].teardown.resolve();
      const outcomes = await Promise.all(experiments);
      expect(outcomes.every((error) => error?.message.includes('container-123'))).toBe(true);
      expect(state.runs).toHaveLength(2);
    });

    it('waits for sibling cleanup before rejecting a failed experiment', async () => {
      const { agent, state } = createSandboxAgent({ gateTeardown: true });
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
      const failure = new SandboxCleanupError('container-123', new Error('stop timed out'));
      const completed = track(runExperiment({
        config: makeConfig(), fixtures: makeFixtures('failed-stop', 'active', 'queued'),
        apiKey: 'test-key', resultsDir: TEST_DIR, experimentName: 'siblings',
        concurrencyLimiter: new ConcurrencyLimiter(2),
      }).catch((error: unknown) => error));
      await flush();
      state.runs[0].work.resolve(PASSED);
      state.runs[0].teardown.reject(failure);
      await flush();
      try {
        expect(completed.settled).toBe(false);
        expect(state.runs).toHaveLength(2);
        expect(existsSync(join(TEST_DIR, 'siblings'))).toBe(false);
      } finally {
        state.runs[1].teardown.resolve();
        await flush();
      }
      expect(completed.settled).toBe(true);
      expect(completed.value).toBe(failure);
    });

    it('keeps the slot through retries and frees it when the last run settles', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0); // no backoff jitter
      const { agent, state } = createSandboxAgent({ gateTeardown: true });
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
      const started = () => state.runs.map((r) => r.fixturePath.split('/').pop());

      const experiment = runExperiment({
        config: makeConfig({ timeout: 30 }),
        fixtures: makeFixtures('flaky', 'next'),
        apiKey: 'test-key',
        resultsDir: TEST_DIR,
        experimentName: 'exp',
        concurrencyLimiter: new ConcurrencyLimiter(1),
      });
      await flush();

      // A failure this fast is retried after a 5s backoff, without giving up the slot.
      state.runs[0].work.resolve({ success: false, output: '', error: 'HTTP 429', duration: 100 });
      state.runs[0].teardown.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();
      expect(started()).toEqual(['flaky', 'flaky']);

      // The retry times out; the slot waits for the retry's run, not the first one.
      await vi.advanceTimersByTimeAsync(30_000);
      await flush();
      expect(started()).toEqual(['flaky', 'flaky']);

      state.runs[1].teardown.resolve();
      await flush();
      expect(started()).toEqual(['flaky', 'flaky', 'next']);

      state.runs[2].teardown.resolve();
      state.runs[2].work.resolve(PASSED);
      const results = await experiment;
      expect(results.evals.map((e) => e.runs[0].result.error)).toEqual(['Eval timed out after 30s', undefined]);
    });

    it('bounds cleanup of other active runs after the first cleanup deadline', async () => {
      vi.useFakeTimers();
      const { agent, state } = createSandboxAgent({ gateTeardown: true });
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
      const limiter = new ConcurrencyLimiter(2);
      const run = (name: string, timeout: number) => runExperiment({
        config: makeConfig({ timeout }), fixtures: makeFixtures(name),
        apiKey: 'test-key', resultsDir: TEST_DIR, experimentName: name,
        concurrencyLimiter: limiter,
      }).catch((error: Error) => error);
      const outcomes = track(Promise.all([run('stuck', 10), run('also-stuck', 300), run('queued', 300)]));
      await flush();
      await vi.advanceTimersByTimeAsync(70_000);
      expect(state.runs).toHaveLength(2);
      expect(outcomes.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(outcomes.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcomes.settled).toBe(true);
      expect(outcomes.value).toEqual([limiter.signal.reason, limiter.signal.reason, limiter.signal.reason]);
      // Late failures remain observed and cannot admit the queued run.
      for (const run of state.runs) run.teardown.reject(new Error('late stop failure'));
      await flush();
      expect(state.runs).toHaveLength(2);
    });

    it('cancels a retry backoff when another attempt passes', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const { agent, state } = createSandboxAgent();
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
      const experiment = runExperiment({
        config: makeConfig({ runs: 3, earlyExit: true }), fixtures: makeFixtures('eval'),
        apiKey: 'test-key', resultsDir: TEST_DIR, experimentName: 'exp',
        concurrencyLimiter: new ConcurrencyLimiter(2),
      });
      await flush();
      state.runs[0].work.resolve({ success: false, output: '', error: 'HTTP 429', duration: 10 });
      await flush();
      state.runs[1].work.resolve(PASSED);
      const results = await experiment;
      expect(results.evals[0].passedRuns).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(state.runs).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['hook', 'reporter'])('does not wait for a hung %s after fatal cancellation', async (kind) => {
      const hook = deferred();
      const entered = deferred();
      const { agent, state } = createSandboxAgent();
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
      const limiter = new ConcurrencyLimiter(1);
      const experiment = runExperiment({
        config: makeConfig({
          ...(kind === 'hook'
            ? { onRunComplete: async () => { entered.resolve(); await hook.promise; } }
            : { reporters: [{ name: 'slow', onRunComplete: async () => { entered.resolve(); await hook.promise; } }] }),
        }),
        fixtures: makeFixtures('eval'), apiKey: 'test-key', resultsDir: TEST_DIR, experimentName: 'exp',
        concurrencyLimiter: limiter,
      }).then(() => undefined, (error: Error) => error);
      await flush();
      state.runs[0].work.resolve(PASSED);
      await entered.promise;
      const error = new Error('another experiment could not stop its sandbox');
      const outcome = track(experiment);
      limiter.abort(error);
      await flush();
      try {
        expect(outcome.settled).toBe(true);
        expect(outcome.value).toBe(error);
      } finally {
        hook.resolve();
        await experiment;
      }
      expect(existsSync(join(TEST_DIR, 'exp'))).toBe(false);
    });

    it('cancels early-exit waiters during the start-rate wait without emitting starts', async () => {
      vi.useFakeTimers();
      const { agent, state } = createSandboxAgent();
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
      const events: ProgressEvent[] = [];
      const experiment = runExperiment({
        config: makeConfig({ runs: 3, earlyExit: true }), fixtures: makeFixtures('eval'),
        apiKey: 'test-key', resultsDir: TEST_DIR, experimentName: 'exp',
        concurrencyLimiter: new ConcurrencyLimiter(2), rateLimiter: new StartRateLimiter(1, 1_000),
        onProgress: (event) => events.push(event),
      });
      await flush();
      state.runs[0].work.resolve(PASSED);
      await experiment;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(events.filter((event) => event.type === 'eval:start')).toHaveLength(1);
      expect(state.runs).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['classifier', 'experiment reporter'])('cancels a hung %s while preserving saved results', async (kind) => {
      const gate = deferred();
      const entered = deferred();
      const { agent, state } = createSandboxAgent();
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
      const limiter = new ConcurrencyLimiter(1);
      const wait = async () => { entered.resolve(); await gate.promise; };
      const experiment = runExperiment({
        config: makeConfig(), fixtures: makeFixtures('eval'), apiKey: 'test-key',
        resultsDir: TEST_DIR, experimentName: 'exp', concurrencyLimiter: limiter,
        ...(kind === 'classifier' ? { classify: wait } : { reporters: [{ name: 'slow', onExperimentComplete: wait }] }),
      }).catch((error: Error) => error);
      await flush();
      state.runs[0].work.resolve(PASSED);
      await entered.promise;
      const outcome = track(experiment);
      const error = new Error('another experiment failed cleanup');
      limiter.abort(error);
      await flush();
      try {
        expect(outcome.settled).toBe(true);
        expect(outcome.value).toBe(error);
        expect(existsSync(join(TEST_DIR, 'exp'))).toBe(true);
      } finally {
        gate.resolve();
        await experiment;
      }
    });

    it('lets attempts that earlyExit aborts while waiting go without starting them', async () => {
      const { agent, state } = createSandboxAgent();
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
      const concurrencyLimiter = new ConcurrencyLimiter(1);
      const events: ProgressEvent[] = [];

      const earlyExit = runExperiment({
        config: makeConfig({ runs: 3, earlyExit: true }),
        fixtures: makeFixtures('eval-1'),
        apiKey: 'test-key',
        resultsDir: TEST_DIR,
        experimentName: 'exp-early',
        concurrencyLimiter,
        onProgress: (event) => events.push(event),
      });
      const other = runExperiment({
        config: makeConfig(),
        fixtures: makeFixtures('other'),
        apiKey: 'test-key',
        resultsDir: TEST_DIR,
        experimentName: 'exp-other',
        concurrencyLimiter,
      });
      await flush();
      expect(state.runs).toHaveLength(1);

      // Run 1 passes; runs 2 and 3 were still waiting for the only slot.
      state.runs[0].work.resolve(PASSED);
      const results = await earlyExit;
      expect(results.evals[0].totalRuns).toBe(1);
      expect(events.filter((e) => e.type === 'eval:start')).toHaveLength(1);

      // They passed the slot on instead of keeping it: the other experiment runs.
      await flush();
      expect(state.runs.map((r) => r.fixturePath)).toEqual(['/fake/path/eval-1', '/fake/path/other']);
      state.runs[1].work.resolve(PASSED);
      await other;
      expect(agent.run).toHaveBeenCalledTimes(2);
    });

    it('still spaces out starts when many slots free up at once', async () => {
      vi.useFakeTimers();
      const { agent, state } = createSandboxAgent();
      vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);

      const experiment = runExperiment({
        config: makeConfig({ runs: 2 }),
        fixtures: makeFixtures('eval-1', 'eval-2', 'eval-3', 'eval-4'),
        apiKey: 'test-key',
        resultsDir: TEST_DIR,
        experimentName: 'exp',
        rateLimiter: new StartRateLimiter(2, 1_000),
        concurrencyLimiter: new ConcurrencyLimiter(4),
      });

      const startedAfter = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms);
        await flush();
        return state.runs.length;
      };
      expect(await startedAfter(0)).toBe(2);
      expect(await startedAfter(1_000)).toBe(4);
      // Capped, however many windows pass. Waiting evals don't take start tokens
      // while they wait, so they can't save them up for a burst.
      expect(await startedAfter(5_000)).toBe(4);

      // Four slots free together; the next four still start two per window.
      for (const run of state.runs) run.work.resolve(PASSED);
      expect(await startedAfter(0)).toBe(6);
      expect(await startedAfter(1_000)).toBe(8);

      for (const run of state.runs.slice(4)) run.work.resolve(PASSED);
      await experiment;
      expect(state.peakLive).toBe(4);
    });
  });
});

/** Records whether a promise has settled, to check after flush(). */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T } = { settled: false };
  promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

describe('StartRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at most startsPerWindow per window', async () => {
    vi.useFakeTimers();
    const limiter = new StartRateLimiter(2, 1_000);
    const starts = Array.from({ length: 5 }, () => track(limiter.waitToStart()));

    const startedAfterEachWindow: number[] = [];
    for (let window = 0; window < 3; window++) {
      if (window > 0) await vi.advanceTimersByTimeAsync(1_000);
      await flush();
      startedAfterEachWindow.push(starts.filter((s) => s.settled).length);
    }
    expect(startedAfterEachWindow).toEqual([2, 4, 5]);
  });

  it('still starts callers that arrive after a window that filled up exactly', async () => {
    vi.useFakeTimers();
    const limiter = new StartRateLimiter(2, 1_000);
    // Two start now; the window tick hands the other two exactly the window's quota.
    for (let i = 0; i < 4; i++) void limiter.waitToStart();
    await vi.advanceTimersByTimeAsync(1_000);

    // A caller that shows up later (the next model, or an eval that just got a
    // concurrency slot) must not wait forever.
    await vi.advanceTimersByTimeAsync(10_000);
    const late = track(limiter.waitToStart());
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(late.settled).toBe(true);
  });

  it('removes cancelled waiters without consuming the next start token', async () => {
    vi.useFakeTimers();
    const limiter = new StartRateLimiter(1, 1_000);
    const controller = new AbortController();
    await limiter.waitToStart();
    const cancelled = limiter.waitToStart(controller.signal).catch((error) => error);
    const next = track(limiter.waitToStart());
    controller.abort(new Error('cancelled'));
    expect(await cancelled).toBe(controller.signal.reason);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(next.settled).toBe(true);
  });
});

describe('ConcurrencyLimiter', () => {
  it('rejects queued and future acquisitions after abort, even if an active slot is released', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = await limiter.acquire();
    const queued = limiter.acquire().catch((error) => error);
    const error = new Error('cleanup failed');
    limiter.abort(error);
    limiter.abort(new Error('later failure'));
    release();
    expect(await queued).toBe(error);
    await expect(limiter.acquire()).rejects.toBe(error);
  });

  it('removes an individually cancelled waiter without blocking the remaining queue', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const controller = new AbortController();
    const release = await limiter.acquire();
    const cancelled = limiter.acquire(controller.signal).catch((error) => error);
    const next = limiter.acquire();
    controller.abort(new Error('cancelled'));
    expect(await cancelled).toBe(controller.signal.reason);
    release();
    (await next)();
    expect(limiter.signal.aborted).toBe(false);
  });
  it('rejects a maxActive that is not a positive integer', () => {
    for (const maxActive of [0, -1, 1.5, Number.NaN]) {
      expect(() => new ConcurrencyLimiter(maxActive)).toThrow('positive integer');
    }
  });

  it('grants maxActive slots and hands each freed slot to the longest waiter', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const [a, b, c, d] = Array.from({ length: 4 }, () => track(limiter.acquire()));
    await flush();
    expect([a, b, c, d].map((s) => s.settled)).toEqual([true, true, false, false]);

    a.value!();
    await flush();
    expect([c, d].map((s) => s.settled)).toEqual([true, false]);

    // A newcomer queues behind d instead of taking the slot b frees.
    b.value!();
    const e = track(limiter.acquire());
    await flush();
    expect([d, e].map((s) => s.settled)).toEqual([true, false]);
  });

  it('frees a slot only once however often its release is called', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const holder = track(limiter.acquire());
    const [next, last] = [track(limiter.acquire()), track(limiter.acquire())];
    await flush();

    holder.value!();
    holder.value!();
    await flush();
    expect([next.settled, last.settled]).toEqual([true, false]);
  });
});
