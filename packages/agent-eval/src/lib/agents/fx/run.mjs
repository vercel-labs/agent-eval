/**
 * fx in-sandbox runner. This file must remain zero-dependency.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {{prompt:string, agentOptions?:Record<string,unknown>}} input */
export function buildFxCliArgs(input) {
  const args = ['ask', '--yolo', '--json', '--no-color'];
  const effort = input.agentOptions?.effort;
  if (typeof effort === 'string' && effort) args.push('--effort', effort);
  args.push('--', input.prompt);
  return args;
}

/** @param {string} raw */
export function parseFxAskResult(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const value = JSON.parse(raw.trim());
    if (
      value &&
      typeof value === 'object' &&
      typeof value.output === 'string' &&
      typeof value.exit_code === 'number' &&
      Array.isArray(value.tool_calls)
    ) {
      return value;
    }
  } catch {
    // The caller reports malformed stdout as an agent failure.
  }
  return null;
}

/** @param {string} raw */
export function isFxSessionDetail(raw) {
  if (!raw || !raw.trim()) return false;
  try {
    const value = JSON.parse(raw.trim());
    return value?.kind === 'session_detail' && Array.isArray(value.history);
  } catch {
    return false;
  }
}

/**
 * Token usage from `fx ask --json`: the input and output tokens summed over the
 * main agent's completions, `null` when no completion reported a count. fx does
 * not break cache usage out, so `inputTokens` is the full prompt count. Mirrors
 * the ask-JSON branch of the host-side fx transcript parser, which this
 * zero-dependency runner cannot import.
 *
 * @param {unknown} askResult parsed `fx ask --json` output
 * @returns {{inputTokens?:number, outputTokens?:number, totalTokens?:number}|undefined}
 */
export function fxUsage(askResult) {
  const usage = askResult && typeof askResult === 'object' ? askResult.usage : undefined;
  const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
  const inputTokens = count(usage?.input_tokens);
  const outputTokens = count(usage?.output_tokens);
  const result = {};
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (inputTokens !== undefined && outputTokens !== undefined) result.totalTokens = inputTokens + outputTokens;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** @param {{model?:string}} input */
export function buildFxEnvironment(input) {
  const env = { ...process.env, FX_AUTO_UPGRADE: '0' };
  if (input.model) env.FX_MODEL = input.model;
  else delete env.FX_MODEL;
  return env;
}

/**
 * @param {import('../plugin/contract.js').AgentRunInput} input
 * @returns {Promise<import('../plugin/contract.js').RunnerResult>}
 */
export async function runAgent(input) {
  const binary = join(input.cwd, '__agent_eval__', 'bin', 'fx');
  const env = buildFxEnvironment(input);
  const res = spawnSync(binary, buildFxCliArgs(input), {
    cwd: input.cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const output = stdout + stderr;
  const askResult = parseFxAskResult(stdout);
  const processExitCode = res.status == null ? -1 : res.status;
  const agentExitCode = askResult?.exit_code ?? processExitCode;

  // The supported session projection is richer than fx ask's final summary.
  // Fall back to the ask JSON when a session cannot be read.
  let transcript = askResult ? stdout.trim() : null;
  if (askResult?.session_id) {
    const session = spawnSync(binary, ['session', '--id', askResult.session_id, '--json'], {
      cwd: input.cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (session.status === 0 && isFxSessionDetail(session.stdout || '')) {
      transcript = session.stdout.trim();
    }
  }

  // Usage is reported even when the run failed: a failed run still consumed tokens.
  const usage = fxUsage(askResult);
  const ok = !res.error && processExitCode === 0 && askResult?.exit_code === 0;
  if (!ok) {
    const errorLines = output.trim().split('\n').slice(-5).join('\n');
    const error = askResult?.error || (res.error ? `Failed to run fx: ${res.error.message}` : null);
    return {
      ok: false,
      output,
      transcript,
      observedModel: askResult?.model || null,
      error: error || errorLines || `fx exited with code ${agentExitCode}`,
      agentExitCode,
      ...(usage ? { usage } : {}),
    };
  }

  return {
    ok: true,
    output,
    transcript,
    observedModel: askResult.model || null,
    error: null,
    agentExitCode,
    ...(usage ? { usage } : {}),
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const input = JSON.parse(process.argv[2]);
  let result;
  try {
    result = await runAgent(input);
  } catch (error) {
    result = {
      ok: false,
      output: '',
      transcript: null,
      observedModel: null,
      error: error && error.message ? error.message : String(error),
      agentExitCode: -1,
    };
  }

  try {
    mkdirSync(dirname(input.resultPath), { recursive: true });
    writeFileSync(input.resultPath, JSON.stringify(result));
  } catch {
    // The marker below remains available when the result file cannot be written.
  }

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
  process.exit(0);
}
