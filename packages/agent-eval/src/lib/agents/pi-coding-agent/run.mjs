/**
 * PI coding agent in-sandbox runner.
 *
 * This file is shipped INTO the sandbox by the orchestrator and executed there as
 * `node __agent_eval__/run.mjs '<AgentRunInput JSON>'`. It is intentionally
 * ZERO-DEPENDENCY (only `node:*` builtins) because the sandbox only has the
 * fixture's own deps + the installed `pi` CLI — it cannot import anything from
 * the @vercel/agent-eval package.
 *
 * Dual mode:
 *   - runnable: invoked directly → reads argv, runs the agent, writes the result
 *     file + prints a status line, exits 0.
 *   - importable: `import { runAgent } from './run.mjs'` → returns a RunnerResult
 *     (no file write, no exit). This is what the in-sandbox judge reuses.
 *
 * The pure helpers below are exported (not just `runAgent`) so they can be
 * unit-tested directly — the same code the sandbox runs (see pi-coding-agent.test.ts).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build the PI CLI argument list.
 *
 *   - `--mode json` emits every session event as JSONL on stdout (the transcript)
 *     and exits when the agent is done. PI has no approval prompts, so there is
 *     no "yolo" flag to pass.
 *   - `--no-session`: the JSON stream already carries everything we persist.
 *   - `--provider vercel-ai-gateway --model <model>` when a model override is
 *     present. The provider is pinned because gateway ids (`anthropic/…`) would
 *     otherwise be read as `<provider>/<model>`. On a native-default run both
 *     are omitted — PI rejects `--provider` without `--model` — and PI picks its
 *     own default from the only authenticated provider, the gateway.
 *   - `--thinking <extra.thinking>` when set. HOST-threaded (agent.ts
 *     runnerExtra) rather than read from agentOptions, so the judge's
 *     eval-helper invocation — which ships extra but no agentOptions — gets it too.
 *
 * The prompt is deliberately NOT an argument: PI parses positionals starting
 * with `@` as file attachments and `-` as flags. It is piped on stdin instead,
 * which PI reads as the initial message (see runAgent).
 *
 * @param {{model?:string, extra?:Record<string,unknown>}} input
 * @returns {string[]}
 */
export function buildPiCliArgs(input) {
  const args = ['--mode', 'json', '--no-session'];
  if (input.model) {
    args.push('--provider', 'vercel-ai-gateway', '--model', input.model);
  }
  const thinking = input.extra?.thinking;
  if (thinking) {
    args.push('--thinking', String(thinking));
  }
  return args;
}

/**
 * Events dropped from the transcript. `message_update` / `tool_execution_update`
 * are per-token streaming deltas that each repeat the whole partial message, and
 * `turn_end` / `agent_end` repeat every message already emitted by `message_end`
 * — they bloat the raw stream while adding nothing the remaining events don't
 * carry.
 */
const REDUNDANT_EVENT_TYPES = new Set([
  'message_start',
  'message_update',
  'tool_execution_update',
  'turn_end',
  'agent_end',
]);

/**
 * Parse one line of PI's `--mode json` stdout into its event, or undefined for
 * anything that is not a JSON event.
 *
 * @param {string} line
 * @returns {Record<string, any>|undefined}
 */
export function parsePiEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  try {
    const event = JSON.parse(trimmed);
    return event && typeof event.type === 'string' ? event : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether an event is left out of the transcript (see REDUNDANT_EVENT_TYPES).
 *
 * @param {Record<string, any>} event
 * @returns {boolean}
 */
export function isRedundantPiEvent(event) {
  return REDUNDANT_EVENT_TYPES.has(event.type);
}

/**
 * Serialize the kept events as the JSONL transcript.
 *
 * @param {Array<Record<string, any>>} events
 * @returns {string|undefined}
 */
export function serializeTranscript(events) {
  if (events.length === 0) {
    return undefined;
  }
  return events.map((event) => JSON.stringify(event)).join('\n');
}

/** @param {Array<Record<string, any>>} events */
function lastAssistantMessage(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      return event.message;
    }
  }
  return undefined;
}

/**
 * The model PI actually used: every assistant message carries it. Reported as
 * PI's model id — the same namespace `--model` is requested in.
 *
 * @param {Array<Record<string, any>>} events
 * @returns {string|undefined}
 */
export function extractObservedModelFromEvents(events) {
  const model = lastAssistantMessage(events)?.model;
  return typeof model === 'string' && model ? model : undefined;
}

/**
 * The run's failure, if PI reported one in-band. In JSON mode PI exits 0 even
 * when the provider call failed (bad key, unknown model id, network error, all
 * retries exhausted): the only signal is the final assistant message ending with
 * stopReason 'error' / 'aborted'. Without this check such a run would be graded
 * as a success that simply wrote no code.
 *
 * @param {Array<Record<string, any>>} events
 * @returns {string|undefined}
 */
export function extractAgentErrorFromEvents(events) {
  const message = lastAssistantMessage(events);
  if (message?.stopReason === 'error' || message?.stopReason === 'aborted') {
    return message.errorMessage || `PI stopped with reason "${message.stopReason}"`;
  }
  return undefined;
}

/**
 * Run PI over the workspace at `input.cwd` and return a RunnerResult.
 *
 * Auth (AI_GATEWAY_API_KEY) arrives via
 * process.env — the orchestrator sets it on the `node run.mjs` invocation, and we
 * pass process.env straight through to the CLI. The runner never handles secrets
 * itself.
 *
 * @param {import('../plugin/contract.js').AgentRunInput} input
 * @returns {Promise<import('../plugin/contract.js').RunnerResult>}
 */
export async function runAgent(input) {
  const args = buildPiCliArgs(input);

  // spawnSync (not a shell string), like the other runners. The prompt goes in on
  // stdin (see buildPiCliArgs) — which also closes the pipe: PI waits for stdin
  // EOF before it starts. Blocking is fine — the runner has nothing else to do
  // while the agent works. The sandbox-level timeout bounds it.
  const res = spawnSync('pi', args, {
    cwd: input.cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    input: input.prompt,
  });

  const stderr = res.stderr || '';
  // spawnSync sets status=null + error when the binary can't be spawned at all.
  const agentExitCode = res.status == null ? -1 : res.status;
  const spawnError = res.error;

  // Split stdout into the kept events (the transcript) and anything PI printed
  // outside the event stream.
  const events = [];
  let strayOutput = '';
  for (const line of (res.stdout || '').split('\n')) {
    const event = parsePiEventLine(line);
    if (!event) {
      if (line.trim()) strayOutput += line + '\n';
    } else if (!isRedundantPiEvent(event)) {
      events.push(event);
    }
  }

  const transcript = serializeTranscript(events) ?? null;
  const observedModel = extractObservedModelFromEvents(events) ?? null;
  // stdout THEN stderr, like the other runners — with the filtered event stream
  // standing in for the raw one.
  const output = (transcript ? transcript + '\n' : '') + strayOutput + stderr;

  const agentError = extractAgentErrorFromEvents(events);

  if (spawnError || agentExitCode !== 0 || agentError) {
    // Last 5 lines of what PI printed outside the event stream (startup errors go
    // to stderr), else a coded fallback.
    const errorLines = (strayOutput + stderr).trim().split('\n').slice(-5).join('\n');
    const fallback = spawnError
      ? `Failed to run pi: ${spawnError.message}`
      : `PI CLI exited with code ${agentExitCode}`;
    return {
      ok: false,
      output,
      transcript,
      observedModel,
      error: agentError || errorLines || fallback,
      agentExitCode,
    };
  }

  return { ok: true, output, transcript, observedModel, error: null, agentExitCode };
}

/* ─────────────────────────── runnable (CLI) entry ─────────────────────────── */

// True when this file is executed directly (`node run.mjs ...`), false when imported.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  // argv[2] is the AgentRunInput JSON (never contains secrets).
  const input = JSON.parse(process.argv[2]);

  // Always produce a RunnerResult, even if the runner itself throws, so the host
  // always has a result file to read (node exit code stays 0 except on a truly
  // unrecoverable crash before we can write).
  let result;
  try {
    result = await runAgent(input);
  } catch (e) {
    result = {
      ok: false,
      output: '',
      transcript: null,
      observedModel: null,
      error: e && e.message ? e.message : String(e),
      agentExitCode: -1,
    };
  }

  // Source of truth: the result file the host reads back via sandbox.readFile.
  try {
    mkdirSync(dirname(input.resultPath), { recursive: true });
    writeFileSync(input.resultPath, JSON.stringify(result));
  } catch {
    // If the file can't be written, the host falls back to the marker line below.
  }

  // Fallback channel: a compact status line (no transcript — it can be huge).
  process.stdout.write(
    '__AGENT_RESULT__ ' +
      JSON.stringify({
        ok: result.ok,
        observedModel: result.observedModel,
        error: result.error,
        agentExitCode: result.agentExitCode,
      }) +
      '\n'
  );

  // Exit 0: "the runner ran". Agent success/failure is conveyed via result.ok, not
  // the node exit code (the host distinguishes the two).
  process.exit(0);
}
