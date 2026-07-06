/**
 * OpenCode in-sandbox runner.
 *
 * This file is shipped INTO the sandbox by the orchestrator and executed there as
 * `node __agent_eval__/run.mjs '<AgentRunInput JSON>'`. It is intentionally
 * ZERO-DEPENDENCY (only `node:*` builtins) because the sandbox only has the
 * fixture's own deps + the installed `opencode` CLI — it cannot import anything
 * from the @vercel/agent-eval package.
 *
 * Dual mode:
 *   - runnable: invoked directly → reads argv, runs the agent, writes the result
 *     file + prints a status line, exits 0.
 *   - importable: `import { runAgent } from './run.mjs'` → returns a RunnerResult
 *     (no file write, no exit). This is what a future in-sandbox judge reuses.
 *
 * The pure helpers below are exported (not just `runAgent`) so they can be
 * unit-tested directly — the same code the sandbox runs (see opencode.test.ts).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build the OpenCode CLI argument list.
 *
 *   - `run <prompt> --format json` is always emitted (`--format json` gives the
 *     structured JSON event stream we parse for the transcript).
 *   - `--model <extra.cliModel>` is appended when a model override is present.
 *     cliModel is HOST-computed (resolveOpenCodeModel in agent.ts, threaded via
 *     runnerExtra like codex's resolved model) so a canonical gateway id like
 *     `anthropic/claude-sonnet-5` arrives as `vercel/anthropic/claude-sonnet-5` —
 *     the form OpenCode routes through the configured `vercel` provider. There is
 *     deliberately NO fallback to input.model: passing it verbatim is the exact
 *     mis-route this fixes, and both runner entry points (the orchestrator and
 *     the judge's eval-helper) always ship extra.
 *   - else, when modelPolicy === 'native-default', `--print-logs --log-level INFO`
 *     is appended so older OpenCode versions print the CLI-selected model (the
 *     log-scrape path) without a follow-up export call.
 *
 * @param {{prompt:string, modelPolicy?:string, extra?:Record<string,unknown>}} input
 * @returns {string[]}
 */
export function buildOpenCodeCliArgs(input) {
  const cliArgs = ['run', input.prompt, '--format', 'json'];
  const cliModel = input.extra?.cliModel;
  if (cliModel) {
    cliArgs.push('--model', String(cliModel));
  } else if (input.modelPolicy === 'native-default') {
    cliArgs.push('--print-logs', '--log-level', 'INFO');
  }
  return cliArgs;
}

/**
 * Report the observed model in the caller's namespace.
 *
 * When the host prefixed the requested model with `vercel/` (extra.cliModel !==
 * input.model), OpenCode observes it back in its own provider namespace —
 * `vercel/anthropic/claude-sonnet-5` for a requested `anthropic/claude-sonnet-5`.
 * Un-apply exactly that translation so observed === requested holds for callers
 * that speak canonical gateway ids, and a gateway substitution still surfaces as
 * a clean gateway id (`anthropic/claude-haiku-4`, not `vercel/anthropic/...`).
 *
 * Everything else passes through untouched: native-default runs (no override —
 * consumers already treat `vercel/google/gemini-3-pro-preview` as canonical),
 * callers that already speak OpenCode's namespace (`vercel/...` requested), and
 * extraProviders runs (their providerID isn't `vercel`).
 *
 * @param {string|undefined} observedModel
 * @param {{model?:string, extra?:Record<string,unknown>}} input
 * @returns {string|undefined}
 */
export function normalizeObservedModel(observedModel, input) {
  if (!observedModel) {
    return observedModel;
  }
  const cliModel = input.extra?.cliModel;
  const hostPrefixed = typeof cliModel === 'string' && cliModel !== input.model;
  if (hostPrefixed && observedModel.startsWith('vercel/')) {
    return observedModel.slice('vercel/'.length);
  }
  return observedModel;
}

/**
 * Extract transcript from OpenCode JSON output.
 * When run with --format json, OpenCode outputs JSON events to stdout.
 * Preserved verbatim from the old adapter.
 *
 * @param {string|undefined|null} output
 * @returns {string|undefined}
 */
export function extractTranscriptFromOutput(output) {
  if (!output || !output.trim()) {
    return undefined;
  }

  // The --format json output contains JSON events, one per line.
  // Filter to only include lines that look like JSON objects.
  const lines = output.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('{') && trimmed.endsWith('}');
  });

  if (lines.length === 0) {
    return undefined;
  }

  return lines.join('\n');
}

/**
 * Scrape the OpenCode printed logs for the primary build model.
 * Works on OpenCode <= 1.16.x, whose INFO log lines carry providerID/modelID.
 * Preserved verbatim from the old adapter.
 *
 * @param {string} output
 * @returns {string|undefined}
 */
export function extractObservedModelFromOpenCodeOutput(output) {
  let observedModel;

  for (const line of output.split('\n')) {
    if (!line.includes('service=llm') || !line.includes('small=false') || !line.includes('agent=build')) {
      continue;
    }

    const providerMatch = line.match(/providerID=([^\s]+)/);
    const modelMatch = line.match(/modelID=([^\s]+)/);
    const providerID = providerMatch?.[1];
    const modelID = modelMatch?.[1];
    if (providerID && modelID) {
      observedModel = `${providerID}/${modelID}`;
    }
  }

  return observedModel;
}

/**
 * Extract the session id from the `--format json` event stream.
 * Every emitted event carries a `sessionID` field.
 * Preserved verbatim from the old adapter.
 *
 * @param {string|undefined} transcript
 * @returns {string|undefined}
 */
export function extractSessionIdFromTranscript(transcript) {
  if (!transcript) {
    return undefined;
  }

  for (const line of transcript.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (typeof event.sessionID === 'string' && event.sessionID) {
        return event.sessionID;
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return undefined;
}

/**
 * Extract the observed model from `opencode export <sessionID>` output.
 * Assistant messages carry `providerID` and `modelID` in their info.
 * Preserved verbatim from the old adapter.
 *
 * @param {string} exportOutput
 * @returns {string|undefined}
 */
export function extractObservedModelFromSessionExport(exportOutput) {
  const start = exportOutput.indexOf('{');
  if (start === -1) {
    return undefined;
  }

  let parsed;
  try {
    parsed = JSON.parse(exportOutput.slice(start));
  } catch {
    return undefined;
  }

  const messages = parsed.messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }

  for (const message of messages) {
    const info = message.info;
    if (info?.role !== 'assistant') {
      continue;
    }
    if (
      typeof info.providerID === 'string' && info.providerID &&
      typeof info.modelID === 'string' && info.modelID
    ) {
      return `${info.providerID}/${info.modelID}`;
    }
  }

  return undefined;
}

/**
 * Run OpenCode over the workspace at `input.cwd` and return a RunnerResult.
 *
 * Auth (AI_GATEWAY_API_KEY, and OPENCODE_ENABLE_EXA when web research is on)
 * arrives via process.env — the orchestrator sets it on the `node run.mjs`
 * invocation, and we pass process.env straight through to the CLI. The runner
 * never handles secrets itself.
 *
 * @param {import('../plugin/contract.js').AgentRunInput} input
 * @returns {Promise<import('../plugin/contract.js').RunnerResult>}
 */
export async function runAgent(input) {
  const args = buildOpenCodeCliArgs(input);

  // spawnSync (not a shell string): the prompt is a plain argv element, so there
  // is no shell quoting/escaping to get wrong. Blocking is fine — the runner has
  // nothing else to do while the agent works. The sandbox-level timeout bounds it.
  const res = spawnSync('opencode', args, {
    cwd: input.cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  // Preserve the old concatenation order: stdout THEN stderr.
  const output = stdout + stderr;
  // spawnSync sets status=null + error when the binary can't be spawned at all.
  const agentExitCode = res.status == null ? -1 : res.status;

  // Capture the transcript from the combined output (old: over stdout+stderr).
  const transcript = extractTranscriptFromOutput(output) ?? null;

  // Resolve the model OpenCode actually used. The `--format json` events never
  // include it, so first try scraping the printed logs (works on OpenCode <=
  // 1.16.x), then fall back to `opencode export <sessionID>`, whose assistant
  // messages carry providerID/modelID (OpenCode 1.17.0 changed the log format,
  // which broke the scrape). Observation must never fail the run.
  let observedModel = extractObservedModelFromOpenCodeOutput(output);
  if (!observedModel) {
    const sessionId = extractSessionIdFromTranscript(transcript ?? undefined);
    if (sessionId) {
      try {
        const exportRes = spawnSync('opencode', ['export', sessionId], {
          cwd: input.cwd,
          env: process.env,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
        if ((exportRes.status == null ? -1 : exportRes.status) === 0) {
          observedModel = extractObservedModelFromSessionExport(exportRes.stdout || '');
        }
      } catch {
        // Leave observedModel undefined.
      }
    }
  }
  const observedModelOrNull = normalizeObservedModel(observedModel, input) ?? null;

  if (res.error || agentExitCode !== 0) {
    // Mirror the old error string: last 5 lines of output, else a coded fallback.
    const errorLines = output.trim().split('\n').slice(-5).join('\n');
    const fallback = res.error
      ? `Failed to run opencode: ${res.error.message}`
      : `OpenCode CLI exited with code ${agentExitCode}`;
    return {
      ok: false,
      output,
      transcript,
      observedModel: observedModelOrNull,
      error: errorLines || fallback,
      agentExitCode,
    };
  }

  return {
    ok: true,
    output,
    transcript,
    observedModel: observedModelOrNull,
    error: null,
    agentExitCode,
  };
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
