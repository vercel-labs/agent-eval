/**
 * Experiment runner - orchestrates running evals against agent.
 * Optional limiters shared across experiments control how fast attempts start
 * (StartRateLimiter) and how many run at once (ConcurrencyLimiter).
 * 429 rate-limit errors are retried with exponential backoff.
 * With earlyExit, in-flight attempts are aborted when one passes.
 */

import type {
  ResolvedExperimentConfig,
  Classification,
  EvalFixture,
  EvalRunData,
  EvalSummary,
  ExperimentResults,
  RunnableExperimentConfig,
  ProgressEvent,
  Reporter,
} from './types.js';
import type { AgentRunOptions } from './agents/types.js';
import { SandboxCleanupError } from './sandbox-cleanup.js';
import { assertRunRuntimeControls, getAgent, runCredentials } from './agents/index.js';
import {
  formatReporterError,
  notifyExperimentComplete,
  notifyRunComplete,
  type ReporterFailure,
} from './reporters.js';
import {
  agentResultToEvalRunData,
  createEvalSummary,
  createExperimentResults,
  saveResults,
} from './results.js';

/** Combine cancellation sources, with listener disposal on older Node versions. */
function combineSignals(signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  if (signals.length === 1) return { signal: signals[0], dispose: () => {} };
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any(signals), dispose: () => {} };
  }
  const controller = new AbortController();
  const dispose = () => {
    for (const signal of signals) signal.removeEventListener('abort', onAbort);
  };
  const onAbort = (event: Event) => {
    dispose();
    controller.abort((event.target as AbortSignal).reason);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      dispose();
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: controller.signal, dispose };
}

/** Queue a waiter that can be removed without consuming a slot or start token. */
function waitInQueue(queue: (() => void)[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const ready = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      queue.splice(queue.indexOf(ready), 1);
      reject(signal!.reason);
    };
    queue.push(ready);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Stop waiting on cancellation, while still observing any late rejection. */
function withCancellation<T>(operation: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([cancelled, operation]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

/**
 * Rate-limits how many operations can START within a time window.
 * Once started, operations run freely with no concurrency limit.
 * Create one instance and share it across experiments to control global start rate.
 */
export class StartRateLimiter {
  private queue: (() => void)[] = [];
  private started = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly startsPerWindow: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Wait for permission to start, then return immediately.
   * The operation runs freely after this resolves.
   */
  async waitToStart(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.started < this.startsPerWindow) {
      this.started++;
      this.ensureTimer();
      return;
    }
    return waitInQueue(this.queue, signal);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.started = 0;
      // Drain as many queued starters as the window allows
      while (this.queue.length > 0 && this.started < this.startsPerWindow) {
        this.started++;
        this.queue.shift()!();
      }
      // Stop the timer once a whole window passes with no starts and nothing
      // waiting. Stopping it while `started` is non-zero would leave that count
      // with nothing to reset it, so a later caller could wait forever.
      if (this.queue.length === 0 && this.started === 0) {
        clearInterval(this.timer!);
        this.timer = null;
      }
    }, this.windowMs);
  }
}

/**
 * Caps how many operations can be ACTIVE at once. Unlike StartRateLimiter, a
 * slot is held until the operation releases it, so finished work makes room
 * for waiting work. Create one instance and share it across experiments to cap
 * the total number of running evals, and with it the number of live sandboxes.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly controller = new AbortController();

  /** Aborted when cleanup fails. A failed limiter cannot be reused. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Stop admission and cancel active runs. The first failure is preserved. */
  abort(error: Error): void {
    this.controller.abort(error);
  }

  constructor(private readonly maxActive: number) {
    if (!Number.isInteger(maxActive) || maxActive < 1) {
      throw new Error(`ConcurrencyLimiter maxActive must be a positive integer, got ${maxActive}`);
    }
  }

  /**
   * Wait for a free slot (first come, first served) and return the function
   * that frees it. Calling that function again does nothing.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    const cancellation = combineSignals(signal ? [signal, this.signal] : [this.signal]);
    try {
      cancellation.signal.throwIfAborted();
      if (this.active < this.maxActive) {
        this.active++;
      } else {
        await waitInQueue(this.waiting, cancellation.signal);
      }
    } finally {
      cancellation.dispose();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Hand the slot straight to the next waiter so a new caller can't take it first.
      const next = !this.signal.aborted && this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

/**
 * Options for running an experiment.
 */
export interface RunExperimentOptions {
  /** Resolved experiment configuration */
  config: RunnableExperimentConfig;
  /** Fixtures to run */
  fixtures: EvalFixture[];
  /** API key for the agent */
  apiKey: string;
  /** Directory to save results */
  resultsDir: string;
  /** Experiment name */
  experimentName: string;
  /** Per-eval fingerprints (eval name -> hash) for result reuse */
  fingerprints?: Record<string, string>;
  /** Per-eval content fingerprints (eval name -> eval-files-only hash) */
  contentFingerprints?: Record<string, string>;
  /** Callback for progress updates */
  onProgress?: (event: ProgressEvent) => void;
  /** Whether to run in verbose mode */
  verbose?: boolean;
  /** Whether this is a smoke test run */
  smoke?: boolean;
  /** Shared rate limiter to control how many sandbox runs start per time window */
  rateLimiter?: StartRateLimiter;
  /** Shared limiter to cap active attempts, including cleanup after cancellation.
   * Cleanup failure or a 60s cleanup deadline aborts the shared limiter.
   * @default undefined (no cap) */
  concurrencyLimiter?: ConcurrencyLimiter;
  /** Reporters to call in addition to `config.reporters`. @default undefined */
  reporters?: Reporter[];
  /** Evals the caller skipped because a cached result was reused. Listed in the
   * reporters' experiment event; they get no run events. @default undefined */
  reusedEvals?: string[];
  /**
   * Optional step that runs after results are saved and before reporters'
   * `onExperimentComplete`. Classifications it returns are included in the
   * reporter event. The CLI uses this for failure classification, which can
   * remove non-model failures from the results directory. @default undefined
   */
  classify?: (
    results: ExperimentResults,
    outputDir: string,
  ) => Promise<Map<string, Classification> | void>;
}

/**
 * Represents a single eval attempt (fixture + run index).
 */
interface EvalAttempt {
  fixture: EvalFixture;
  runIndex: number;
}

/**
 * Result of a single eval attempt.
 */
interface AttemptResult {
  fixtureName: string;
  runIndex: number;
  runData: EvalRunData;
  aborted?: boolean;
}

/** Keep the slot and the process alive until cleanup completes or fails closed. */
async function waitForAgentCleanup(
  agentRun: Promise<unknown>,
  signal: AbortSignal,
  limiter: ConcurrencyLimiter,
  label: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => {
      timer = setTimeout(() => {
        const error = new Error(`Cleanup did not finish within 60s after cancellation: ${label}. No further evals will start.`);
        limiter.abort(error);
        reject(error);
      }, 60_000);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([agentRun, deadline]);
  } catch (error) {
    if (error instanceof SandboxCleanupError) limiter.abort(error);
    // Ordinary agent failures have finished cleanup and are handled by runAttempt.
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
  limiter.signal.throwIfAborted();
}

/**
 * Run an experiment - execute all evals with configured runs concurrently.
 * With earlyExit enabled, remaining attempts for a fixture are aborted once one passes.
 */
export async function runExperiment(
  options: RunExperimentOptions
): Promise<ExperimentResults> {
  const { config, fixtures, apiKey, resultsDir, experimentName, fingerprints, contentFingerprints, onProgress, smoke, rateLimiter, concurrencyLimiter } = options;
  const startedAt = new Date();
  const reporters = [...(config.reporters ?? []), ...(options.reporters ?? [])];

  assertRunRuntimeControls(
    config.agent,
    {
      disableBundledSkills: config.disableBundledSkills,
      webResearch: config.webResearch,
    },
    config.judge?.agent,
  );

  // Get the agent from registry
  const agent = getAgent(config.agent);
  // Transcript parser for reading token usage (falls back to the agent id, which
  // is what saveResults parses transcripts with).
  const o11yAgentName = agent.definition?.o11yAgentName ?? config.agent;

  const emit = (event: ProgressEvent) => {
    if (onProgress) {
      onProgress(event);
    }
  };

  // Reporter payloads are redacted with the same credentials the agent's own
  // result is (the codegen key and a pinned judge's key).
  const reporterSecrets = reporters.length > 0 ? reporterCredentials(agent, config, apiKey) : [];
  const onReporterFailure = (failure: ReporterFailure) => {
    const event: Extract<ProgressEvent, { type: 'reporter:error' }> = {
      type: 'reporter:error',
      reporter: failure.reporter,
      hook: failure.hook,
      error: failure.error,
      ...(failure.evalName !== undefined ? { evalName: failure.evalName } : {}),
      ...(failure.runIndex !== undefined ? { runNumber: failure.runIndex + 1 } : {}),
    };
    // Never swallow a reporter failure silently: without a progress handler,
    // log it directly.
    if (onProgress) emit(event);
    else console.warn(formatReporterError(event));
  };

  // Create AbortController per fixture for earlyExit
  const abortControllers = new Map<string, AbortController>();
  for (const fixture of fixtures) {
    abortControllers.set(fixture.name, new AbortController());
  }

  // Build list of all attempts to run
  const attempts: EvalAttempt[] = [];
  for (const fixture of fixtures) {
    for (let i = 0; i < config.runs; i++) {
      attempts.push({ fixture, runIndex: i });
    }
  }

  emit({ type: 'experiment:start', totalAttempts: attempts.length, totalEvals: fixtures.length, totalRuns: config.runs });

  const abortedResult = ({ fixture, runIndex }: EvalAttempt, duration = 0): AttemptResult => ({
    fixtureName: fixture.name,
    runIndex,
    runData: {
      result: { status: 'failed', error: 'Aborted', duration },
    },
    aborted: true,
  });

  // Run a single attempt. onAgentRun receives the agent's run, which a timeout
  // abandons while it is still stopping the sandbox.
  const runAttempt = async (
    attempt: EvalAttempt,
    signal: AbortSignal,
    onAgentRun?: (run: Promise<unknown>, signal: AbortSignal) => void,
  ): Promise<AttemptResult> => {
    const { fixture, runIndex } = attempt;
    // Check if already aborted before starting
    if (signal.aborted) {
      return abortedResult(attempt);
    }

    const timeoutMs = config.timeout * 1000;
    const startTime = Date.now();

    // Create per-attempt controller for timeout cleanup
    const attemptController = new AbortController();

    const cancellation = combineSignals([signal, attemptController.signal]);
    const attemptSignal = cancellation.signal;
    const timeoutError = new Error(`Eval timed out after ${config.timeout}s`);
    const timeoutId = setTimeout(() => attemptController.abort(timeoutError), timeoutMs);

    const modelPolicy = config.modelPolicy ?? 'agent-default';
    const requestedModel = modelPolicy === 'native-default' ? undefined : config.model;
    const agentRun = Promise.resolve().then(() => {
      attemptSignal.throwIfAborted();
      return agent.run(fixture.path, {
        prompt: config.editPrompt ? config.editPrompt(fixture.prompt) : fixture.prompt,
        model: requestedModel,
        modelPolicy,
        timeout: timeoutMs,
        apiKey,
        setup: config.setup,
        scripts: config.scripts,
        validation: config.validation,
        signal: attemptSignal,
        ...(concurrencyLimiter ? { requireCleanup: true } : {}),
        sandbox: config.sandbox,
        sandboxImage: config.sandboxImage,
        sandboxUser: config.sandboxUser,
        agentOptions: config.agentOptions,
        webResearch: config.webResearch,
        disableBundledSkills: config.disableBundledSkills,
        judge: config.judge,
        agentEnv: config.agentEnv,
        verifier: config.verifier,
        protectedPaths: config.protectedPaths,
      });
    }).finally(cancellation.dispose);
    onAgentRun?.(agentRun, attemptSignal);
    // Without a cap, early exit still waits for the agent to finish cleanup;
    // only the eval's own timeout abandons that wait, as before.
    const agentResult = await withCancellation(agentRun, concurrencyLimiter ? attemptSignal : attemptController.signal).catch((error) => {
      concurrencyLimiter?.signal.throwIfAborted();
      if (error instanceof SandboxCleanupError) throw error;
      if (error === timeoutError || (error instanceof Error && error.message.includes('timed out'))) {
        return { success: false, output: '', error: error.message, duration: Date.now() - startTime };
      }
      if (signal.aborted && !concurrencyLimiter?.signal.aborted) {
        return { success: false, output: '', error: 'Aborted', duration: Date.now() - startTime };
      }
      throw error;
    }).finally(() => {
      clearTimeout(timeoutId);
    });

    // Check if this was aborted
    if (agentResult.error === 'Aborted' || agentResult.error === 'Aborted before start') {
      return abortedResult(attempt, agentResult.duration / 1000);
    }

    let runData = agentResultToEvalRunData(agentResult, { o11yAgentName });

    if (config.onRunComplete) {
      try {
        const updatedRunData = await withCancellation(config.onRunComplete({
          fixture,
          runIndex,
          config,
          runData,
        }), concurrencyLimiter?.signal);
        if (updatedRunData) {
          runData = updatedRunData;
        }
      } catch (error) {
        concurrencyLimiter?.signal.throwIfAborted();
        runData = {
          ...runData,
          result: {
            ...runData.result,
            status: 'failed',
            error: `onRunComplete failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    }

    return {
      fixtureName: fixture.name,
      runIndex,
      runData,
    };
  };

  // Retry wrapper: if an attempt fails suspiciously fast (< 5s), it's likely an infra issue (429, etc.)
  // Real evals take minutes, so a sub-5s failure is always anomalous.
  const MAX_RETRIES = 5;
  const INITIAL_BACKOFF_MS = 5_000;
  const ANOMALY_THRESHOLD_S = 5;

  const runAttemptWithRetry = async (
    attempt: EvalAttempt,
    signal: AbortSignal,
    onAgentRun?: (run: Promise<unknown>, signal: AbortSignal) => void,
  ): Promise<AttemptResult> => {
    for (let retry = 0; ; retry++) {
      const result = await runAttempt(attempt, signal, onAgentRun);

      const isSuspiciouslyFast =
        !result.aborted &&
        result.runData.result.status === 'failed' &&
        result.runData.result.duration < ANOMALY_THRESHOLD_S &&
        !result.runData.result.error?.includes('timed out');

      if (!isSuspiciouslyFast || retry >= MAX_RETRIES) {
        return result;
      }

      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, retry);
      const jitter = Math.random() * backoff * 0.5;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await withCancellation(new Promise<void>((resolve) => {
        timer = setTimeout(resolve, backoff + jitter);
      }), signal).finally(() => clearTimeout(timer));
    }
  };

  // Run all attempts with capped concurrency, rate-limited starts, 429 retry, and progress events
  const runOne = async (attempt: EvalAttempt): Promise<AttemptResult> => {
    const fixtureSignal = abortControllers.get(attempt.fixture.name)!.signal;
    const cancellation = combineSignals(concurrencyLimiter
      ? [fixtureSignal, concurrencyLimiter.signal]
      : [fixtureSignal]);
    const signal = cancellation.signal;
    let release: (() => void) | undefined;
    let cleanup: Promise<void> | undefined;
    try {
      // Acquire capacity before a start token so queued work cannot bank tokens.
      release = await concurrencyLimiter?.acquire(signal);
      await rateLimiter?.waitToStart(signal);
      signal.throwIfAborted();
      emit({ type: 'eval:start', evalName: attempt.fixture.name, runNumber: attempt.runIndex + 1, totalRuns: config.runs });

      const result = await runAttemptWithRetry(attempt, signal, (run, attemptSignal) => {
        if (concurrencyLimiter) {
          cleanup = waitForAgentCleanup(run, attemptSignal, concurrencyLimiter,
            `${experimentName}/${attempt.fixture.name} (run ${attempt.runIndex + 1})`);
          // Observe failures immediately, even while the attempt reports its timeout.
          void cleanup.catch(() => {});
        }
      });

      if (!result.aborted) {
        emit({ type: 'eval:complete', evalName: attempt.fixture.name, runNumber: attempt.runIndex + 1, totalRuns: config.runs, result: result.runData.result });

        // If this attempt passed and earlyExit is enabled, abort remaining attempts
        if (config.earlyExit && result.runData.result.status === 'passed') {
          emit({ type: 'experiment:earlyExit', evalName: attempt.fixture.name, runNumber: attempt.runIndex + 1 });
          abortControllers.get(attempt.fixture.name)!.abort();
        }

        // Reporters see the final attempt only (after any retry) and the result
        // after the user's onRunComplete hook, which ran inside runAttempt.
        if (reporters.length > 0) {
          const fingerprint = fingerprints?.[attempt.fixture.name];
          const contentFingerprint = contentFingerprints?.[attempt.fixture.name];
          await withCancellation(notifyRunComplete(
            reporters,
            {
              schemaVersion: 1,
              experimentName,
              evalName: attempt.fixture.name,
              runIndex: attempt.runIndex,
              agent: config.agent,
              model: config.model,
              result: result.runData.result,
              ...(fingerprint ? { fingerprint } : {}),
              ...(contentFingerprint ? { contentFingerprint } : {}),
            },
            { secrets: reporterSecrets, onFailure: onReporterFailure },
          ), concurrencyLimiter?.signal);
        }
      }

      return result;
    } catch (error) {
      if (concurrencyLimiter?.signal.aborted) throw concurrencyLimiter.signal.reason;
      if (fixtureSignal.aborted) return abortedResult(attempt);
      throw error;
    } finally {
      try {
        await cleanup;
      } finally {
        release?.();
        cancellation.dispose();
      }
    }
  };

  const running = attempts.map(runOne);
  // Drain active cleanup before rejecting, including runs in this experiment
  // cancelled by a cleanup failure in another experiment sharing the limiter.
  if (concurrencyLimiter) {
    await Promise.allSettled(running);
    concurrencyLimiter.signal.throwIfAborted();
  }
  const results = await Promise.all(running);

  // Group results by fixture, excluding aborted results
  const resultsByFixture = new Map<string, AttemptResult[]>();
  for (const fixture of fixtures) {
    resultsByFixture.set(fixture.name, []);
  }

  for (const result of results) {
    if (!result.aborted) {
      resultsByFixture.get(result.fixtureName)!.push(result);
    }
  }

  // Build eval summaries, respecting earlyExit
  const evalSummaries: EvalSummary[] = [];
  for (const fixture of fixtures) {
    const fixtureResults = resultsByFixture.get(fixture.name)!;

    // Sort by run index to process in order
    fixtureResults.sort((a, b) => a.runIndex - b.runIndex);

    const runDataList: EvalRunData[] = [];
    for (const result of fixtureResults) {
      runDataList.push(result.runData);

      // With earlyExit, stop counting after first pass
      if (config.earlyExit && result.runData.result.status === 'passed') {
        break;
      }
    }

    const summary = createEvalSummary(fixture.name, runDataList);
    evalSummaries.push(summary);
  }

  const completedAt = new Date();
  const experimentResults = createExperimentResults(config, evalSummaries, startedAt, completedAt);

  // Save results to disk
  const fixturePaths: Record<string, string> = {};
  for (const fixture of fixtures) {
    fixturePaths[fixture.name] = fixture.path;
  }
  const outputDir = saveResults(experimentResults, {
    resultsDir,
    experimentName,
    fingerprints,
    contentFingerprints,
    smoke,
    fixturePaths,
  });

  emit({ type: 'experiment:saved', outputDir });
  emit({ type: 'experiment:summary', results: experimentResults });

  const classifications = options.classify
    ? await withCancellation(options.classify(experimentResults, outputDir), concurrencyLimiter?.signal)
    : undefined;

  if (reporters.length > 0) {
    await withCancellation(notifyExperimentComplete(
      reporters,
      {
        schemaVersion: 1,
        experimentName,
        outputDir,
        results: experimentResults,
        reused: [...(options.reusedEvals ?? [])],
        ...(classifications ? { classifications: Object.fromEntries(classifications) } : {}),
      },
      { secrets: reporterSecrets, onFailure: onReporterFailure },
    ), concurrencyLimiter?.signal);
  }

  return experimentResults;
}

/** The credentials a run of this experiment injects, for redacting reporter payloads. */
function reporterCredentials(
  agent: ReturnType<typeof getAgent>,
  config: RunnableExperimentConfig,
  apiKey: string,
): string[] {
  // Without a definition there is no judge to resolve; the codegen key and the
  // agentEnv values are still known.
  if (!agent.definition) return [apiKey, ...Object.values(config.agentEnv ?? {})];
  const modelPolicy = config.modelPolicy ?? 'agent-default';
  const options: AgentRunOptions = {
    prompt: '',
    model: modelPolicy === 'native-default' ? undefined : config.model,
    modelPolicy,
    timeout: config.timeout * 1000,
    apiKey,
    agentOptions: config.agentOptions,
    webResearch: config.webResearch,
    disableBundledSkills: config.disableBundledSkills,
    judge: config.judge,
    agentEnv: config.agentEnv,
  };
  return runCredentials(agent.definition, options);
}

/**
 * Run a single eval (for testing/debugging).
 */
export async function runSingleEval<T extends ResolvedExperimentConfig['model']>(
  fixture: EvalFixture,
  options: {
    agent?: ResolvedExperimentConfig['agent'];
    model: T;
    timeout: number;
    apiKey: string;
    setup?: ResolvedExperimentConfig['setup'];
    scripts?: string[];
    validation?: ResolvedExperimentConfig['validation'];
    sandbox?: ResolvedExperimentConfig['sandbox'];
    sandboxImage?: ResolvedExperimentConfig['sandboxImage'];
    sandboxUser?: ResolvedExperimentConfig['sandboxUser'];
    editPrompt?: (prompt: string) => string;
    verbose?: boolean;
    agentOptions?: ResolvedExperimentConfig['agentOptions'];
    webResearch?: ResolvedExperimentConfig['webResearch'];
    disableBundledSkills?: ResolvedExperimentConfig['disableBundledSkills'];
    judge?: ResolvedExperimentConfig['judge'];
    agentEnv?: ResolvedExperimentConfig['agentEnv'];
    verifier?: ResolvedExperimentConfig['verifier'];
    protectedPaths?: ResolvedExperimentConfig['protectedPaths'];
  }
): Promise<T extends Array<unknown> ? EvalRunData[] : EvalRunData> {
  const agentName = options.agent ?? 'vercel-ai-gateway/claude-code';
  assertRunRuntimeControls(
    agentName,
    {
      disableBundledSkills: options.disableBundledSkills,
      webResearch: options.webResearch,
    },
    options.judge?.agent,
  );
  const agent = getAgent(agentName);
  const o11yAgentName = agent.definition?.o11yAgentName ?? agentName;

  const models: string[] = Array.isArray(options.model) ? options.model : [options.model];
  const prompt = options.editPrompt ? options.editPrompt(fixture.prompt) : fixture.prompt;

  const results: EvalRunData[] = [];

  for (const model of models) {

	const agentResult = await agent.run(fixture.path, {
		prompt,
		model,
		modelPolicy: 'agent-default',
		timeout: options.timeout * 1000,
		apiKey: options.apiKey,
		setup: options.setup,
		scripts: options.scripts,
		validation: options.validation,
		sandbox: options.sandbox,
		sandboxImage: options.sandboxImage,
		sandboxUser: options.sandboxUser,
		agentOptions: options.agentOptions,
		webResearch: options.webResearch,
		disableBundledSkills: options.disableBundledSkills,
		judge: options.judge,
		agentEnv: options.agentEnv,
		verifier: options.verifier,
		protectedPaths: options.protectedPaths,
	});

    results.push(agentResultToEvalRunData(agentResult, { o11yAgentName }));
  }

  // TODO: remove this on the next major and return an array directly...it's just here to prevent breaking changes
  if(!Array.isArray(options.model)) {
	return results[0] as T extends Array<unknown> ? EvalRunData[] : EvalRunData;
  }

  return results as T extends Array<unknown> ? EvalRunData[] : EvalRunData;
}
