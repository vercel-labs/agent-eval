/**
 * Results storage and reporting for eval experiments.
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import type {
  EvalRunResult,
  EvalRunData,
  EvalSummary,
  ExperimentResults,
  RunnableExperimentConfig,
} from './types.js';
import type { AgentRunResult } from './agents/types.js';
import { parseTranscript, type Transcript } from './o11y/index.js';
import { isNonModelFailure } from './classifier.js';

/**
 * Convert AgentRunResult to EvalRunData (result + transcript).
 */
export function agentResultToEvalRunData(agentResult: AgentRunResult): EvalRunData {
  // Collect output content from scripts and tests
  const outputContent: EvalRunData['outputContent'] = {};

  // Add EVAL.ts test output
  if (agentResult.testResult?.output) {
    outputContent.eval = agentResult.testResult.output;
  }

  // Add all script outputs (nested under 'scripts' to avoid collision)
  if (agentResult.scriptsResults && Object.keys(agentResult.scriptsResults).length > 0) {
    outputContent.scripts = {};
    for (const [name, result] of Object.entries(agentResult.scriptsResults)) {
      if (result.output) {
        outputContent.scripts[name] = result.output;
      }
    }
  }

  return {
    result: {
      status: agentResult.success ? 'passed' : 'failed',
      error: agentResult.error,
      duration: agentResult.duration / 1000, // Convert to seconds
    },
    transcript: agentResult.transcript,
    outputContent: Object.keys(outputContent).length > 0 ? outputContent : undefined,
  };
}

/**
 * Create a summary from multiple run data.
 */
export function createEvalSummary(name: string, runData: EvalRunData[]): EvalSummary {
  const runs = runData.map((r) => r.result);
  const passedRuns = runs.filter((r) => r.status === 'passed').length;
  const totalDuration = runs.reduce((sum, r) => sum + r.duration, 0);

  return {
    name,
    totalRuns: runs.length,
    passedRuns,
    passRate: runs.length > 0 ? (passedRuns / runs.length) * 100 : 0,
    meanDuration: runs.length > 0 ? totalDuration / runs.length : 0,
    runs: runData,
  };
}

/**
 * Create experiment results from eval summaries.
 */
export function createExperimentResults(
  config: RunnableExperimentConfig,
  evals: EvalSummary[],
  startedAt: Date,
  completedAt: Date
): ExperimentResults {
  return {
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    config,
    evals,
  };
}

/**
 * Options for saving results.
 */
export interface SaveResultsOptions {
  /** Base directory for results */
  resultsDir: string;
  /** Experiment name (used for subdirectory) */
  experimentName: string;
  /** Per-eval fingerprints (eval name -> fingerprint hash) */
  fingerprints?: Record<string, string>;
  /** Per-eval validity flags (eval name -> valid). Defaults to true. */
  validity?: Record<string, boolean>;
  /** Whether this is a smoke test run. Smoke results are excluded from reuse. */
  smoke?: boolean;
}

/**
 * Save experiment results to disk.
 *
 * Creates a directory structure per design:
 * results/
 *   experiment-name/
 *     2024-01-26T12-00-00Z/
 *       eval-1/
 *         run-1/
 *           result.json
 *           transcript.json      (parsed/structured - primary format)
 *           transcript-raw.jsonl (raw agent output - for debugging)
 *           outputs/
 *         summary.json
 */
export function saveResults(
  results: ExperimentResults,
  options: SaveResultsOptions
): string {
  const timestamp = results.startedAt.replace(/:/g, '-');
  const experimentDir = join(options.resultsDir, options.experimentName, timestamp);

  // Create experiment directory
  mkdirSync(experimentDir, { recursive: true });

  // Save per-eval results
  for (const evalSummary of results.evals) {
    const evalDir = join(experimentDir, evalSummary.name);
    mkdirSync(evalDir, { recursive: true });

    // Save summary (simplified format per design)
    const fingerprint = options.fingerprints?.[evalSummary.name];
    const valid = options.validity?.[evalSummary.name];
    const summaryForFile: Record<string, unknown> = {
      totalRuns: evalSummary.totalRuns,
      passedRuns: evalSummary.passedRuns,
      passRate: `${evalSummary.passRate.toFixed(0)}%`,
      meanDuration: evalSummary.meanDuration,
    };
    if (fingerprint) {
      summaryForFile.fingerprint = fingerprint;
    }
    if (valid === false) {
      summaryForFile.valid = false;
    }
    if (options.smoke) {
      summaryForFile.smoke = true;
    }
    writeFileSync(
      join(evalDir, 'summary.json'),
      JSON.stringify(summaryForFile, null, 2)
    );

    // Save individual run results
    for (let i = 0; i < evalSummary.runs.length; i++) {
      const runData = evalSummary.runs[i];
      const runDir = join(evalDir, `run-${i + 1}`);
      mkdirSync(runDir, { recursive: true });

      // Build the result with paths and o11y summary
      const model = results.config.model;
      const resultWithPaths: EvalRunResult & { o11y?: Transcript['summary'] } = {
        ...runData.result,
        model,
      };

      // Save transcripts if available
      if (runData.transcript) {
        // Parse the raw transcript
        const transcript = parseTranscript(
          runData.transcript,
          results.config.agent,
          model
        );

        // Save parsed transcript as primary format (transcript.json)
        writeFileSync(
          join(runDir, 'transcript.json'),
          JSON.stringify(transcript, null, 2)
        );
        resultWithPaths.transcriptPath = './transcript.json';

        // Save raw transcript for debugging (transcript-raw.jsonl)
        writeFileSync(join(runDir, 'transcript-raw.jsonl'), runData.transcript);
        resultWithPaths.transcriptRawPath = './transcript-raw.jsonl';

        // Include summary in result.json for quick access
        resultWithPaths.o11y = transcript.summary;
      }

      // Save script/test outputs to outputs/
      const outputsDir = join(runDir, 'outputs');
      mkdirSync(outputsDir, { recursive: true });

      if (runData.outputContent) {
        const outputPaths: EvalRunResult['outputPaths'] = {};

        // Save EVAL.ts test output
        if (runData.outputContent.eval) {
          writeFileSync(join(outputsDir, 'eval.txt'), runData.outputContent.eval);
          outputPaths.eval = './outputs/eval.txt';
        }

        // Save npm script outputs under outputs/scripts/ to avoid collision with eval.txt
        if (runData.outputContent.scripts) {
          const scriptsDir = join(outputsDir, 'scripts');
          mkdirSync(scriptsDir, { recursive: true });
          outputPaths.scripts = {};
          for (const [name, content] of Object.entries(runData.outputContent.scripts)) {
            if (content) {
              const fileName = `${name}.txt`;
              writeFileSync(join(scriptsDir, fileName), content);
              outputPaths.scripts[name] = `./outputs/scripts/${fileName}`;
            }
          }
        }

        if (outputPaths.eval || (outputPaths.scripts && Object.keys(outputPaths.scripts).length > 0)) {
          resultWithPaths.outputPaths = outputPaths;
        }
      }

      // Save result.json with paths and o11y summary
      writeFileSync(
        join(runDir, 'result.json'),
        JSON.stringify(resultWithPaths, null, 2)
      );
    }
  }

  return experimentDir;
}

/**
 * Format results for terminal display.
 */
export function formatResultsTable(results: ExperimentResults): string {
  const lines: string[] = [];
  const separator = '─'.repeat(60);

  lines.push('');
  lines.push(chalk.bold('Experiment Results'));
  lines.push(chalk.gray(separator));
  lines.push('');

  // Calculate overall stats
  const totalRuns = results.evals.reduce((sum, e) => sum + e.totalRuns, 0);
  const totalPassed = results.evals.reduce((sum, e) => sum + e.passedRuns, 0);
  const overallPassRate = totalRuns > 0 ? (totalPassed / totalRuns) * 100 : 0;

  for (const evalSummary of results.evals) {
    const passIcon = evalSummary.passedRuns === evalSummary.totalRuns ? '✓' : '✗';
    const passColor = evalSummary.passedRuns === evalSummary.totalRuns ? chalk.green : chalk.red;

    lines.push(
      passColor(
        `${passIcon} ${evalSummary.name}: ${evalSummary.passedRuns}/${evalSummary.totalRuns} passed (${evalSummary.passRate.toFixed(0)}%)`
      )
    );
    lines.push(chalk.gray(`  Mean duration: ${evalSummary.meanDuration.toFixed(1)}s`));
    lines.push('');
  }

  lines.push(chalk.gray(separator));
  lines.push('');

  const overallColor = overallPassRate === 100 ? chalk.green : overallPassRate >= 50 ? chalk.yellow : chalk.red;
  lines.push(overallColor(`Overall: ${totalPassed}/${totalRuns} passed (${overallPassRate.toFixed(0)}%)`));

  const duration = (new Date(results.completedAt).getTime() - new Date(results.startedAt).getTime()) / 1000;
  lines.push(chalk.gray(`Total time: ${duration.toFixed(1)}s`));
  lines.push('');

  return lines.join('\n');
}

/**
 * Format a single eval result for terminal display (used during progress).
 */
export function formatRunResult(
  evalName: string,
  runNumber: number,
  totalRuns: number,
  result: EvalRunResult,
  context?: { experimentName?: string; model?: string; agent?: string }
): string {
  const icon = result.status === 'passed' ? '✓' : '✗';
  const color = result.status === 'passed' ? chalk.green : chalk.red;
  const prefix = context?.experimentName ? `${context.experimentName}/${evalName}` : evalName;

  let line = color(`${icon} ${prefix} [${runNumber}/${totalRuns}]`);
  if (context?.model || context?.agent) {
    line += chalk.gray(` (${[context.agent, context.model].filter(Boolean).join(' · ')})`);
  }
  line += chalk.gray(` (${result.duration.toFixed(1)}s)`);

  if (result.error) {
    line += chalk.red(` - ${result.error.slice(0, 200)}${result.error.length > 200 ? '...' : ''}`);
  }

  return line;
}

/**
 * Create a progress indicator for running evals.
 */
export function createProgressDisplay(
  evalName: string,
  runNumber: number,
  totalRuns: number,
  context?: { experimentName?: string; model?: string; agent?: string }
): string {
  const prefix = context?.experimentName ? `${context.experimentName}/${evalName}` : evalName;
  const meta = [context?.agent, context?.model].filter(Boolean).join(' · ');
  const suffix = meta ? ` [${meta}]` : '';
  return chalk.blue(`Running ${prefix} [${runNumber}/${totalRuns}]${suffix}...`);
}

/**
 * A reusable result found by the scanner.
 */
export interface ReusableResult {
  evalName: string;
  fingerprint: string;
  passRate: string;
  timestamp: string;
}

/**
 * Scan existing results for an experiment to find reusable eval results.
 *
 * A result is reusable if:
 * 1. Its fingerprint matches the current fingerprint
 * 2. It is "valid" (not marked as invalid by the classifier)
 * 3. It has passedRuns > 0 (successful result worth reusing)
 *
 * Scans all timestamps newest-first and returns the latest match per eval.
 */
export function scanReusableResults(
  resultsDir: string,
  experimentName: string,
  fingerprints: Record<string, string>
): Map<string, ReusableResult> {
  const reusable = new Map<string, ReusableResult>();
  const experimentDir = join(resultsDir, experimentName);

  if (!existsSync(experimentDir)) return reusable;

  // Get all timestamps, sorted newest first
  let timestamps: string[];
  try {
    timestamps = readdirSync(experimentDir)
      .filter((t) => !t.startsWith('.'))
      .sort()
      .reverse();
  } catch {
    return reusable;
  }

  for (const timestamp of timestamps) {
    const tsDir = join(experimentDir, timestamp);
    if (!statSync(tsDir).isDirectory()) continue;

    let evalDirs: string[];
    try {
      evalDirs = readdirSync(tsDir).filter((d) => !d.startsWith('.'));
    } catch {
      continue;
    }

    for (const evalDir of evalDirs) {
      // Already found a reusable result for this eval
      if (reusable.has(evalDir)) continue;

      // Check if we have a fingerprint for this eval
      const expectedFingerprint = fingerprints[evalDir];
      if (!expectedFingerprint) continue;

      const summaryPath = join(tsDir, evalDir, 'summary.json');
      try {
        const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));

        // Check fingerprint match
        if (summary.fingerprint !== expectedFingerprint) continue;

        // Check validity (valid defaults to true if not explicitly set to false)
        if (summary.valid === false) continue;

        // Skip smoke test results
        if (summary.smoke === true) continue;

        // Skip non-model failures (infra/timeout) — they should be re-run
        if (isNonModelFailure(join(tsDir, evalDir))) continue;

        // Check that it has completed runs (use --force to re-run failures)
        if (summary.totalRuns <= 0) continue;

        // Unclassified failures (0% with no classification.json) are not reusable —
        // they were never properly processed (e.g. interrupted run) and need re-running.
        if (summary.passedRuns === 0 && !existsSync(join(tsDir, evalDir, 'classification.json'))) continue;

        reusable.set(evalDir, {
          evalName: evalDir,
          fingerprint: summary.fingerprint,
          passRate: summary.passRate,
          timestamp,
        });
      } catch {
        // Skip invalid summaries
      }
    }
  }

  return reusable;
}
