/**
 * Agent plugin contract.
 *
 * An agent is described in two halves:
 *
 *   1. an {@link AgentDefinition} — HOST-side data + tiny pure functions that say
 *      *how to set up and authenticate* the agent (install commands, config files,
 *      auth env). It performs NO sandbox lifecycle and NO CLI invocation itself.
 *
 *   2. a `run.mjs` — a SANDBOX-side script (one per agent) that actually invokes
 *      the CLI and captures its transcript, returning a {@link RunnerResult}.
 *
 * The generic {@link runWithDefinition} orchestrator (orchestrator.ts) consumes a
 * definition, drives the shared sandbox lifecycle, ships the agent's `run.mjs` into
 * the sandbox, invokes it, and assembles the final `AgentRunResult`.
 *
 * This split exists so the invocation logic lives *in the sandbox* (where a future
 * in-sandbox judge can `import { runAgent }` and reuse it) rather than only on the
 * host. See the migration notes in the PR for the full rationale.
 */

import type { ModelTier, RunnableExperimentConfig } from '../../types.js';
import type { AgentRunOptions } from '../types.js';

/**
 * One install action the orchestrator runs in the sandbox before invocation.
 *
 * Each step carries its own failure policy so the per-agent install error
 * messages are preserved verbatim (e.g. claude throws `Claude Code install
 * failed: <stderr>`, the project `npm install` throws `npm install failed
 * (exit code N):\n<last 10 lines>` and is retried once).
 */
export interface InstallStep {
  /** 'command' → sandbox.runCommand(cmd, args); 'shell' → sandbox.runShell(script). */
  kind: 'command' | 'shell';
  /** For kind:'command'. */
  cmd?: string;
  args?: string[];
  /** For kind:'shell'. */
  script?: string;
  /** Retry once on a non-zero exit before failing (the project `npm install`). */
  retryOnce?: boolean;
  /** Prefix of the thrown Error on final failure, e.g. 'Claude Code install failed'. */
  errorPrefix: string;
  /**
   * How the failure body is rendered in the thrown Error, to match today's wording:
   *  - 'last10':  `${errorPrefix} (exit code N):\n<last 10 lines of stdout+stderr>`
   *  - 'stderr':  `${errorPrefix}: <stderr>`
   */
  errorBody: 'last10' | 'stderr';
}

/**
 * One config file an agent writes into the sandbox before invocation.
 * Either a writeFiles target (relative to cwd) or a shell snippet — the latter is
 * the escape hatch for absolute `~` paths that writeFiles cannot target (codex's
 * `~/.codex/default.config.toml`).
 */
export interface ConfigFile {
  /** writeFiles target path (relative to cwd). Mutually exclusive with viaShell. */
  path?: string;
  content?: string;
  /** Exact shell to run instead, e.g. `mkdir -p ~/.codex && cat > ~/.codex/... << 'EOF' ...`. */
  viaShell?: string;
}

/**
 * Host-side plugin description for one agent. Pure data + tiny pure functions —
 * no sandbox calls, no CLI invocation.
 */
export interface AgentDefinition {
  /** Registry name, unchanged: 'claude-code' | 'vercel-ai-gateway/claude-code' | ... */
  name: string;
  /** Human-readable name (logs/UI), unchanged from the old adapter. */
  displayName: string;
  /** Default model tier when none is provided (old getDefaultModel()). */
  defaultModel: ModelTier;
  /** Parser name handed to parseTranscript() on the host ('claude-code'|'codex'|...). */
  o11yAgentName: string;
  /** Absolute path to this agent's run.mjs (resolved from the definition's import.meta.url). */
  runnerPath: string;
  /** Whether the CLI can disable vendor-bundled skills, or has none to disable.
   * Omitted means the opt-in control is unsupported. */
  bundledSkillsControl?: 'configurable' | 'not-applicable';

  /**
   * Which host env var the apiKey is read from. Mirrors the old getApiKeyEnvVar()
   * EXACTLY, including claude-code's 3-way runtime branch (gateway →
   * CLAUDE_CODE_OAUTH_TOKEN → ANTHROPIC_API_KEY). Stays a function because it reads
   * process.env at call time.
   */
  getApiKeyEnvVar(): string;

  /** Ordered install steps (project deps + the agent CLI), run by the orchestrator. */
  install(options: AgentRunOptions): InstallStep[];

  /** Config files written before invocation (codex TOML, opencode.json). [] for most. */
  configFiles(options: AgentRunOptions): ConfigFile[];

  /**
   * The agent-specific auth/env handed to the run.mjs process (merged with the
   * neutral-workspace env by the orchestrator). This is the ONLY place provider
   * auth branching lives. Receives the resolved apiKey via options.apiKey.
   */
  authEnv(options: AgentRunOptions): Record<string, string>;

  /**
   * OPTIONAL host-computed values threaded into the runner as `input.extra`.
   *
   * Use this when run.mjs needs a value that MUST be derived on the host (e.g.
   * codex's parseModelString output — the resolved `--model`, reasoning effort,
   * and verbosity — which must match the TOML config written by configFiles()).
   * Keeping the derivation host-side avoids re-implementing host-only parsing in
   * the zero-dependency runner. Must contain NO secrets (it rides in the argv
   * JSON). Omit (or return undefined) for agents that don't need it.
   */
  runnerExtra?(options: AgentRunOptions): Record<string, unknown>;

  /**
   * OPTIONAL agent-owned protocol/version data that affects result reuse.
   * Returned keys are hashed into both the combined result fingerprint and
   * the non-carryable reuse compatibility fingerprint.
   */
  fingerprintExtra?(config: RunnableExperimentConfig): Record<string, unknown> | undefined;
}

/** Reject an opt-in capability when an agent cannot honor it. */
export function assertBundledSkillsControl(
  definition: AgentDefinition,
  requested?: boolean,
): void {
  if (requested && !definition.bundledSkillsControl) {
    throw new Error(`Agent ${definition.name} does not support disableBundledSkills`);
  }
}

/**
 * What the host passes INTO run.mjs (serialized as argv[2] JSON).
 *
 * SECURITY: the apiKey is intentionally NOT here — it travels only via process.env
 * (and, for codex, the CLI's stdin login). Never put secrets in argv (they show up
 * in process listings).
 */
export interface AgentRunInput {
  /** The prompt to run, verbatim (any host-side editPrompt was already applied upstream). */
  prompt: string;
  /** Model override, or undefined for the CLI's native default. */
  model?: string;
  /** 'agent-default' | 'native-default' (opencode toggles --print-logs on native). */
  modelPolicy?: string;
  /** Web-research toggle (claude --allowedTools, opencode permissions/env). */
  webResearch?: boolean;
  /** Opt-in vendor-bundled skill isolation. */
  disableBundledSkills?: boolean;
  /** Passthrough of agentOptions (e.g. claude effort). Secrets must NOT be in here. */
  agentOptions?: Record<string, unknown>;
  /** Absolute sandbox cwd AFTER neutral-workspace relocation (transcript paths use it). */
  cwd: string;
  /** Where run.mjs writes its RunnerResult JSON (host reads it back). */
  resultPath: string;
  /**
   * OPTIONAL host-computed values from {@link AgentDefinition.runnerExtra} — see
   * there for what belongs here and the no-secrets constraint.
   */
  extra?: Record<string, unknown>;
}

/**
 * Host↔sandbox result contract. run.mjs writes this JSON to `input.resultPath`
 * AND prints one `__AGENT_RESULT__ <json>` status line to stdout (a fallback the
 * host uses only if the result file can't be read).
 *
 * The `ok` (agent CLI succeeded) vs the node exit code (the runner itself crashed)
 * are deliberately separate signals — see the orchestrator's READ RESULT step.
 */
export interface RunnerResult {
  /** True iff the agent CLI exited 0. */
  ok: boolean;
  /** Combined stdout + stderr of the agent CLI (old `agentOutput`). */
  output: string;
  /** Raw transcript string the runner located (JSONL/JSON), or null. */
  transcript: string | null;
  /** Observed model extracted by the runner (claude/codex/opencode), or null. */
  observedModel: string | null;
  /** Error message when !ok (old "last 5 lines" / "<Agent> exited with code N"). */
  error: string | null;
  /** The agent CLI's exit code (diagnostics; -1 if it could not be spawned). */
  agentExitCode: number;
  /**
   * Codex only: the model the CLI natively resolved, re-stated explicitly in the
   * profile config by the shell-tool repair (codex >= 0.144.0 drops the exec tool
   * on custom providers when config omits `model`). Absent when no repair ran.
   * Evidence, not configuration — the model choice was still the CLI's own.
   * Propagated through AgentRunResult into EvalRunResult so persisted results
   * record which runs needed the repair (also the workaround's removal signal:
   * repairs dropping to zero means the upstream CLI is fixed).
   */
  modelRepair?: string;
}
