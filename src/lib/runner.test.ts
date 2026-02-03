import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { runExperiment } from './runner.js';
import type { ResolvedExperimentConfig, EvalFixture } from './types.js';
import type { Agent } from './agents/types.js';
import * as agentsIndex from './agents/index.js';

const TEST_DIR = '/tmp/eval-framework-runner-test';

describe('runExperiment', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
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
          duration: 1000,
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
              duration: 1000,
              testResult: { success: true, output: 'Test passed' },
              scriptsResults: {},
            };
          } else {
            const success = count > 1;
            return {
              success,
              output: 'Agent output',
              duration: 1000,
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
        timeout: 600000, // Should be converted to milliseconds
        apiKey: 'my-api-key',
        setup: mockSetup,
        scripts: ['build', 'lint'],
        signal: expect.any(AbortSignal), // Signal always passed for timeout cleanup
        sandbox: undefined,
      });
    });
  });

  describe('timeout enforcement', () => {
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
});
