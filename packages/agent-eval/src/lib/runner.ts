/**
 * Experiment runner - orchestrates running evals against agent.
 * All evals and attempts run concurrently for maximum throughput.
 * With earlyExit, in-flight attempts are aborted when one passes.
 */

import type {
  ResolvedExperimentConfig,
  EvalFixture,
  EvalRunData,
  EvalSummary,
  ExperimentResults,
  RunnableExperimentConfig,
  ProgressEvent,
} from './types.js';
import { getAgent } from './agents/index.js';
import {
  agentResultToEvalRunData,
  createEvalSummary,
  createExperimentResults,
  saveResults,
} from './results.js';

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
  /** Callback for progress updates */
  onProgress?: (event: ProgressEvent) => void;
  /** Whether to run in verbose mode */
  verbose?: boolean;
  /** Whether this is a smoke test run */
  smoke?: boolean;
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

/**
 * Run an experiment - execute all evals with configured runs concurrently.
 * With earlyExit enabled, remaining attempts for a fixture are aborted once one passes.
 */
export async function runExperiment(
  options: RunExperimentOptions
): Promise<ExperimentResults> {
  const { config, fixtures, apiKey, resultsDir, experimentName, fingerprints, onProgress, smoke } = options;
  const startedAt = new Date();

  // Get the agent from registry
  const agent = getAgent(config.agent);

  const emit = (event: ProgressEvent) => {
    if (onProgress) {
      onProgress(event);
    }
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

  // Run a single attempt
  const runAttempt = async (attempt: EvalAttempt): Promise<AttemptResult> => {
    const { fixture, runIndex } = attempt;
    const controller = abortControllers.get(fixture.name)!;

    // Check if already aborted before starting
    if (controller.signal.aborted) {
      return {
        fixtureName: fixture.name,
        runIndex,
        runData: {
          result: { status: 'failed', error: 'Aborted', duration: 0 },
        },
        aborted: true,
      };
    }

    emit({ type: 'eval:start', evalName: fixture.name, runNumber: runIndex + 1, totalRuns: config.runs });

    const timeoutMs = config.timeout * 1000;
    const startTime = Date.now();

    // Create per-attempt controller for timeout cleanup
    const attemptController = new AbortController();

    // Propagate earlyExit abort to this attempt's controller
    if (config.earlyExit) {
      controller.signal.addEventListener('abort', () => attemptController.abort(), { once: true });
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const agentResult = await Promise.race([
      agent.run(fixture.path, {
        prompt: config.editPrompt ? config.editPrompt(fixture.prompt) : fixture.prompt,
        model: config.model,
        timeout: timeoutMs,
        apiKey,
        setup: config.setup,
        scripts: config.scripts,
        signal: attemptController.signal,
        sandbox: config.sandbox,
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          attemptController.abort(); // Signal agent to clean up sandbox
          reject(new Error(`Eval timed out after ${config.timeout}s`));
        }, timeoutMs);
      }),
    ]).catch((error) => {
      // Convert timeout error to AgentResult format
      if (error instanceof Error && error.message.includes('timed out')) {
        return {
          success: false,
          output: '',
          error: error.message,
          duration: Date.now() - startTime,
        };
      }
      throw error;
    });

    // Clear timeout if agent completed before timeout
    if (timeoutId) clearTimeout(timeoutId);

    // Check if this was aborted
    if (agentResult.error === 'Aborted' || agentResult.error === 'Aborted before start') {
      return {
        fixtureName: fixture.name,
        runIndex,
        runData: {
          result: { status: 'failed', error: 'Aborted', duration: agentResult.duration / 1000 },
        },
        aborted: true,
      };
    }

    const runData = agentResultToEvalRunData(agentResult);

    emit({ type: 'eval:complete', evalName: fixture.name, runNumber: runIndex + 1, totalRuns: config.runs, result: runData.result });

    // If this attempt passed and earlyExit is enabled, abort remaining attempts
    if (config.earlyExit && runData.result.status === 'passed') {
      emit({ type: 'experiment:earlyExit', evalName: fixture.name, runNumber: runIndex + 1 });
      controller.abort();
    }

    return {
      fixtureName: fixture.name,
      runIndex,
      runData,
    };
  };

  // Run all attempts concurrently
  const results = await Promise.all(attempts.map(runAttempt));

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
  const outputDir = saveResults(experimentResults, {
    resultsDir,
    experimentName,
    fingerprints,
    smoke,
  });

  emit({ type: 'experiment:saved', outputDir });
  emit({ type: 'experiment:summary', results: experimentResults });

  return experimentResults;
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
    sandbox?: ResolvedExperimentConfig['sandbox'];
    editPrompt?: (prompt: string) => string;
    verbose?: boolean;
  }
): Promise<T extends Array<unknown> ? EvalRunData[] : EvalRunData> {
  const agent = getAgent(options.agent ?? 'vercel-ai-gateway/claude-code');

  const models: string[] = Array.isArray(options.model) ? options.model : [options.model];
  const prompt = options.editPrompt ? options.editPrompt(fixture.prompt) : fixture.prompt;

  const results: EvalRunData[] = [];

  for (const model of models) {

	const agentResult = await agent.run(fixture.path, {
		prompt,
		model,
		timeout: options.timeout * 1000,
		apiKey: options.apiKey,
		setup: options.setup,
		scripts: options.scripts,
		sandbox: options.sandbox,
	});

    results.push(agentResultToEvalRunData(agentResult));
  }

  // TODO: remove this on the next major and return an array directly...it's just here to prevent breaking changes
  if(!Array.isArray(options.model)) {
	return results[0] as T extends Array<unknown> ? EvalRunData[] : EvalRunData;
  }

  return results as T extends Array<unknown> ? EvalRunData[] : EvalRunData;
}
