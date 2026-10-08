/**
 * Generic agent orchestrator.
 *
 * `runWithDefinition` is the single host-side run() that every agent shares. It
 * reproduces the exact flow the old per-agent adapters had (claude-code.ts is the
 * reference), but the agent-specific parts — install, config, auth env, and CLI
 * invocation/transcript-capture — come from the {@link AgentDefinition} and the
 * agent's in-sandbox `run.mjs`.
 *
 * Everything that is agent-AGNOSTIC stays here (and in shared.ts): sandbox
 * lifecycle, the git baseline, the neutral-workspace relocation, validation,
 * generated-file capture, transcript o11y parsing, and abort/timeout handling.
 * None of that can move into the sandbox — it IS the host↔sandbox control plane.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { AgentRunOptions, AgentRunResult } from '../types.js';
import type { RunProvenance } from '../../types.js';
import {
  createSandbox,
  collectLocalFiles,
  resolveBackend,
  splitTestFiles,
  verifyNoTestFiles,
  ENV_VAR_NAME_PATTERN,
  type SandboxManager,
} from '../../sandbox.js';
import { AGENT_EVAL_VERSION } from '../../version.js';
import type { DockerSandboxManager } from '../../docker-sandbox.js';
import {
  runValidation,
  captureGeneratedFiles,
  createVitestConfig,
  initGitAndCommit,
  injectTranscriptContext,
  prepareNeutralWorkspace,
  resolveAgentApiKey,
  NEUTRAL_WORKSPACE_ENV,
  EVAL_HELPER_PATH,
  JUDGE_TRANSCRIPT_FILE,
  JUDGE_CONFIG_PATH,
  JUDGE_RUNNER_PATH,
  type ValidationResults,
} from '../shared.js';
import {
  agentInstallSteps,
  applyAgentChanges,
  captureAgentChanges,
  createProtectedPathMatcher,
  findTampering,
  fixtureUsesJudge,
  pathsChangedSince,
  projectInstallSteps,
  snapshotWorkspace,
  VERIFIER_PROTECTED_PATHS,
} from '../verifier.js';
import type { SandboxFile } from '../../sandbox.js';
import { redactRunResult } from '../redact.js';
import { getAgent } from '../registry.js';
import {
  assertBundledSkillsControl,
  assertCrossAgentJudgeSupport,
  assertWebResearchControl,
  type AgentDefinition,
  type AgentRunInput,
  type InstallStep,
  type RunnerResult,
} from './contract.js';

/** Union of the two sandbox backends (same alias the old adapters used). */
type AnySandbox = SandboxManager | DockerSandboxManager;

/** Result of a host-side sandbox command (stdout/stderr/exitCode). */
type CommandResult = { stdout: string; stderr: string; exitCode: number };

/** Well-known paths inside the sandbox for the runner + its result file. */
const RUNNER_PATH = '__agent_eval__/run.mjs';
const RESULT_PATH = '__agent_eval__/agent-result.json';

/**
 * Host-disk path to the in-sandbox eval helper, resolved next to the compiled
 * output (dist/lib/agents/eval-helper.mjs) and in src during dev. Shipped into the
 * sandbox at {@link EVAL_HELPER_PATH} before validation so EVAL.ts judge matchers
 * can re-invoke the agent in this sandbox.
 */
const EVAL_HELPER_DISK_PATH = fileURLToPath(new URL('../eval-helper.mjs', import.meta.url));

/** The judge-config.json payload eval-helper.mjs reads to invoke the judge. */
interface JudgeRuntimeConfig {
  /** Sandbox-relative runner the judge spawns (codegen run.mjs, or judge-run.mjs). */
  runnerPath: string;
  /** Model the judge grades with (null → let the agent CLI default). */
  model: string | null;
  /** Preserve the caller's opt-in bundled-skill isolation for judge runs. */
  disableBundledSkills?: boolean;
  /** Host-computed runner extra (e.g. codex's resolved model/effort). */
  extra: Record<string, unknown> | null;
}

interface JudgeRuntime {
  /** The judge agent's definition (the codegen `def` itself when self-grading). */
  judgeDef: AgentDefinition;
  /** Options the judge runs under (model pinned; apiKey re-resolved if cross-agent). */
  judgeOptions: AgentRunOptions;
  /** True when the judge reuses the codegen agent (no extra install/runner needed). */
  isSelf: boolean;
  /** Auth env set on the vitest process so the in-sandbox judge inherits credentials. */
  authEnv: Record<string, string>;
  /** Judge runner source to ship at JUDGE_RUNNER_PATH; null when self-grading. */
  runnerSource: string | null;
  /** The judge-config.json payload eval-helper.mjs reads. */
  config: JudgeRuntimeConfig;
}

/**
 * Resolve the agentic-judge runtime for this run.
 *
 * Default (no `options.judge`): the judge IS the codegen agent+model — self-grading,
 * the historical behavior. No second runner or install is needed; it reuses run.mjs.
 *
 * Pinned (`options.judge` set): the judge grades with a fixed agent+model regardless
 * of the model under test — the apples-to-apples choice for cross-model dashboards.
 * When the pinned agent differs from the codegen agent we resolve ITS definition,
 * key (own env var → VERCEL_OIDC_TOKEN), auth env, and runner from the registry; the
 * caller also installs that agent's CLI (it isn't installed by the codegen setup).
 */
export function resolveJudgeRuntime(def: AgentDefinition, options: AgentRunOptions): JudgeRuntime {
  const spec = options.judge;
  assertBundledSkillsControl(def, options.disableBundledSkills);
  assertWebResearchControl(def, options.webResearch);

  // Same harness as codegen (default, or judge.agent omitted/equal): reuse run.mjs,
  // just pin the model when asked. Identical to pre-feature behavior when unset.
  if (!spec || (spec.agent ?? def.name) === def.name) {
    const judgeOptions = spec ? { ...options, model: spec.model } : options;
    return {
      judgeDef: def,
      judgeOptions,
      isSelf: true,
      authEnv: def.authEnv(judgeOptions),
      runnerSource: null,
      config: {
        runnerPath: RUNNER_PATH,
        model: spec?.model ?? options.model ?? null,
        disableBundledSkills: judgeOptions.disableBundledSkills,
        extra: def.runnerExtra?.(judgeOptions) ?? null,
      },
    };
  }

  // Pinned to a DIFFERENT agent — resolve its definition + key + runner.
  const judgeDef = getAgent(spec.agent!).definition;
  assertBundledSkillsControl(judgeDef, options.disableBundledSkills);
  assertCrossAgentJudgeSupport(judgeDef);
  const judgeApiKey = resolveAgentApiKey(judgeDef.getApiKeyEnvVar) ?? '';
  const judgeOptions: AgentRunOptions = { ...options, model: spec.model, apiKey: judgeApiKey };
  return {
    judgeDef,
    judgeOptions,
    isSelf: false,
    authEnv: judgeDef.authEnv(judgeOptions),
    runnerSource: readFileSync(judgeDef.runnerPath, 'utf8'),
    config: {
      runnerPath: JUDGE_RUNNER_PATH,
      model: spec.model,
      disableBundledSkills: judgeOptions.disableBundledSkills,
      extra: judgeDef.runnerExtra?.(judgeOptions) ?? null,
    },
  };
}

/**
 * Every credential a run injects: the codegen agent's key, every `agentEnv`
 * value, and, when the judge is pinned to a different agent, the judge's own
 * key (it can reach the transcript too). Redaction scrubs these from everything
 * a run hands back.
 *
 * Resolving the judge can throw (an unregistered agent, a missing runner file).
 * That is the run's failure to report, not redaction's, so the judge key is then
 * left out rather than turning redaction into a throw.
 */
export function runCredentials(def: AgentDefinition, options: AgentRunOptions): string[] {
  const credentials = [options.apiKey, ...Object.values(options.agentEnv ?? {})];
  try {
    const judgeApiKey = resolveJudgeRuntime(def, options).judgeOptions.apiKey;
    if (judgeApiKey && judgeApiKey !== options.apiKey) credentials.push(judgeApiKey);
  } catch {
    // See above: fall back to the credentials we know.
  }
  return credentials;
}

/**
 * Reject an `agentEnv` that would change what the agent is authenticated as or
 * which workspace identity it sees. The variables the orchestrator sets itself
 * (the agent's auth env and the neutral workspace identity) must win, and a
 * silent override would make the run measure something other than what was
 * configured, so any collision is an error rather than a precedence rule.
 */
export function assertAgentEnv(def: AgentDefinition, options: AgentRunOptions): void {
  const agentEnv = options.agentEnv;
  if (!agentEnv) return;

  const invalid = Object.keys(agentEnv).filter((key) => !ENV_VAR_NAME_PATTERN.test(key));
  if (invalid.length > 0) {
    throw new Error(`agentEnv has invalid environment variable names: ${invalid.join(', ')}`);
  }

  const reserved = new Set([...Object.keys(def.authEnv(options)), ...Object.keys(NEUTRAL_WORKSPACE_ENV)]);
  const collisions = Object.keys(agentEnv).filter((key) => reserved.has(key)).sort();
  if (collisions.length > 0) {
    throw new Error(
      `agentEnv cannot set ${collisions.join(', ')}: reserved for ${def.displayName} authentication ` +
        `or the sandbox workspace identity`
    );
  }
}

/**
 * Run install steps, reproducing the old per-step error wording.
 * Throws on final failure so the caller's catch turns it into an error result.
 */
async function runInstallSteps(sandbox: AnySandbox, steps: InstallStep[]): Promise<void> {
  for (const step of steps) {
    const exec = (): Promise<CommandResult> =>
      step.kind === 'shell'
        ? sandbox.runShell(step.script ?? '')
        : sandbox.runCommand(step.cmd ?? '', step.args ?? []);

    let result = await exec();
    // Optional single retry (the project `npm install` flakes occasionally).
    if (result.exitCode !== 0 && step.retryOnce) {
      result = await exec();
    }
    if (result.exitCode !== 0) {
      // Match the old messages verbatim:
      //   last10  → `${prefix} (exit code N):\n<last 10 lines of stdout+stderr>`
      //   stderr  → `${prefix}: <stderr>`
      if (step.errorBody === 'last10') {
        const body = (result.stdout + result.stderr).trim().split('\n').slice(-10).join('\n');
        throw new Error(`${step.errorPrefix} (exit code ${result.exitCode}):\n${body}`);
      }
      throw new Error(`${step.errorPrefix}: ${result.stderr}`);
    }
  }
}

/** How long a version command may run before it is abandoned. */
const DEFAULT_VERSION_COMMAND_TIMEOUT_MS = 30_000;

/**
 * `sh -c` script that runs its arguments after the first under coreutils
 * `timeout` (first argument: seconds, then a KILL 5 seconds later) when the
 * sandbox has it, and as-is otherwise.
 */
const BOUNDED_COMMAND =
  'secs=$1; shift; if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 "$secs" "$@"; fi; exec "$@"';

/**
 * Run the definition's version command and return its trimmed stdout. Any
 * failure (no command, non-zero exit, empty output, an error from the sandbox,
 * or running past its timeout) returns undefined: provenance is a record of the
 * run, never a reason to fail or stall it.
 */
async function readAgentCliVersion(
  sandbox: AnySandbox,
  def: AgentDefinition,
  options: AgentRunOptions
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const command = def.versionCommand?.(options);
    if (!command) return undefined;
    const timeoutMs =
      command.timeoutMs !== undefined && Number.isFinite(command.timeoutMs) && command.timeoutMs > 0
        ? command.timeoutMs
        : DEFAULT_VERSION_COMMAND_TIMEOUT_MS;
    const argv = command.kind === 'shell' ? ['bash', '-c', command.script] : [command.cmd, ...(command.args ?? [])];

    // Two bounds, because a hung version command would otherwise hold the run
    // until the attempt's own timeout fails it: coreutils `timeout` kills the
    // process in the sandbox when it's installed, and a host-side timer stops
    // waiting either way. The abandoned command's eventual result (or rejection,
    // once the sandbox stops) is swallowed.
    const run = sandbox
      .runCommand('sh', ['-c', BOUNDED_COMMAND, 'sh', String(timeoutMs / 1000), ...argv])
      .catch(() => undefined);
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    });
    const result = await Promise.race([run, timedOut]);
    const version = result?.stdout.trim();
    return result?.exitCode === 0 && version ? version : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Write the agent's config files into the sandbox (codex TOML, opencode.json, …). */
async function writeConfigFiles(sandbox: AnySandbox, def: AgentDefinition, options: AgentRunOptions): Promise<void> {
  for (const cf of def.configFiles(options)) {
    if (cf.viaShell) {
      // Absolute `~` paths writeFiles can't target (codex heredoc).
      await sandbox.runShell(cf.viaShell);
    } else if (cf.path) {
      await sandbox.writeFiles({ [cf.path]: cf.content ?? '' });
    }
  }
}

/**
 * Upload what validation needs (tests, vitest config, transcript context, judge
 * runtime) and run it. Shared by both verifiers so the grading environment is
 * built the same way in the agent's sandbox and in a separate one.
 */
async function validate(
  sandbox: AnySandbox,
  testFiles: SandboxFile[],
  transcript: string | undefined,
  def: AgentDefinition,
  options: AgentRunOptions,
  judgeRuntime: JudgeRuntime,
  workspaceEnv: Record<string, string>,
  usage: AgentRunResult['usage']
): Promise<ValidationResults> {
  // The JUDGE's auth env is set on the eval process so EVAL.ts judge matchers can
  // re-invoke the agent in-sandbox (the vitest process inherits it to children).
  // By default the judge is the codegen agent+model; options.judge pins a fixed one.
  const validationEnv = { ...judgeRuntime.authEnv, ...workspaceEnv };
  if (options.validation !== 'none') {
    await sandbox.uploadFiles(testFiles);
    await createVitestConfig(sandbox);
    await injectTranscriptContext(sandbox, transcript, def.o11yAgentName, options.model, usage);
    // Judge runtime: ship the eval helper, materialize the raw transcript as a
    // file the judge agent can read by path, record the judge config, and — only
    // when the judge is a DIFFERENT agent — ship its runner alongside run.mjs.
    const judgeFiles: Record<string, string> = {
      [EVAL_HELPER_PATH]: readFileSync(EVAL_HELPER_DISK_PATH, 'utf8'),
      [JUDGE_TRANSCRIPT_FILE]: transcript ?? '',
      [JUDGE_CONFIG_PATH]: JSON.stringify(judgeRuntime.config),
    };
    if (judgeRuntime.runnerSource) {
      judgeFiles[JUDGE_RUNNER_PATH] = judgeRuntime.runnerSource;
    }
    await sandbox.writeFiles(judgeFiles);
  }
  return runValidation(sandbox, options.scripts ?? [], options.validation, validationEnv);
}

/**
 * Read the RunnerResult the in-sandbox run.mjs produced.
 *
 * Source of truth = the result file. If that can't be read, fall back to the
 * `__AGENT_RESULT__` status line on stdout. If NEITHER is parseable, the runner
 * itself crashed (couldn't spawn node, fs error, …) — throw with the tail so the
 * caller's catch produces a structured error result (mirrors the old CLI-crash path).
 */
async function readRunnerResult(
  sandbox: AnySandbox,
  resultPath: string,
  nodeResult: CommandResult
): Promise<RunnerResult> {
  // 1. Preferred: the result file.
  try {
    const raw = await sandbox.readFile(resultPath);
    if (raw && raw.trim()) return JSON.parse(raw) as RunnerResult;
  } catch {
    // fall through to the marker line
  }

  const combined = `${nodeResult.stdout || ''}\n${nodeResult.stderr || ''}`;

  // 2. Fallback: the compact status line (no transcript — it can be huge).
  const markerLine = combined.split('\n').find((l) => l.startsWith('__AGENT_RESULT__'));
  if (markerLine) {
    try {
      const status = JSON.parse(markerLine.slice('__AGENT_RESULT__'.length).trim());
      return {
        ok: !!status.ok,
        output: combined,
        transcript: null,
        observedModel: status.observedModel ?? null,
        error: status.error ?? null,
        agentExitCode: status.agentExitCode ?? -1,
        ...(status.modelRepair ? { modelRepair: status.modelRepair } : {}),
      };
    } catch {
      // fall through to the throw
    }
  }

  // 3. Runner crashed — surface the last lines (old "CLI crash" behavior).
  const tail = combined.trim().split('\n').slice(-5).join('\n');
  throw new Error(tail || `agent runner exited with code ${nodeResult.exitCode}`);
}

/**
 * The shared host-side run(). Each agent's createXxxAgent() wires this up with its
 * definition; the public Agent interface is unchanged, so runner.ts is untouched.
 *
 * Thin wrapper over {@link runOnce} that strips the run's credentials from the
 * result. It wraps rather than patching each `return` because runOnce has eight of
 * them and a ninth added later must not be able to leak by omission. See redact.ts
 * for why this happens on the way out instead of before the judge reads the
 * transcript.
 */
export async function runWithDefinition(
  def: AgentDefinition,
  fixturePath: string,
  options: AgentRunOptions
): Promise<AgentRunResult> {
  assertBundledSkillsControl(def, options.disableBundledSkills);
  assertWebResearchControl(def, options.webResearch);
  assertAgentEnv(def, options);

  // Provenance is attached here rather than at each of runOnce's returns, for the
  // same reason redaction is: a later return can't drop it by omission. runOnce
  // fills in what it observes (the sandbox's image and user, the CLI version).
  const provenance: RunProvenance = {
    agentEvalVersion: AGENT_EVAL_VERSION,
    sandboxBackend: resolveBackend({ backend: options.sandbox }),
  };
  const result = { ...(await runOnce(def, fixturePath, options, provenance)), provenance };
  return redactRunResult(result, runCredentials(def, options));
}

async function runOnce(
  def: AgentDefinition,
  fixturePath: string,
  options: AgentRunOptions,
  provenance: RunProvenance
): Promise<AgentRunResult> {
  const startTime = Date.now();
  let sandbox: AnySandbox | null = null;
  let agentOutput = '';
  let transcript: string | undefined;
  let observedModel: string | undefined;
  let modelRepair: string | undefined;
  let usage: AgentRunResult['usage'];
  let aborted = false;
  let sandboxStopped = false;
  // The separate verifier's sandbox, when options.verifier is 'separate'.
  let verifier: AnySandbox | null = null;
  let verifierStopped = false;

  // --- abort wiring (identical to the old adapter) ---------------------------
  const abortHandler = () => {
    aborted = true;
    if (sandbox && !sandboxStopped) {
      sandboxStopped = true;
      sandbox.stop().catch(() => {});
    }
    if (verifier && !verifierStopped) {
      verifierStopped = true;
      verifier.stop().catch(() => {});
    }
  };

  if (options.signal) {
    if (options.signal.aborted) {
      return { success: false, output: '', error: 'Aborted before start', duration: 0 };
    }
    options.signal.addEventListener('abort', abortHandler);
  }

  try {
    // 1. Collect fixture files; hold test files back until validation.
    const allFiles = await collectLocalFiles(fixturePath);
    const { workspaceFiles, testFiles } = splitTestFiles(allFiles);

    if (aborted) {
      return { success: false, output: '', error: 'Aborted', duration: Date.now() - startTime };
    }

    // 2. Create the sandbox. One sandbox serves the codegen run AND every judge
    //    re-invocation of the runner (eval-helper.mjs); codex's shell-canary
    //    memoization (~/.codex/agent-eval-canary.json, see codex/run.mjs) relies
    //    on that shared lifetime — a sandbox-per-invocation change would make
    //    every judge assertion re-pay the canary exec. (With verifier: 'separate'
    //    the judge runs in the verifier instead, which pays the canary once.)
    const sandboxOptions = {
      timeout: options.timeout,
      // `image` and `runtime` are mutually exclusive; keep the legacy runtime
      // default unless the caller opted into an image.
      ...(options.sandboxImage ? { image: options.sandboxImage } : { runtime: 'node24' as const }),
      user: options.sandboxUser,
      backend: options.sandbox,
    };
    sandbox = await createSandbox(sandboxOptions);
    provenance.sandboxBackend = sandbox.backend;
    if (sandbox.image) provenance.sandboxImage = sandbox.image;
    if (sandbox.username) provenance.sandboxUser = sandbox.username;

    if (aborted) {
      return {
        success: false,
        output: '',
        error: 'Aborted',
        duration: Date.now() - startTime,
        sandboxId: sandbox.sandboxId,
      };
    }

    // 3. Upload workspace, establish the git baseline, run user setup, relocate to
    //    the neutral workspace. (All agent-agnostic; unchanged shared helpers.)
    await sandbox.uploadFiles(workspaceFiles);
    await initGitAndCommit(sandbox);
    if (options.setup) {
      await options.setup(sandbox);
    }
    const neutralWorkspace = await prepareNeutralWorkspace(sandbox);

    // 4. SETUP from the definition: install (project deps + CLI) then config files.
    await runInstallSteps(sandbox, def.install(options));
    await writeConfigFiles(sandbox, def, options);
    const agentCliVersion = await readAgentCliVersion(sandbox, def, options);
    if (agentCliVersion) provenance.agentCliVersion = agentCliVersion;

    // 4b. If the agentic judge is pinned to a DIFFERENT agent, install its CLI +
    //     config too — the codegen setup above only installed the codegen agent.
    //     (npm install of project deps re-runs idempotently; the CLI is the point.)
    const judgeRuntime = resolveJudgeRuntime(def, options);
    if (!judgeRuntime.isSelf) {
      await runInstallSteps(sandbox, judgeRuntime.judgeDef.install(judgeRuntime.judgeOptions));
      await writeConfigFiles(sandbox, judgeRuntime.judgeDef, judgeRuntime.judgeOptions);
    }

    // 5. Guard: no stray test files leaked into the workspace before the agent runs.
    await verifyNoTestFiles(sandbox);

    // 6. Ship the agent's in-sandbox runner. We read run.mjs from disk on the host
    //    (next to the compiled definition) and write it into the sandbox.
    const runnerSource = readFileSync(def.runnerPath, 'utf8');
    await sandbox.writeFiles({ [RUNNER_PATH]: runnerSource });

    // 6b. Tampering detection (separate verifier or protectedPaths only): snapshot
    //     the workspace so only changes made by the agent itself are reported.
    const separate = options.verifier === 'separate';
    const tracksTampering = separate || (options.protectedPaths?.length ?? 0) > 0;
    const preAgentTree = tracksTampering ? await snapshotWorkspace(sandbox) : undefined;

    // 7. INVOKE the runner. Auth + neutral env are set on the node process (merged,
    //    neutral overrides — same precedence as the old adapter). The apiKey rides
    //    in env only, never in the argv JSON. The caller's agentEnv joins them here
    //    and nowhere else: validation and judge runs never receive it. Collisions
    //    were rejected up front, so listing it first changes no precedence.
    const input: AgentRunInput = {
      prompt: options.prompt,
      model: options.model,
      modelPolicy: options.modelPolicy,
      webResearch: options.webResearch,
      disableBundledSkills: options.disableBundledSkills,
      agentOptions: options.agentOptions,
      cwd: sandbox.getWorkingDirectory(), // post-relocation cwd; transcript paths use it
      resultPath: RESULT_PATH,
      // Optional host-computed values (e.g. codex's resolved model/effort/verbosity
      // that must match the TOML config). Omitted entirely for agents without it.
      extra: def.runnerExtra?.(options),
    };
    const runEnv = { ...options.agentEnv, ...def.authEnv(options), ...neutralWorkspace.env };
    const nodeResult = await sandbox.runCommand('node', [RUNNER_PATH, JSON.stringify(input)], { env: runEnv });

    // 8. Read the runner's result (file → marker → throw-on-crash).
    const runnerResult = await readRunnerResult(sandbox, RESULT_PATH, nodeResult);
    agentOutput = runnerResult.output;
    transcript = runnerResult.transcript ?? undefined;
    observedModel = runnerResult.observedModel ?? undefined;
    modelRepair = runnerResult.modelRepair ?? undefined;
    usage = runnerResult.usage ?? undefined;

    if (aborted) {
      return {
        success: false,
        output: agentOutput,
        transcript,
        error: 'Aborted',
        duration: Date.now() - startTime,
        sandboxId: sandbox.sandboxId,
      };
    }

    // 9. Agent CLI failed (non-zero exit). Return a failed result, NOT a throw —
    //    mirrors the old non-zero-exit path exactly.
    if (!runnerResult.ok) {
      return {
        success: false,
        output: agentOutput,
        transcript,
        error: runnerResult.error ?? `${def.displayName} exited with code ${runnerResult.agentExitCode}`,
        duration: Date.now() - startTime,
        sandboxId: sandbox.sandboxId,
        observedModel,
        modelRepair,
        ...(usage ? { usage } : {}),
      };
    }

    // 10. VALIDATION. Protected paths the agent changed are worked out first,
    //     before anything else is written to the workspace.
    const isProtected = createProtectedPathMatcher([
      ...(separate ? VERIFIER_PROTECTED_PATHS : []),
      ...(options.protectedPaths ?? []),
    ]);
    const tampering = preAgentTree
      ? findTampering(await pathsChangedSince(sandbox, preAgentTree), isProtected)
      : undefined;

    if (!separate) {
      // Shared verifier (the default): grade in the agent's own sandbox. With
      // protectedPaths set, tampering is only reported; grading is unchanged.
      const validationResults = await validate(
        sandbox, testFiles, transcript, def, options, judgeRuntime, neutralWorkspace.env, usage
      );

      // 11. Capture generated/deleted files (git diff).
      const { generatedFiles, deletedFiles } = await captureGeneratedFiles(sandbox);

      return {
        success: validationResults.allPassed,
        output: agentOutput,
        transcript,
        duration: Date.now() - startTime,
        testResult: validationResults.test,
        scriptsResults: validationResults.scripts,
        sandboxId: sandbox.sandboxId,
        generatedFiles,
        deletedFiles,
        observedModel,
        modelRepair,
        ...(usage ? { usage } : {}),
        ...(tampering ? { tampering } : {}),
      };
    }

    // 10s. SEPARATE VERIFIER. Grade in a fresh sandbox that receives only the
    //      agent's file changes, so nothing else the agent did can reach the grader.
    //   a. Capture the changes while the agent's sandbox still exists. The
    //      capture is untrusted (it runs git where the agent could replace it),
    //      so anything it reports beyond the snapshot comparison is checked too.
    const changes = await captureAgentChanges(sandbox);
    const verifierTampering = findTampering(
      [
        ...(tampering ?? []),
        ...Object.keys(changes.generatedFiles),
        ...changes.deletedFiles,
        ...changes.rejectedPaths,
      ],
      isProtected
    );

    //   b. Stop the agent's sandbox: its processes and installs end with it. A
    //      failed stop can't affect a different sandbox, so it doesn't fail the run.
    sandboxStopped = true;
    await sandbox.stop().catch(() => {});

    //   c. Same backend, image or runtime, and user as the agent's sandbox.
    verifier = await createSandbox(sandboxOptions);
    if (aborted) {
      return {
        success: false,
        output: agentOutput,
        transcript,
        error: 'Aborted',
        duration: Date.now() - startTime,
        sandboxId: sandbox.sandboxId,
      };
    }

    //   d. Rebuild the workspace the way the agent's started: the original files,
    //      the git baseline, the user's setup, and the neutral workspace. Setup
    //      runs before the replay because its file writes landed after the
    //      baseline, so they are already part of the agent's diff.
    await verifier.uploadFiles(workspaceFiles);
    await initGitAndCommit(verifier);
    if (options.setup) {
      await options.setup(verifier);
    }
    const verifierWorkspace = await prepareNeutralWorkspace(verifier);

    //   e. Replay the agent's changes, minus protected paths.
    await applyAgentChanges(verifier, changes, isProtected);

    //   f. Fresh project dependencies, and the judge's CLI only when the eval
    //      can call the judge (a self-grading judge also re-runs run.mjs).
    await runInstallSteps(verifier, projectInstallSteps(def.install(options)));
    if (options.validation !== 'none' && fixtureUsesJudge(allFiles)) {
      const { judgeDef, judgeOptions } = judgeRuntime;
      await runInstallSteps(verifier, agentInstallSteps(judgeDef.install(judgeOptions)));
      await writeConfigFiles(verifier, judgeDef, judgeOptions);
      if (judgeRuntime.isSelf) {
        await verifier.writeFiles({ [RUNNER_PATH]: runnerSource });
      }
    }

    //   g. Grade.
    const validationResults = await validate(
      verifier, testFiles, transcript, def, options, judgeRuntime, verifierWorkspace.env, usage
    );

    return {
      success: validationResults.allPassed,
      output: agentOutput,
      transcript,
      duration: Date.now() - startTime,
      testResult: validationResults.test,
      scriptsResults: validationResults.scripts,
      sandboxId: sandbox.sandboxId,
      generatedFiles: changes.generatedFiles,
      deletedFiles: changes.deletedFiles,
      observedModel,
      modelRepair,
      ...(usage ? { usage } : {}),
      verifier: 'separate',
      verifierSandboxId: verifier.sandboxId,
      tampering: verifierTampering,
    };
  } catch (error) {
    // Abort wins over a generic error (same as the old adapter).
    if (aborted) {
      return {
        success: false,
        output: agentOutput,
        transcript,
        error: 'Aborted',
        duration: Date.now() - startTime,
        sandboxId: sandbox?.sandboxId,
      };
    }
    return {
      success: false,
      output: agentOutput,
      transcript,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime,
      sandboxId: sandbox?.sandboxId,
      observedModel,
      modelRepair,
      ...(usage ? { usage } : {}),
      ...(verifier ? { verifier: 'separate' as const, verifierSandboxId: verifier.sandboxId } : {}),
    };
  } finally {
    if (options.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
    if (sandbox && !sandboxStopped) {
      sandboxStopped = true;
      await sandbox.stop();
    }
    if (verifier && !verifierStopped) {
      verifierStopped = true;
      await verifier.stop();
    }
  }
}
