/**
 * Reporters: first-class hooks that send results somewhere besides the local
 * results/ tree.
 *
 * The runner calls {@link notifyRunComplete} once per finished run and
 * {@link notifyExperimentComplete} once per experiment. Both isolate reporter
 * failures: an error is caught, redacted, handed to `onFailure`, and the next
 * reporter still runs. Nothing a reporter does can change an eval result.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  ProgressEvent,
  Reporter,
  ReporterExperimentEvent,
  ReporterRunEvent,
} from './types.js';
import { redactSecrets, redactValue } from './agents/redact.js';

/** One reporter call that threw or rejected. */
export interface ReporterFailure {
  /** Name of the reporter that failed. */
  reporter: string;
  /** Which hook failed. */
  hook: 'onRunComplete' | 'onExperimentComplete';
  /** Set for run events. */
  evalName?: string;
  /** Zero-based attempt index, set for run events. */
  runIndex?: number;
  /** The error message, redacted. */
  error: string;
}

/** How to deliver an event to a list of reporters. */
export interface ReporterDispatchOptions {
  /** Credentials to scrub from the payload and from error messages. */
  secrets: readonly (string | undefined)[];
  /** Called for each reporter call that fails. */
  onFailure?: (failure: ReporterFailure) => void;
}

/** One line describing a failed reporter call, for the CLI and logs. */
export function formatReporterError(event: Extract<ProgressEvent, { type: 'reporter:error' }>): string {
  const where = event.evalName
    ? ` for ${event.evalName}${event.runNumber !== undefined ? ` run ${event.runNumber}` : ''}`
    : '';
  return `\u26a0 Reporter "${event.reporter}" failed in ${event.hook}${where}: ${event.error}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Deliver a run event to every reporter with an `onRunComplete` hook, in order.
 * Returns the failures (also passed to `onFailure`).
 */
export async function notifyRunComplete(
  reporters: readonly Reporter[],
  event: ReporterRunEvent,
  options: ReporterDispatchOptions,
): Promise<ReporterFailure[]> {
  const listening = reporters.filter((reporter) => reporter.onRunComplete);
  if (listening.length === 0) return [];

  const payload = redactValue(event, options.secrets);
  const failures: ReporterFailure[] = [];
  for (const reporter of listening) {
    try {
      await reporter.onRunComplete!(payload);
    } catch (error) {
      const failure: ReporterFailure = {
        reporter: reporter.name,
        hook: 'onRunComplete',
        evalName: event.evalName,
        runIndex: event.runIndex,
        error: redactSecrets(errorMessage(error), options.secrets),
      };
      failures.push(failure);
      options.onFailure?.(failure);
    }
  }
  return failures;
}

/**
 * Deliver an experiment event to every reporter with an
 * `onExperimentComplete` hook, in order. Returns the failures (also passed to
 * `onFailure`).
 */
export async function notifyExperimentComplete(
  reporters: readonly Reporter[],
  event: ReporterExperimentEvent,
  options: ReporterDispatchOptions,
): Promise<ReporterFailure[]> {
  const listening = reporters.filter((reporter) => reporter.onExperimentComplete);
  if (listening.length === 0) return [];

  const payload = redactValue(event, options.secrets);
  const failures: ReporterFailure[] = [];
  for (const reporter of listening) {
    try {
      await reporter.onExperimentComplete!(payload);
    } catch (error) {
      const failure: ReporterFailure = {
        reporter: reporter.name,
        hook: 'onExperimentComplete',
        error: redactSecrets(errorMessage(error), options.secrets),
      };
      failures.push(failure);
      options.onFailure?.(failure);
    }
  }
  return failures;
}

/**
 * The JSON form of an experiment event used by the built-in reporters.
 *
 * `results` in a {@link ReporterExperimentEvent} carries everything the run
 * produced: transcripts, script output, and generated files as raw bytes. A
 * network payload doesn't need those (they're on disk under `outputDir`), so
 * each run is reduced to its `result`. Config functions and the reporters
 * themselves are left out too, since they aren't data.
 */
export function experimentEventToJson(event: ReporterExperimentEvent): Record<string, unknown> {
  const { results } = event;
  const config = Object.fromEntries(
    Object.entries(results.config).filter(
      ([key, value]) => key !== 'reporters' && typeof value !== 'function'
    )
  );
  const evals = results.evals.map(({ runs, ...summary }) => ({
    ...summary,
    runs: runs.map((run) => run.result),
  }));
  return {
    ...event,
    results: { startedAt: results.startedAt, completedAt: results.completedAt, config, evals },
  };
}

/** Options for {@link jsonlReporter}. */
export interface JsonlReporterOptions {
  /** File to append to. Parent directories are created. */
  path: string;
}

/**
 * Append one JSON line per finished run to a file. Each line is a
 * {@link ReporterRunEvent}. Writes are serialized, so concurrent runs never
 * interleave lines.
 *
 * @example
 * ```ts
 * reporters: [jsonlReporter({ path: 'results/runs.jsonl' })]
 * ```
 */
export function jsonlReporter(options: JsonlReporterOptions): Reporter {
  let pending: Promise<void> = Promise.resolve();
  return {
    name: 'jsonl',
    onRunComplete(event) {
      const line = `${JSON.stringify(event)}\n`;
      const write = pending.then(async () => {
        await mkdir(dirname(options.path), { recursive: true });
        await appendFile(options.path, line, 'utf-8');
      });
      // A failed write fails only its own event; later events still write.
      pending = write.catch(() => {});
      return write;
    },
  };
}

/** Options for {@link httpReporter}. */
export interface HttpReporterOptions {
  /** Endpoint that receives a JSON POST per event. */
  url: string;
  /** Extra request headers, for example an authorization header. */
  headers?: Record<string, string>;
  /** Retries after the first attempt for network errors, 429, and 5xx responses. @default 2 */
  retries?: number;
  /** Delay before the first retry, doubled for each later one. @default 500 */
  retryDelayMs?: number;
}

/**
 * POST each event as JSON. Run events are sent as
 * `{ "type": "run", ...ReporterRunEvent }`; experiment events as
 * `{ "type": "experiment", ...experimentEventToJson(event) }`. Network errors,
 * 429, and 5xx responses are retried with exponential backoff; other non-2xx
 * responses fail at once.
 *
 * @example
 * ```ts
 * reporters: [
 *   httpReporter({
 *     url: 'https://example.com/ingest',
 *     headers: { authorization: `Bearer ${process.env.INGEST_TOKEN}` },
 *   }),
 * ]
 * ```
 */
export function httpReporter(options: HttpReporterOptions): Reporter {
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 500;

  const post = async (body: unknown): Promise<void> => {
    const payload = JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      let failure: string;
      let retryable: boolean;
      try {
        const response = await fetch(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...options.headers },
          body: payload,
        });
        if (response.ok) return;
        failure = `HTTP ${response.status} from ${options.url}`;
        retryable = response.status === 429 || response.status >= 500;
      } catch (error) {
        failure = `POST ${options.url} failed: ${errorMessage(error)}`;
        retryable = true;
      }
      if (!retryable || attempt >= retries) throw new Error(failure);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
    }
  };

  return {
    name: 'http',
    onRunComplete: (event) => post({ type: 'run', ...event }),
    onExperimentComplete: (event) => post({ type: 'experiment', ...experimentEventToJson(event) }),
  };
}
