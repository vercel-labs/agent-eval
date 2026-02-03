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
} from './types.js';
import { getAgent } from './agents/index.js';
import {
  agentResultToEvalRunData,
  createEvalSummary,
  createExperimentResults,
  saveResults,
  formatResultsTable,
  formatRunResult,
  createProgressDisplay,
} from './results.js';

/**
 * Options for running an experiment.
 */
export interface RunExperimentOptions {
  /** Resolved experiment configuration */
  config: ResolvedExperimentConfig;
  /** Fixtures to run */
  fixtures: EvalFixture[];
  /** API key for the agent */
  apiKey: string;
  /** Directory to save results */
  resultsDir: string;
  /** Experiment name */
  experimentName: string;
  /** Callback for progress updates */
  onProgress?: (message: string) => void;
  /** Whether to run in verbose mode */
  verbose?: boolean;
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
  const { config, fixtures, apiKey, resultsDir, experimentName, onProgress, verbose } = options;
  const startedAt = new Date();

  // Get the agent from registry
  const agent = getAgent(config.agent);

  const log = (msg: string) => {
    if (onProgress) {
      onProgress(msg);
    } else if (verbose) {
      console.log(msg);
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

  log(`Starting ${attempts.length} eval attempts concurrently (${fixtures.length} evals × ${config.runs} runs)`);

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

    log(createProgressDisplay(fixture.name, runIndex + 1, config.runs));

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
        prompt: fixture.prompt,
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

    log(formatRunResult(fixture.name, runIndex + 1, config.runs, runData.result));

    // If this attempt passed and earlyExit is enabled, abort remaining attempts
    if (config.earlyExit && runData.result.status === 'passed') {
      log(`Early exit: ${fixture.name} passed on run ${runIndex + 1}, aborting remaining attempts`);
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
  });

  log(`\nResults saved to: ${outputDir}`);
  log(formatResultsTable(experimentResults));

  return experimentResults;
}

/**
 * Run a single eval (for testing/debugging).
 */
export async function runSingleEval(
  fixture: EvalFixture,
  options: {
    agent?: ResolvedExperimentConfig['agent'];
    model: ResolvedExperimentConfig['model'];
    timeout: number;
    apiKey: string;
    setup?: ResolvedExperimentConfig['setup'];
    scripts?: string[];
    sandbox?: ResolvedExperimentConfig['sandbox'];
    verbose?: boolean;
  }
): Promise<EvalRunData> {
  const agent = getAgent(options.agent ?? 'vercel-ai-gateway/claude-code');

  const agentResult = await agent.run(fixture.path, {
    prompt: fixture.prompt,
    model: options.model,
    timeout: options.timeout * 1000,
    apiKey: options.apiKey,
    setup: options.setup,
    scripts: options.scripts,
    sandbox: options.sandbox,
  });

  return agentResultToEvalRunData(agentResult);
}
