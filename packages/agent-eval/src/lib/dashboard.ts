/**
 * Live terminal dashboard for parallel experiment runs.
 * Uses log-update for in-place terminal rendering.
 * Falls back to console.log for non-TTY environments.
 */

import logUpdate from 'log-update';
import chalk from 'chalk';
import type {
  ProgressEvent,
  ExperimentResults,
  Classification,
} from './types.js';
import {
  formatRunResult,
  createProgressDisplay,
  formatResultsTable,
} from './results.js';

const SPINNER = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];

/**
 * Tracked state for a single experiment in the dashboard.
 */
interface ExperimentState {
  name: string;
  agent: string;
  model: string;
  totalEvals: number;
  completedEvals: number;
  passed: number;
  failed: number;
  runStartTime: number | null;
  phase: 'waiting' | 'running' | 'classifying' | 'done';
  /** Currently in-flight eval names */
  activeEvals: Set<string>;
  /** Recently completed eval results (kept for display, max 3) */
  recentResults: Array<{ name: string; status: 'passed' | 'failed' }>;
}

/**
 * Live terminal dashboard that renders experiment progress in-place.
 */
export class Dashboard {
  private experiments = new Map<string, ExperimentState>();
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private experimentOrder: string[] = [];
  private tick = 0;

  addExperiment(name: string, meta: { agent: string; model: string; totalEvals: number }) {
    const state: ExperimentState = {
      name,
      agent: meta.agent,
      model: meta.model,
      totalEvals: meta.totalEvals,
      completedEvals: 0,
      passed: 0,
      failed: 0,
      runStartTime: null,
      phase: 'waiting',
      activeEvals: new Set(),
      recentResults: [],
    };
    this.experiments.set(name, state);
    this.experimentOrder.push(name);
  }

  handleEvent(experimentName: string, event: ProgressEvent) {
    const state = this.experiments.get(experimentName);
    if (!state) return;

    switch (event.type) {
      case 'experiment:start':
        state.totalEvals = event.totalAttempts;
        state.phase = 'running';
        state.runStartTime = Date.now();
        break;
      case 'eval:start':
        state.activeEvals.add(event.evalName);
        break;
      case 'eval:complete':
        state.activeEvals.delete(event.evalName);
        state.completedEvals++;
        if (event.result.status === 'passed') {
          state.passed++;
        } else {
          state.failed++;
        }
        state.recentResults.push({ name: event.evalName, status: event.result.status });
        if (state.recentResults.length > 3) state.recentResults.shift();
        break;
    }
  }

  setPhase(experimentName: string, phase: 'classifying' | 'done') {
    const state = this.experiments.get(experimentName);
    if (state) {
      state.phase = phase;
    }
  }

  completeExperiment(
    experimentName: string,
    results: ExperimentResults,
    classifications: Map<string, Classification>
  ) {
    const state = this.experiments.get(experimentName);
    if (!state) return;

    state.phase = 'done';

    logUpdate.clear();
    console.log(renderCompletedBlock(experimentName, state, results, classifications));
    this.render();
  }

  start() {
    this.intervalId = setInterval(() => {
      this.tick++;
      this.render();
    }, 100);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    logUpdate.clear();
  }

  private render() {
    const active = this.experimentOrder.filter(
      (name) => this.experiments.get(name)!.phase !== 'done'
    );

    if (active.length === 0) {
      logUpdate.clear();
      return;
    }

    const totalExperiments = this.experimentOrder.length;
    const completedExperiments = totalExperiments - active.length;

    const maxNameLen = Math.max(...active.map((n) => n.length));
    const nameWidth = Math.max(maxNameLen + 2, 20);

    const spinner = SPINNER[this.tick % SPINNER.length];

    const lines: string[] = [];
    lines.push('');
    lines.push(
      chalk.bold(` ${spinner} ${completedExperiments}/${totalExperiments} experiments complete`)
    );
    lines.push('');

    for (const name of active) {
      const state = this.experiments.get(name)!;
      lines.push(renderExperimentLine(state, nameWidth));
    }

    lines.push('');
    logUpdate(lines.join('\n'));
  }
}

/**
 * Render a single experiment's progress bar line.
 */
function renderExperimentLine(state: ExperimentState, nameWidth: number): string {
  const nameCol = state.name.padEnd(nameWidth);
  const elapsed = state.runStartTime ? Math.round((Date.now() - state.runStartTime) / 1000) : 0;

  if (state.phase === 'waiting') {
    const bar = renderBar(0, 1);
    return ` ${chalk.gray(nameCol)} ${bar}  ${chalk.gray('waiting\u2026')}`;
  }

  if (state.phase === 'classifying') {
    const bar = renderBar(state.totalEvals, state.totalEvals);
    const stats = renderStats(state);
    return ` ${chalk.cyan(nameCol)} ${bar}  ${stats} ${chalk.cyan('\u00b7')} ${chalk.cyan('classifying\u2026')}`;
  }

  const bar = renderBar(state.completedEvals, state.totalEvals);
  const stats = renderStats(state);
  const time = chalk.gray(formatElapsed(elapsed));

  return ` ${chalk.white(nameCol)} ${bar}  ${stats} ${chalk.gray('\u00b7')} ${time}`;
}

function renderStats(state: ExperimentState): string {
  const parts: string[] = [];
  parts.push(chalk.white(`${state.completedEvals}/${state.totalEvals}`));
  if (state.passed > 0) parts.push(chalk.green(`${state.passed}\u2713`));
  if (state.failed > 0) parts.push(chalk.red(`${state.failed}\u2717`));
  return parts.join(' ');
}

/**
 * Format elapsed seconds as "Xm Ys" for >= 60s, otherwise "Xs".
 */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s > 0 ? ` ${s}s` : ''}`;
}

/**
 * Render a progress bar.
 */
function renderBar(completed: number, total: number): string {
  const width = 20;
  const filled = total > 0 ? Math.min(width, Math.round((completed / total) * width)) : 0;
  const empty = width - filled;
  return chalk.green('\u2501'.repeat(filled)) + chalk.gray('\u2500'.repeat(empty));
}

/**
 * Render a permanent completed-experiment block that scrolls above the dashboard.
 */
export function renderCompletedBlock(
  experimentName: string,
  _state: ExperimentState,
  results: ExperimentResults,
  classifications: Map<string, Classification>
): string {
  const lines: string[] = [];
  const width = Math.min(process.stdout.columns || 80, 80);
  const separator = '\u2500'.repeat(width);

  lines.push(chalk.gray(separator));

  const totalEvals = results.evals.length;
  const passedEvals = results.evals.filter((e) => e.passedRuns > 0).length;
  const elapsed = Math.round(
    (new Date(results.completedAt).getTime() - new Date(results.startedAt).getTime()) / 1000
  );
  const passRate = totalEvals > 0 ? Math.round((passedEvals / totalEvals) * 100) : 0;
  const passColor = passRate === 100 ? chalk.green : passRate >= 50 ? chalk.yellow : chalk.red;

  lines.push(
    ` ${chalk.bold(experimentName)}  ${passColor(`${passedEvals}/${totalEvals} passed (${passRate}%)`)}  ${chalk.gray(formatElapsed(elapsed))}`
  );

  const passed = results.evals.filter((e) => e.passedRuns > 0);
  const failed = results.evals.filter((e) => e.passedRuns === 0);

  if (passed.length > 0) {
    lines.push(` ${passed.map((e) => chalk.green(`\u2713 ${e.name}`)).join('  ')}`);
  }
  if (failed.length > 0) {
    lines.push(` ${failed.map((e) => chalk.red(`\u2717 ${e.name}`)).join('  ')}`);
  }

  if (failed.length > 0 && classifications.size > 0) {
    for (const evalSummary of failed) {
      const c = classifications.get(evalSummary.name);
      if (c) {
        const suffix = c.failureType !== 'model'
          ? chalk.gray(c.acknowledged ? ' (kept)' : ' (removed)')
          : '';
        lines.push(chalk.gray(`   ${evalSummary.name}: ${c.failureType} \u2014 ${c.failureReason}${suffix}`));
      }
    }
  }

  lines.push(chalk.gray(separator));
  return lines.join('\n');
}

/**
 * Console-based progress handler for non-TTY / single experiment mode.
 */
export function createConsoleProgressHandler(context: {
  experimentName: string;
  model: string;
  agent: string;
}): (event: ProgressEvent) => void {
  return (event: ProgressEvent) => {
    switch (event.type) {
      case 'experiment:start':
        console.log(
          `Starting ${event.totalAttempts} eval attempts concurrently (${event.totalEvals} evals \u00d7 ${event.totalRuns} runs)`
        );
        break;
      case 'eval:start':
        console.log(
          createProgressDisplay(event.evalName, event.runNumber, event.totalRuns, context)
        );
        break;
      case 'eval:complete':
        console.log(
          formatRunResult(event.evalName, event.runNumber, event.totalRuns, event.result, context)
        );
        break;
      case 'experiment:earlyExit':
        console.log(
          `Early exit: ${event.evalName} passed on run ${event.runNumber}, aborting remaining attempts`
        );
        break;
      case 'experiment:saved':
        console.log(`\nResults saved to: ${event.outputDir}`);
        break;
      case 'experiment:summary':
        console.log(formatResultsTable(event.results));
        break;
    }
  };
}
