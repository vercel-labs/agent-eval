/**
 * fx in-sandbox runner. This file must remain zero-dependency.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {{prompt:string}} input */
export function buildFxCliArgs(input) {
  return ['ask', '--yolo', '--json', '--no-color', '--', input.prompt];
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
    };
  }

  return {
    ok: true,
    output,
    transcript,
    observedModel: askResult.model || null,
    error: null,
    agentExitCode,
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
