/**
 * Claude Code in-sandbox runner.
 *
 * This file is shipped INTO the sandbox by the orchestrator and executed there as
 * `node __agent_eval__/run.mjs '<AgentRunInput JSON>'`. It is intentionally
 * ZERO-DEPENDENCY (only `node:*` builtins) because the sandbox only has the
 * fixture's own deps + the installed `claude` CLI — it cannot import anything from
 * the @vercel/agent-eval package.
 *
 * Dual mode:
 *   - runnable: invoked directly → reads argv, runs the agent, writes the result
 *     file + prints a status line, exits 0.
 *   - importable: `import { runAgent } from './run.mjs'` → returns a RunnerResult
 *     (no file write, no exit). This is what a future in-sandbox judge reuses.
 *
 * `buildClaudeCodeCliArgs` and `extractObservedModelFromClaudeTranscript` are
 * exported so the host unit tests can verify them directly (the test imports them
 * from this very file, so there is no risk of the tested logic drifting from the
 * logic the sandbox actually runs).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build the Claude Code CLI argument list.
 *
 * Order is regression-sensitive (preserved verbatim from the old adapter):
 * `--allowedTools` is variadic — it keeps consuming positional tokens until the
 * next flag. So (1) the tools must be a single comma-separated value, and (2)
 * `--allowedTools` must be followed by another flag, never directly by the prompt.
 * `--dangerously-skip-permissions` is always emitted and terminates the variadic
 * capture before the trailing positional prompt (the #141 regression).
 *
 * @param {{prompt:string, model?:string, webResearch?:boolean, disableBundledSkills?:boolean, agentOptions?:Record<string,unknown>}} input
 * @returns {string[]}
 */
export function buildClaudeCodeCliArgs(input) {
  const cliArgs = ['--print'];
  if (input.disableBundledSkills) {
    // CLI-scoped settings override only this run and preserve explicitly
    // installed project/user skills; --bare would hide treatment skills too.
    cliArgs.push('--settings', JSON.stringify({ disableBundledSkills: true }));
  }
  if (input.webResearch) {
    cliArgs.push('--allowedTools', 'WebSearch,WebFetch');
  }
  if (input.model) {
    cliArgs.push('--model', input.model);
  }
  cliArgs.push('--dangerously-skip-permissions');
  const effort = input.agentOptions?.effort;
  if (effort) {
    cliArgs.push('--effort', String(effort));
  }
  cliArgs.push(input.prompt);
  return cliArgs;
}

/**
 * Scan a Claude Code transcript (JSONL) for the last `message.model` seen.
 * Preserved verbatim from the old adapter. Non-JSON lines are ignored.
 *
 * @param {string|undefined|null} transcript
 * @returns {string|undefined}
 */
export function extractObservedModelFromClaudeTranscript(transcript) {
  if (!transcript) return undefined;

  let observedModel;
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (typeof event.message?.model === 'string') {
        observedModel = event.message.model;
      }
    } catch {
      // Ignore non-JSON transcript lines.
    }
  }
  return observedModel;
}

/**
 * Locate + read the Claude Code transcript file.
 *
 * Claude Code writes JSONL transcripts to
 * `~/.claude/projects/{cwd-with-slashes-as-dashes}/{session}.jsonl`. We pick the
 * newest `.jsonl` by mtime — the equivalent of the old adapter's
 * `ls -t ~/.claude/projects/<path>/*.jsonl | head -1`.
 *
 * Best-effort: any failure → null (never throws).
 *
 * @param {string} cwd post-relocation sandbox cwd (e.g. /workspace)
 * @returns {string|null}
 */
function captureClaudeTranscript(cwd) {
  try {
    const projectPath = cwd.replace(/\//g, '-');
    const dir = join(homedir(), '.claude', 'projects', projectPath);
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const full = join(dir, f);
        return { full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (!newest) return null;
    return readFileSync(newest.full, 'utf8') || null;
  } catch {
    return null;
  }
}

/**
 * Run Claude Code over the workspace at `input.cwd` and return a RunnerResult.
 *
 * Auth (ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/...) arrives via process.env — the
 * orchestrator sets it on the `node run.mjs` invocation, and we pass process.env
 * straight through to the CLI. The runner never handles secrets itself.
 *
 * @param {import('../plugin/contract.js').AgentRunInput} input
 * @returns {Promise<import('../plugin/contract.js').RunnerResult>}
 */
export async function runAgent(input) {
  const args = buildClaudeCodeCliArgs(input);

  // spawnSync (not a shell string): the prompt is a plain argv element, so there is
  // no shell quoting/escaping to get wrong. Blocking is fine — the runner has
  // nothing else to do while the agent works. The sandbox-level timeout bounds it.
  const res = spawnSync('claude', args, {
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

  // Capture transcript + observed model regardless of success (the old adapter did
  // this even on the non-zero-exit path).
  const transcript = captureClaudeTranscript(input.cwd);
  const observedModel = extractObservedModelFromClaudeTranscript(transcript) ?? null;

  if (res.error || agentExitCode !== 0) {
    // Mirror the old error string: last 5 lines of output, else a coded fallback.
    const errorLines = output.trim().split('\n').slice(-5).join('\n');
    const fallback = res.error
      ? `Failed to run claude: ${res.error.message}`
      : `Claude Code exited with code ${agentExitCode}`;
    return {
      ok: false,
      output,
      transcript,
      observedModel,
      error: errorLines || fallback,
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
