/**
 * Results storage and reporting for eval experiments.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import type {
  EvalRunResult,
  EvalRunData,
  EvalSummary,
  ExperimentResults,
  ResolvedExperimentConfig,
} from './types.js';
import type { AgentRunResult } from './agents/types.js';
import { parseTranscript, type Transcript } from './o11y/index.js';

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
  config: ResolvedExperimentConfig,
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
    const summaryForFile = {
      totalRuns: evalSummary.totalRuns,
      passedRuns: evalSummary.passedRuns,
      passRate: `${evalSummary.passRate.toFixed(0)}%`,
      meanDuration: evalSummary.meanDuration,
    };
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
      const resultWithPaths: EvalRunResult & { o11y?: Transcript['summary'] } = {
        ...runData.result,
      };

      // Save transcripts if available
      if (runData.transcript) {
        // Parse the raw transcript
        const transcript = parseTranscript(
          runData.transcript,
          results.config.agent,
          results.config.model
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

        // Save npm script outputs (nested to avoid collision)
        if (runData.outputContent.scripts) {
          outputPaths.scripts = {};
          for (const [name, content] of Object.entries(runData.outputContent.scripts)) {
            if (content) {
              const fileName = `${name}.txt`;
              writeFileSync(join(outputsDir, fileName), content);
              outputPaths.scripts[name] = `./outputs/${fileName}`;
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
  result: EvalRunResult
): string {
  const icon = result.status === 'passed' ? '✓' : '✗';
  const color = result.status === 'passed' ? chalk.green : chalk.red;

  let line = color(`${icon} ${evalName} [${runNumber}/${totalRuns}]`);
  line += chalk.gray(` (${result.duration.toFixed(1)}s)`);

  if (result.error) {
    line += chalk.red(` - ${result.error.slice(0, 50)}${result.error.length > 50 ? '...' : ''}`);
  }

  return line;
}

/**
 * Create a progress indicator for running evals.
 */
export function createProgressDisplay(
  evalName: string,
  runNumber: number,
  totalRuns: number
): string {
  return chalk.blue(`Running ${evalName} [${runNumber}/${totalRuns}]...`);
}
