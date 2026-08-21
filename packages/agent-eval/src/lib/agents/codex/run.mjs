/**
 * OpenAI Codex in-sandbox runner.
 *
 * This file is shipped INTO the sandbox by the orchestrator and executed there as
 * `node __agent_eval__/run.mjs '<AgentRunInput JSON>'`. It is intentionally
 * ZERO-DEPENDENCY (only `node:*` builtins) because the sandbox only has the
 * fixture's own deps + the installed `codex` CLI — it cannot import anything from
 * the @vercel/agent-eval package.
 *
 * Dual mode:
 *   - runnable: invoked directly → reads argv, runs the agent, writes the result
 *     file + prints a status line, exits 0.
 *   - importable: `import { runAgent } from './run.mjs'` → returns a RunnerResult
 *     (no file write, no exit). This is what a future in-sandbox judge reuses.
 *
 * The pure helpers below are exported (not just `runAgent`) so they can be
 * unit-tested directly — the same code the sandbox runs (see codex.test.ts).
 *
 * SECRETS: the apiKey is NOT in the AgentRunInput JSON. It arrives via process.env
 * (AI_GATEWAY_API_KEY for the gateway, else OPENAI_API_KEY for direct OpenAI) and
 * is piped into `codex login --with-api-key` over stdin — never on the argv.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Extract transcript from Codex JSON output.
 * When run with --json, Codex outputs JSONL to stdout with the full transcript.
 * Preserved verbatim from the old adapter.
 *
 * @param {string} output
 * @returns {string|undefined}
 */
export function extractTranscriptFromOutput(output) {
  if (!output || !output.trim()) {
    return undefined;
  }

  // The --json output is already the transcript in JSONL format.
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
 * Find the `thread.started` event's thread_id in Codex JSON stdout.
 * Preserved verbatim from the old adapter. Non-JSON lines are ignored.
 *
 * @param {string} output
 * @returns {string|undefined}
 */
export function extractCodexThreadId(output) {
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        return event.thread_id;
      }
    } catch {
      // Ignore non-JSON output lines.
    }
  }

  return undefined;
}

/**
 * Scan a Codex session transcript (JSONL) for the last `turn_context` model seen.
 * Preserved verbatim from the old adapter. Non-JSON lines are ignored.
 *
 * @param {string|undefined} transcript
 * @returns {string|undefined}
 */
export function extractObservedModelFromCodexSession(transcript) {
  if (!transcript) return undefined;

  let observedModel;
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const model = event.payload?.model ?? event.payload?.collaboration_mode?.settings?.model;
      if (event.type === 'turn_context' && typeof model === 'string') {
        observedModel = model;
      }
    } catch {
      // Ignore non-JSON transcript lines.
    }
  }

  return observedModel;
}

/**
 * Recursively collect every `*.jsonl` file path under `~/.codex/sessions`.
 * The old adapter used `find ~/.codex/sessions -type f -name '*.jsonl'`.
 *
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function listSessionFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSessionFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Locate + read the Codex session transcript file.
 *
 * Codex writes JSONL session files under `~/.codex/sessions`. The old adapter, in
 * shell, did:
 *   - with a threadId: `find ... -name '*<threadId>*.jsonl' | head -1`
 *   - without:         `find ... -name '*.jsonl' | sort | tail -1`
 *
 * We mirror that exactly: filter by threadId substring when present (first match),
 * otherwise lexicographically sort all `.jsonl` paths and take the last. Codex
 * session filenames are timestamp-prefixed, so the lexicographic max is the newest.
 *
 * Best-effort: any failure → undefined (never throws).
 *
 * @param {string|undefined} threadId
 * @returns {string|undefined}
 */
function captureCodexSessionTranscript(threadId) {
  try {
    const sessionsDir = join(homedir(), '.codex', 'sessions');
    const files = listSessionFiles(sessionsDir);
    if (files.length === 0) return undefined;

    let chosen;
    if (threadId) {
      // `find ... | head -1`: the first match in the traversal order.
      chosen = files.find((f) => f.includes(threadId));
    } else {
      // `find ... | sort | tail -1`: lexicographic max.
      chosen = files.slice().sort()[files.length - 1];
    }
    if (!chosen) return undefined;
    return readFileSync(chosen, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Build the `codex login --with-api-key` arg list. The key itself is piped over
 * stdin (spawnSync { input }), never placed on the argv.
 *
 * @returns {string[]}
 */
export function buildCodexLoginArgs() {
  return ['login', '--with-api-key'];
}

/**
 * Build the `codex exec` arg list, reproducing the old shell command verbatim:
 *   codex exec --profile default[ --model <m>] --dangerously-bypass-approvals-and-sandbox
 *     --json --skip-git-repo-check[ -c model_reasoning_effort="<e>"]
 *     [ -c model_verbosity="<v>"] '<prompt>'
 *
 * The model / reasoningEffort / verbosity values are HOST-computed (from
 * parseModelString) and arrive via input.extra so they match the TOML profile.
 *
 * Note: with spawnSync (argv, not a shell), the `-c key="value"` tokens keep their
 * literal quotes exactly as the old shell string had them, and the prompt is a
 * plain argv element (no shell escaping needed).
 *
 * @param {{prompt:string, webResearch?:boolean, disableBundledSkills?:boolean, extra?:Record<string,unknown>}} input
 * @returns {string[]}
 */
export function buildCodexExecArgs(input) {
  const extra = input.extra ?? {};
  const cliModel = extra.cliModel ?? null;
  const reasoningEffort = extra.reasoningEffort ?? null;
  const verbosity = extra.verbosity ?? null;

  const args = [];
  if (input.webResearch || input.disableBundledSkills) {
    // Opt-in capability controls must fail loudly on a CLI version that does
    // not recognize their generated profile settings.
    args.push('--strict-config');
  }
  if (input.webResearch) {
    // Current Codex CLI flag; the generated profile also opts the custom
    // Gateway provider into standalone live search. --search is a global
    // option and must precede the exec subcommand.
    args.push('--search');
  }
  args.push('exec', '--profile', 'default');
  if (cliModel) {
    args.push('--model', String(cliModel));
  }
  args.push('--dangerously-bypass-approvals-and-sandbox', '--json', '--skip-git-repo-check');
  if (reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
  }
  if (verbosity) {
    args.push('-c', `model_verbosity="${verbosity}"`);
  }
  args.push(input.prompt);
  return args;
}

/* ────────────────── native-default shell-tool canary + repair ──────────────────
 *
 * Codex CLI >= 0.144.0 exposes NO shell/exec tool to the model when config.toml
 * has a custom `model_provider` (e.g. the AI Gateway) and omits the `model` key —
 * exactly the shape native-default runs write. The model answers, but it cannot
 * run commands, read files, or use installed skills, and it sometimes FABRICATES
 * command output instead of reporting the missing tool. Verified empirically:
 * 0.143.0 is the last good version; adding an explicit `model = "<the same model
 * the CLI resolves natively>"` fully restores the tool.
 *
 * Because fabrication makes post-hoc transcript checks unreliable, native-default
 * runs are pre-verified with a shell canary before the real task:
 *   1. canary exec: ask codex to `echo <random nonce>`. PROOF is a
 *      `command_execution` item whose output contains the nonce — an
 *      agent_message merely echoing the nonce is NOT accepted (fabrication).
 *   2. If the canary fails: read the model the CLI natively resolved from the
 *      canary's own session file, prepend an explicit `model = "openai/<it>"` line
 *      to ~/.codex/default.config.toml (same semantics — the CLI chose the model;
 *      we only re-state it), and re-run the canary.
 *   3. If the canary still fails, the run errors LOUDLY instead of executing a
 *      toolless agent and publishing it as normal behavior. The canary's captured
 *      output is preserved on that error result for triage.
 *
 * The verified outcome is memoized in ~/.codex (CANARY_MARKER_PATH): judge
 * assertions re-invoke this runner once per assertion in the same sandbox, and
 * without the marker each assertion would pay its own canary exec.
 */

/** Marker file memoizing the canary outcome for the sandbox's lifetime. */
const CANARY_MARKER_FILENAME = 'agent-eval-canary.json';

/**
 * Parse the canary marker file's contents. Returns `{ repairedModel }` when the
 * marker records a verified shell tool (repairedModel is null when no repair was
 * needed), or null when the contents are not a valid marker.
 *
 * @param {string|undefined} raw
 * @returns {{repairedModel: string|null}|null}
 */
export function parseCanaryMarker(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.verified === true) {
      return { repairedModel: typeof parsed.repairedModel === 'string' ? parsed.repairedModel : null };
    }
  } catch {
    // Corrupt marker → treat as absent and re-verify.
  }
  return null;
}

/**
 * Canary prompt. The nonce is random per run so a cached/fabricated answer can
 * never pass. Kept terse to minimize tokens.
 *
 * @param {string} nonce
 * @returns {string}
 */
export function buildShellCanaryPrompt(nonce) {
  return `Run the shell command \`echo ${nonce}\` and reply with its exact output. If you cannot run shell commands, reply exactly: NO-SHELL-TOOL`;
}

/**
 * Build the canary input with the same capability flags as the real task.
 *
 * @param {import('../plugin/contract.js').AgentRunInput} input
 * @param {string} nonce
 * @returns {import('../plugin/contract.js').AgentRunInput}
 */
export function buildShellCanaryInput(input, nonce) {
  return {
    ...input,
    prompt: buildShellCanaryPrompt(nonce),
  };
}

/**
 * True iff the codex --json stdout proves the shell ran: a completed
 * `command_execution` item with exit_code 0 whose command or aggregated_output
 * contains the nonce. Agent messages containing the nonce do NOT count — a
 * toolless codex has been observed inventing plausible command output.
 *
 * @param {string} stdout
 * @param {string} nonce
 * @returns {boolean}
 */
export function shellCanaryConfirmed(stdout, nonce) {
  if (!stdout) return false;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const item = event.item;
      if (
        event.type === 'item.completed' &&
        item &&
        item.type === 'command_execution' &&
        item.exit_code === 0 &&
        ((typeof item.command === 'string' && item.command.includes(nonce)) ||
          (typeof item.aggregated_output === 'string' && item.aggregated_output.includes(nonce)))
      ) {
        return true;
      }
    } catch {
      // Ignore non-JSON output lines.
    }
  }
  return false;
}

/**
 * The config repair: an explicit top-level `model` line for
 * ~/.codex/default.config.toml. Gateway model ids are prefixed
 * ("openai/gpt-5.6-sol"); session files record the bare id, so prefix when
 * missing. The line MUST be PREPENDED to the config: `model` is a top-level
 * key, and anything appended after a `[table]` header (e.g.
 * `[model_providers.vercel]`) would become a key of that table instead.
 *
 * @param {string} observedModel
 * @returns {string}
 */
export function buildModelRepairToml(observedModel) {
  const fullModel = observedModel.includes('/') ? observedModel : `openai/${observedModel}`;
  return `# agent-eval repair: codex >= 0.144.0 drops the shell tool when config omits \`model\`\nmodel = "${fullModel}"\n`;
}

/**
 * Run the canary exec once and report. Uses the same profile/flags as the real
 * exec (buildCodexExecArgs) so it verifies the exact configuration the task will
 * run under. Bounded by its own timeout so a hang cannot eat the task budget.
 *
 * @param {import('../plugin/contract.js').AgentRunInput} input
 * @param {string} nonce
 * @returns {{confirmed: boolean, stdout: string, output: string}}
 */
function runShellCanary(input, nonce) {
  const res = spawnSync('codex', buildCodexExecArgs(buildShellCanaryInput(input, nonce)), {
    cwd: input.cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // A single echo round-trip; a hung canary must not eat the sandbox's task
    // budget (worst case is two canary calls before the real exec).
    timeout: 60_000,
  });
  const stdout = res.stdout || '';
  // stdout THEN stderr, matching the runner's real-exec output convention.
  const output = stdout + (res.stderr || '');
  return { confirmed: shellCanaryConfirmed(stdout, nonce), stdout, output };
}

/**
 * Canary + (if needed) config repair for native-default runs. `error` is null
 * when the shell tool is verified (possibly after repair); otherwise the run
 * must fail loudly. `canaryOutput` carries the combined canary CLI output so
 * failure results stay debuggable (what did the model actually reply?).
 *
 * @param {import('../plugin/contract.js').AgentRunInput} input
 * @returns {{error: string|null, repairedModel: string|null, canaryOutput: string}}
 */
function ensureShellToolForNativeDefault(input) {
  const markerPath = join(homedir(), '.codex', CANARY_MARKER_FILENAME);

  // Memoized outcome: judge assertions re-invoke this runner in the same
  // sandbox; only the first invocation pays the canary exec. The marker also
  // re-reports the original repair so every result carries the same evidence.
  let marker;
  try {
    marker = parseCanaryMarker(readFileSync(markerPath, 'utf8'));
  } catch {
    marker = null;
  }
  if (marker) return { error: null, repairedModel: marker.repairedModel, canaryOutput: '' };

  const nonce = `agent-eval-shell-canary-${randomBytes(8).toString('hex')}`;
  const first = runShellCanary(input, nonce);

  const writeMarker = (repairedModel) => {
    try {
      writeFileSync(markerPath, JSON.stringify({ verified: true, repairedModel }));
    } catch {
      // Best-effort memo: without it, later invocations just re-run the canary.
    }
  };

  if (first.confirmed) {
    writeMarker(null);
    return { error: null, repairedModel: null, canaryOutput: first.output };
  }

  // Toolless: recover the model the CLI natively resolved from the canary's own
  // session, then re-state it explicitly in the profile config.
  const threadId = extractCodexThreadId(first.stdout);
  const sessionTranscript = captureCodexSessionTranscript(threadId);
  const observedModel = extractObservedModelFromCodexSession(sessionTranscript);
  if (!observedModel) {
    return {
      error:
        'codex shell-tool canary failed (no command_execution reached the sandbox) and the native default model could not be observed from the session file, so the explicit-model repair is impossible. Failing loudly instead of running a toolless agent.',
      repairedModel: null,
      canaryOutput: first.output,
    };
  }

  try {
    // Prepend, never append: `model` must land in the top-level TOML section,
    // before any `[table]` header. See buildModelRepairToml.
    const configPath = join(homedir(), '.codex', 'default.config.toml');
    const existing = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, buildModelRepairToml(observedModel) + existing);
  } catch (e) {
    return {
      error: `codex shell-tool canary failed and the config repair could not be written: ${e && e.message ? e.message : String(e)}`,
      repairedModel: null,
      canaryOutput: first.output,
    };
  }

  const second = runShellCanary(input, nonce);
  if (!second.confirmed) {
    return {
      error: `codex shell-tool canary still failed after explicit-model repair (model = ${observedModel}). Failing loudly instead of running a toolless agent.`,
      repairedModel: null,
      canaryOutput: first.output + second.output,
    };
  }
  writeMarker(observedModel);
  return { error: null, repairedModel: observedModel, canaryOutput: first.output + second.output };
}

/**
 * Run Codex over the workspace at `input.cwd` and return a RunnerResult.
 *
 * Two-step, mirroring the old adapter's `codex login --with-api-key && codex exec`:
 *   1. `codex login --with-api-key` with the key piped on stdin. If login exits
 *      non-zero, short-circuit with ok:false WITHOUT running exec (the old `&&`).
 *   2. `codex exec ...` — capture transcript + observedModel even on non-zero exit.
 *
 * Auth env (AI_GATEWAY_API_KEY / OPENAI_API_KEY) arrives via process.env — the
 * orchestrator sets it on the `node run.mjs` invocation, and we pass process.env
 * straight through to the CLI. The login key is read from that same env.
 *
 * @param {import('../plugin/contract.js').AgentRunInput} input
 * @returns {Promise<import('../plugin/contract.js').RunnerResult>}
 */
export async function runAgent(input) {
  // The login key: gateway runs use AI_GATEWAY_API_KEY; direct OpenAI uses
  // OPENAI_API_KEY. Reading both (gateway first) keeps the runner agnostic to the
  // mode while never carrying the secret in the argv JSON.
  const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.OPENAI_API_KEY || '';

  // Step 1: codex login --with-api-key (key piped on stdin). The built-in openai
  // provider requires bearer auth; the gateway provider reads env_key but login is
  // harmless/consistent there too. This is the left side of the old `&&`.
  const login = spawnSync('codex', buildCodexLoginArgs(), {
    cwd: input.cwd,
    env: process.env,
    input: apiKey,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const loginStdout = login.stdout || '';
  const loginStderr = login.stderr || '';
  const loginExit = login.status == null ? -1 : login.status;

  if (login.error || loginExit !== 0) {
    // Short-circuit: the old `codex login ... && codex exec ...` never ran exec
    // when login failed. Surface the same kind of error (last 5 lines, else coded
    // fallback) over the login output.
    const loginOutput = loginStdout + loginStderr;
    const errorLines = loginOutput.trim().split('\n').slice(-5).join('\n');
    const fallback = login.error
      ? `Failed to run codex: ${login.error.message}`
      : `Codex CLI exited with code ${loginExit}`;
    return {
      ok: false,
      output: loginOutput,
      transcript: null,
      observedModel: null,
      error: errorLines || fallback,
      agentExitCode: loginExit,
    };
  }

  // Step 1.5: native-default runs (no explicit model in config) are pre-verified
  // with a shell canary and repaired when codex resolves its default model into a
  // toolless session (codex >= 0.144.0 with a custom provider). Explicit-model
  // runs already carry `model` in the profile config and are unaffected.
  let modelRepair = null;
  const cliModel = input.extra?.cliModel ?? null;
  if (!cliModel) {
    const ensured = ensureShellToolForNativeDefault(input);
    if (ensured.error) {
      // Preserve the canary CLI output/transcript on the fail-loud path, the
      // same way the login and real-exec failure paths preserve theirs — this
      // is the only evidence of what the toolless model actually replied.
      return {
        ok: false,
        output: ensured.canaryOutput,
        transcript: extractTranscriptFromOutput(ensured.canaryOutput) ?? null,
        observedModel: null,
        error: ensured.error,
        agentExitCode: -1,
      };
    }
    modelRepair = ensured.repairedModel;
  }

  // Step 2: codex exec. Blocking is fine — the runner has nothing else to do while
  // the agent works. The sandbox-level timeout bounds it.
  const res = spawnSync('codex', buildCodexExecArgs(input), {
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
  // this even on the non-zero-exit path). Prefer the inline --json stdout, but
  // fall back to the saved session file under ~/.codex; newer Codex builds may
  // write the session transcript there without echoing the full JSONL to stdout.
  const stdoutTranscript = extractTranscriptFromOutput(output);
  const threadId = extractCodexThreadId(output);
  const sessionTranscript = captureCodexSessionTranscript(threadId);
  const transcript = stdoutTranscript ?? sessionTranscript ?? null;
  const observedModel = extractObservedModelFromCodexSession(sessionTranscript ?? stdoutTranscript) ?? null;

  if (res.error || agentExitCode !== 0) {
    // Mirror the old error string: last 5 lines of output, else a coded fallback.
    const errorLines = output.trim().split('\n').slice(-5).join('\n');
    const fallback = res.error
      ? `Failed to run codex: ${res.error.message}`
      : `Codex CLI exited with code ${agentExitCode}`;
    return {
      ok: false,
      output,
      transcript,
      observedModel,
      error: errorLines || fallback,
      agentExitCode,
      ...(modelRepair ? { modelRepair } : {}),
    };
  }

  return {
    ok: true,
    output,
    transcript,
    observedModel,
    error: null,
    agentExitCode,
    ...(modelRepair ? { modelRepair } : {}),
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
  // Must carry every field readRunnerResult's fallback reconstructs, or that
  // field is silently lost whenever the result file can't be read back.
  process.stdout.write(
    '__AGENT_RESULT__ ' +
      JSON.stringify({
        ok: result.ok,
        observedModel: result.observedModel,
        error: result.error,
        agentExitCode: result.agentExitCode,
        // undefined when no repair ran → omitted by JSON.stringify.
        modelRepair: result.modelRepair,
      }) +
      '\n'
  );

  // Exit 0: "the runner ran". Agent success/failure is conveyed via result.ok, not
  // the node exit code (the host distinguishes the two).
  process.exit(0);
}
