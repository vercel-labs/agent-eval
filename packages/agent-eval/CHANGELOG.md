# @vercel/agent-eval

## 2.2.1

### Patch Changes

- [#196](https://github.com/vercel-labs/agent-eval/pull/196) [`3cc55a7`](https://github.com/vercel-labs/agent-eval/commit/3cc55a77648ef3cd1b9c9b79c14bdeeca6217508) Thanks [@gaojude](https://github.com/gaojude)! - Judge matchers no longer block the vitest worker. `toSatisfyCriterion` and `toScoreAtLeast` ran the in-sandbox judge agent with `spawnSync`, freezing the worker's event loop for the length of a model run. The worker answers the main process over an RPC channel whose per-call timeout is hardcoded to 60 seconds (birpc's default — no vitest option or env var reaches it), so any judge slower than that made vitest emit an unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` and exit non-zero even when every assertion passed: a green eval recorded as a failure, and the slower the judge model, the more often. The judge now runs via async `spawn` and the matchers are async, so the event loop keeps servicing the RPC channel while the judge works. Judge calls must be awaited — `await expect(environment).toSatisfyCriterion(...)` — which is what every published example already shows.

- [#195](https://github.com/vercel-labs/agent-eval/pull/195) [`2bcb34a`](https://github.com/vercel-labs/agent-eval/commit/2bcb34a79adaa3f48ce40ba541479e39faae41d8) Thanks [@gaojude](https://github.com/gaojude)! - Install vitest before validating when the agent removed it. Validation shells out to `npx vitest` and the generated `vitest.config.ts` imports `vitest/config`, resolved from the workspace — but package.json belongs to the agent for the length of a run. An agent scaffolding into an empty directory often replaces that file outright instead of editing it, its next `npm install` prunes vitest, and npx then downloads vitest into a cache that does not satisfy the config's import. The run dies at startup with `Cannot find package 'vitest'`, which is indistinguishable from a bad result: the eval never executes, yet the harness records a failure for work it never graded. `runValidation` now checks for `node_modules/vitest` first and installs it when missing, with `--no-save` and `--no-package-lock` so neither the manifest nor the lockfile enters the captured diff as if the agent had written it.

## 2.2.0

### Minor Changes

- [#193](https://github.com/vercel-labs/agent-eval/pull/193) [`5d7aef2`](https://github.com/vercel-labs/agent-eval/commit/5d7aef26a7215b7c3862a9235c97cb3a3033c488) Thanks [@molebox](https://github.com/molebox)! - Add a Vercel AI Gateway adapter for research evals with fx, including a pinned binary installer and saved-session transcript parser.

## 2.1.0

### Minor Changes

- [#191](https://github.com/vercel-labs/agent-eval/pull/191) [`ceba203`](https://github.com/vercel-labs/agent-eval/commit/ceba203690479decaf63cde4297fc61761154221) Thanks [@molebox](https://github.com/molebox)! - Add opt-in isolation for agent-bundled skills and update Codex web research to use its current live-search configuration and CLI flag. Opt-in runtime compatibility is stored separately so cached legacy research results are not silently carried forward.

## 2.0.0

### Major Changes

- [#177](https://github.com/vercel-labs/agent-eval/pull/177) [`3be0670`](https://github.com/vercel-labs/agent-eval/commit/3be067057d374917f352736377b6c9a3019e51fd) Thanks [@Sidnioulz](https://github.com/Sidnioulz)! - Fix silent binary-file corruption when collecting results

  Collected project trees were not faithful copies. Two paths decoded every file
  as UTF-8, replacing each invalid byte with U+FFFD — silently destroying icons,
  images and fonts and inflating them ~1.8x:

  - `captureGeneratedFiles` read the agent's diff with `sandbox.readFile`, which
    hands back command stdout (a string).
  - `readFixtureFiles` read fixtures with `'utf-8'`, corrupting every binary asset
    a fixture ships when `copyFiles: 'all'` is used.

  Both now preserve bytes. `Sandbox` gains `readFileBuffer(path)`, which routes
  through `base64` so the existing transport round-trips losslessly, and the
  `copyFiles: 'all'` fixture copy uses `copyFileSync` instead of read-then-write —
  the bytes never enter the heap, so a whole fixture tree is no longer buffered in
  memory.

  **Breaking:** `generatedFiles` is now `Record<string, Buffer>` instead of
  `Record<string, string>` on both `AgentRunResult` and `EvalRunData`. Code reading
  it in an `onRunComplete` hook mostly keeps working at runtime (a `Buffer`
  stringifies in template literals, `String(...)` and `JSON.parse(...)`), but
  TypeScript consumers that annotate it as `string` need `.toString('utf-8')`.
  `readFixtureFiles` likewise returns `Map<string, Buffer>`.

  Credential redaction keeps working over the new byte-typed field.
  `redactRunResult` routes `generatedFiles` through a new `redactSecretsBuffer`,
  which locates the credential's UTF-8 byte sequence and splices it out rather than
  decoding the file. Decoding would have reintroduced the corruption this change
  removes, and passing a `Buffer` to the string-based `redactSecrets` throws
  outright, since `Buffer` has no `split`.

### Minor Changes

- [#166](https://github.com/vercel-labs/agent-eval/pull/166) [`974cda2`](https://github.com/vercel-labs/agent-eval/commit/974cda2689d0f3caa435262cbe22d223b92da1fd) Thanks [@huang-julien](https://github.com/huang-julien)! - Ship public types for the `@vercel/agent-eval/eval` judge surface. Importing `environment`/`transcript` now also augments Vitest's `expect` with the `toSatisfyCriterion` and `toScoreAtLeast` matchers — EVAL.ts files type-check with no manual `declare module 'vitest'` boilerplate. The `eval` subpath is now a real package export (resolvable in editors, not just the in-sandbox alias), and `JudgeSubject` / `JudgeVerdict` types are exported for advanced use.

### Patch Changes

- [#169](https://github.com/vercel-labs/agent-eval/pull/169) [`f867b13`](https://github.com/vercel-labs/agent-eval/commit/f867b13401ce017b406f3aca203a0107f3a0fc32) Thanks [@huang-julien](https://github.com/huang-julien)! - Fall back to the saved Codex session transcript when `codex exec --json` does not
  echo the full JSONL to stdout. The runner already read the session file under
  `~/.codex/sessions` to detect the observed model, but discarded it for result
  capture, so those runs recorded no transcript at all. `observedModel` now also
  falls back to the stdout transcript when the session file is missing.

- [#158](https://github.com/vercel-labs/agent-eval/pull/158) [`e37d8f0`](https://github.com/vercel-labs/agent-eval/commit/e37d8f0d7dc895725224753216bdd797f9d2766f) Thanks [@huang-julien](https://github.com/huang-julien)! - Fix corrupted command output from the Docker sandbox on large reads. Docker
  multiplexes stdout and stderr into a single framed stream, and frames split
  across `data` events at arbitrary byte offsets. The hand-rolled parser read each
  chunk in isolation, so any frame straddling a chunk boundary was mis-read,
  silently dropping and corrupting bytes (a 512KB `cat` came back short). Framing
  is now delegated to docker-modem's `demuxStream()`.

## 1.5.1

### Patch Changes

- [#186](https://github.com/vercel-labs/agent-eval/pull/186) [`c8ac684`](https://github.com/vercel-labs/agent-eval/commit/c8ac6841c26353c18a2481736d9b9becbf518dd9) Thanks [@gaojude](https://github.com/gaojude)! - Redact run credentials from agent run results. Agents configured through a file we write into the sandbox (opencode's `opencode.json`, codex's TOML) carry the live API key in the agent's cwd, so models read it while orienting and the value lands in the transcript — which consumers commit. Every text-bearing field of `AgentRunResult` (output, transcript, error, test and script output, generated file contents) is now scrubbed on the way out of a run. Redaction is exact-string against the key the framework injected, and happens after the in-sandbox judge reads the transcript so scoring is unaffected.

## 1.5.0

### Minor Changes

- [#181](https://github.com/vercel-labs/agent-eval/pull/181) [`cc57b91`](https://github.com/vercel-labs/agent-eval/commit/cc57b919109312af93b1bd1d09a68b1bc4e60939) Thanks [@OwenKephart](https://github.com/OwenKephart)! - Allow experiment modules to register custom `Agent` implementations under arbitrary stable string IDs.

## 1.4.0

### Minor Changes

- [#172](https://github.com/vercel-labs/agent-eval/pull/172) [`4f8732c`](https://github.com/vercel-labs/agent-eval/commit/4f8732ccdd2fe396ffa2e162644a3632521070c7) Thanks [@gaojude](https://github.com/gaojude)! - Add `expect(transcript).toContainText(needle)` — a deterministic, judge-free EVAL.ts matcher over the materialized transcript. `needle` is an exact substring or a RegExp (use `/…/i` for case-insensitive). Built for `.not` ("the agent never reached for X"): absence checks no longer need a judge run or manual `readFileSync(transcriptPath())`. Misuse (wrong subject, empty needle, empty-matching regex) and a missing/empty transcript throw instead of returning a failed verdict, so `.not` can never invert them into a silent pass.

### Patch Changes

- [#175](https://github.com/vercel-labs/agent-eval/pull/175) [`f661766`](https://github.com/vercel-labs/agent-eval/commit/f661766173cd008e13729190868e8015134ebb26) Thanks [@molebox](https://github.com/molebox)! - Verify and repair the shell tool for native-default Codex runs. Codex CLI >= 0.144.0 (published 2026-07-09) exposes no shell/exec tool to the model when config.toml uses a custom `model_provider` (e.g. the AI Gateway) and omits the `model` key — exactly what native-default runs write. The model still answers, but it cannot run commands, read files, or use installed skills, and it sometimes fabricates command output instead of reporting the missing tool. run.mjs now pre-verifies native-default runs with a fabrication-proof shell canary (a `command_execution` item must carry a random nonce), repairs by re-stating the CLI's own resolved default model as an explicit top-level `model` key in the profile config, re-verifies, and fails loudly if the tool is still unavailable — preserving the canary's captured output on the failure result for triage. The verified outcome is memoized per sandbox (`~/.codex/agent-eval-canary.json`) so judge assertions that re-invoke the runner do not pay repeat canary calls. The repair is recorded as an optional `modelRepair` field propagated through `RunnerResult` → `AgentRunResult` → `EvalRunResult`, so persisted results show which runs needed it (and repairs dropping to zero signals the upstream fix).

## 1.3.1

### Patch Changes

- [#170](https://github.com/vercel-labs/agent-eval/pull/170) [`d6e9c86`](https://github.com/vercel-labs/agent-eval/commit/d6e9c86c769f7dcbe5bf78a1f54ad90c2ac230a0) Thanks [@molebox](https://github.com/molebox)! - Fix OpenCode explicit model overrides never routing through the AI Gateway. `--model anthropic/claude-sonnet-5` was passed to the OpenCode CLI verbatim, which reads the first segment as its _provider_ id — a provider that is not configured in the generated opencode.json (only `vercel`, the AI Gateway, is) — so every explicit-model run died at session start with "Unexpected server error". The model override is now resolved host-side (`vercel/` is prefixed unless the caller already targets `vercel/...` or a configured `extraProviders` key) and handed to the runner via `input.extra`, mirroring codex's `openai/` prefixing. Observed models are reported back in the caller's namespace: when the host added the prefix, the runner strips the leading `vercel/` from the observation, so `observedModel === requestedModel` holds for canonical gateway ids and a gateway substitution still surfaces as a clean gateway id. Native-default observations (e.g. `vercel/google/gemini-3-pro-preview`) and already-prefixed or extra-provider requests are unchanged.

## 1.3.0

### Minor Changes

- [#165](https://github.com/vercel-labs/agent-eval/pull/165) [`b35873c`](https://github.com/vercel-labs/agent-eval/commit/b35873ca4a73b7ec8f021fa6178eedfae826df23) Thanks [@gaojude](https://github.com/gaojude)! - Incremental eval-staleness workflow, so adopting a changed or new eval doesn't force re-running every experiment.

  - Fingerprint split: each result stores a content-only hash next to the combined (content+config) one. A real eval change is never masked; a benign config change (e.g. a `timeout` bump, or pinning a judge) is carried forward by `refingerprint` instead of re-running. Existing `fingerprint` values are byte-identical, so caches stay valid. (Fixes the previous re-fingerprinting that silently re-stamped every result and hid eval changes.)
  - `agent-eval status` — read-only: which evals are new vs changed, per experiment (classified by content). `--check` exits non-zero on any new/changed eval (a simple CI gate); `--json` emits per-experiment new/changed so a consumer can apply its own "which staleness is acceptable" policy.
  - `agent-eval run <experiments...>` — run the named experiments' new/changed evals (auto-carries config-only changes first).
  - Bare `agent-eval` shows status, then (in a terminal) lets you multi-select which experiments to run — it never re-runs everything.
  - Removes `run-all` and `--dry` (the run-everything-when-stale behavior). There is no in-framework "acknowledge/keep" — staleness acceptance is the consumer's policy (e.g. filter `status --json` against an accepted-stale list in CI).

- [#164](https://github.com/vercel-labs/agent-eval/pull/164) [`2905905`](https://github.com/vercel-labs/agent-eval/commit/2905905a27c11873b451627a29e11b20582c49c4) Thanks [@gaojude](https://github.com/gaojude)! - Pin the agentic LLM judge to a fixed agent + model via `ExperimentConfig.judge`. By default the `expect(environment|transcript)` matchers still self-grade with the codegen agent+model; setting `judge: { agent?, model }` grades every run with one fixed judge — the apples-to-apples choice for cross-model comparisons (judge quality no longer varies with the model under test, and a model never grades itself). When `judge.agent` names a different agent, its CLI is installed in the sandbox and its key is resolved from its own env var (falling back to `VERCEL_OIDC_TOKEN`). Pinning is reflected in the eval fingerprint, so pinned runs don't reuse self-graded cached results.

## 1.2.0

### Minor Changes

- [#162](https://github.com/vercel-labs/agent-eval/pull/162) [`7021c4b`](https://github.com/vercel-labs/agent-eval/commit/7021c4b914cc04d77237442ef9bcec307f6ceb0c) Thanks [@gaojude](https://github.com/gaojude)! - Add an agentic LLM-judge matcher for EVAL.ts. Each judge assertion re-invokes the same agent (and model) that did the codegen, in the same sandbox, to evaluate a criterion — then returns pass/fail. No fresh sandbox, no copied evidence.

  ```ts
  import { test, expect } from "vitest";
  import { environment, transcript } from "@vercel/agent-eval/eval";

  test("quality", async () => {
    await expect(environment).toSatisfyCriterion(
      "uses Server Components for the product list"
    );
    await expect(transcript).toSatisfyCriterion(
      "diagnosed with DevTools, not trial-and-error"
    );
    await expect(environment).toScoreAtLeast(
      "production-quality error handling",
      0.8
    );
  });
  ```

  - Two implicit subjects (`environment`, `transcript`) — no paths.
  - You supply only the criterion; the framework owns the prompt + verdict contract.
  - Failures are attributable in the eval output (`[judge:environment] FAIL (score): reason`).
  - The raw transcript is materialized to a sandbox file so the judge reads it by path (never dumped into a prompt). Framework files under `__agent_eval__/` are now gitignored, so they no longer appear in captured generated files.

## 1.1.1

### Patch Changes

- [#152](https://github.com/vercel-labs/agent-eval/pull/152) [`c016ea0`](https://github.com/vercel-labs/agent-eval/commit/c016ea0319c2c22bbe515ff9647b8e6e64b4be07) Thanks [@molebox](https://github.com/molebox)! - Fix Claude Code prompt being consumed by `--allowedTools` when `webResearch` is enabled. The flag is variadic and keeps capturing positionals until the next flag, so even the single comma-separated token from 1.1.0 swallowed the trailing prompt ("Input must be provided either through stdin or as a prompt argument when using --print", verified live on claude 2.1.112). `--allowedTools` is now emitted before the always-present `--dangerously-skip-permissions`, which terminates the variadic capture before the prompt. Default-off argument construction is unchanged.

## 1.1.0

### Minor Changes

- [#150](https://github.com/vercel-labs/agent-eval/pull/150) [`084d895`](https://github.com/vercel-labs/agent-eval/commit/084d895f664f4467f577abe91d9238e23b41ad57) Thanks [@molebox](https://github.com/molebox)! - Add an opt-in `webResearch` option that enables each agent's web research tools so recommendation evals can produce citation/source data. Default is off: command construction is byte-identical to previous releases for existing consumers.

  The option is available on `AgentRunOptions` and on `ExperimentConfig`, and is forwarded by `runExperiment`/`runSingleEval`, so both direct `executeAgent` callers and experiment-config consumers can use it.

  When enabled:

  - Claude Code: allows `WebSearch` and `WebFetch` via a single comma-separated `--allowedTools` value (the flag is variadic — the space-separated form in #141 consumed the trailing positional prompt as a tool name, which is what broke all CLI evals and forced the #144 revert).
  - Codex: sets `tools.web_search = true` in the generated profile config.
  - OpenCode: sets `OPENCODE_ENABLE_EXA=1` and allows the `websearch`/`webfetch` tools.

## 1.0.1

### Patch Changes

- [#148](https://github.com/vercel-labs/agent-eval/pull/148) [`b4841d6`](https://github.com/vercel-labs/agent-eval/commit/b4841d67910938d004c261960d1e171f19151b57) Thanks [@molebox](https://github.com/molebox)! - Fix OpenCode observed model extraction for OpenCode >= 1.17.0. The log-scrape source (`service=llm ... providerID= modelID=` lines) was removed in OpenCode 1.17.0's logging rewrite, which caused native-default runs to report no observed model. The adapter now falls back to `opencode export <sessionID>`, reading `providerID`/`modelID` from the exported assistant message. The legacy log scrape is kept as the first, cheaper source for older CLI versions.

## 1.0.0

### Major Changes

- [#146](https://github.com/vercel-labs/agent-eval/pull/146) [`aa66c4d`](https://github.com/vercel-labs/agent-eval/commit/aa66c4d35b121e66470cbd49ac3d6ba3bb976325) Thanks [@molebox](https://github.com/molebox)! - Change omitted `model` config to use the underlying agent CLI's native default instead of agent-eval's hardcoded adapter defaults, and record observed runtime model metadata when available.

## 0.14.5

### Patch Changes

- [#144](https://github.com/vercel-labs/agent-eval/pull/144) [`450bed3`](https://github.com/vercel-labs/agent-eval/commit/450bed3b94e024649ed771eb12157f9361533e6f) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Revert "Enable source-capable web tools for agent runs" (#141), which broke CLI evals.

## 0.14.4

### Patch Changes

- [#141](https://github.com/vercel-labs/agent-eval/pull/141) [`2d27942`](https://github.com/vercel-labs/agent-eval/commit/2d27942cc3a21d840e2a8deb7fd8ccc376dea319) Thanks [@molebox](https://github.com/molebox)! - Enable source-capable web tools for recommendation eval agent runs.

## 0.14.3

### Patch Changes

- [#140](https://github.com/vercel-labs/agent-eval/pull/140) [`a9efa3a`](https://github.com/vercel-labs/agent-eval/commit/a9efa3ad1fc26c74f7dc2fba170b90ecfffa49c1) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Default the Codex profile's `model_reasoning_effort` to `"medium"`.

  The Codex CLI's own default is `"low"`, which `gpt-5.2-codex` (the default
  Codex model) rejects with `Unsupported value: 'low' is not supported with
the 'gpt-5.2-codex' model. Supported values are: 'medium'.`. The Codex
  adapter now writes `model_reasoning_effort` into the generated profile so
  fresh `codex exec` runs against the AI Gateway succeed out of the box.
  Callers can still override per-run via
  `model: "gpt-5.2-codex?reasoningEffort=high"`.

## 0.14.2

### Patch Changes

- [#138](https://github.com/vercel-labs/agent-eval/pull/138) [`5950d74`](https://github.com/vercel-labs/agent-eval/commit/5950d74405dbbb4c15658b20ad73281cbd965325) Thanks [@molebox](https://github.com/molebox)! - Update the Codex adapter for the current Codex CLI profile-file config format.

## 0.14.1

### Patch Changes

- [#126](https://github.com/vercel-labs/agent-eval/pull/126) [`ea8d7ab`](https://github.com/vercel-labs/agent-eval/commit/ea8d7abba64165bd2b7e08e64450517cd31e3b67) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Run agent tasks from a neutral workspace to avoid sandbox provider path leakage.

## 0.14.0

### Minor Changes

- [#123](https://github.com/vercel-labs/agent-eval/pull/123) [`07614ec`](https://github.com/vercel-labs/agent-eval/commit/07614ec3b769581abd4cd1845a5ff62f3a2c1b11) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Add response-only eval support, post-run analysis hooks, and brand definitions.

## 0.13.1

### Patch Changes

- [#121](https://github.com/vercel-labs/agent-eval/pull/121) [`384133b`](https://github.com/vercel-labs/agent-eval/commit/384133b9823107d14659f78a6af98cbd37949a14) Thanks [@gaojude](https://github.com/gaojude)! - Surface AI Gateway errors during classification instead of swallowing them. `classifyWithAI` and `classifyFailure` now throw on gateway/network failures, and `runAllCommand` collects per-eval classifier errors and prints them at the end of the classify phase. Previously a 402 (insufficient funds), network blip, or any other gateway error would silently leave failures with no `classification.json`, which the cache reuse path then refuses to reuse — causing those evals to re-run on every subsequent invocation.

## 0.13.0

### Minor Changes

- [#118](https://github.com/vercel-labs/agent-eval/pull/118) [`660ea3e`](https://github.com/vercel-labs/agent-eval/commit/660ea3ea201307f4f8a42efa2f4f4da396a545e4) Thanks [@gaojude](https://github.com/gaojude)! - Remove auto-retry of non-model failures. The `--max-retries` flag is gone; non-model failures are now removed by default (re-run to retry) or kept with `--ack-failures`.

## 0.12.1

### Patch Changes

- [#115](https://github.com/vercel-labs/agent-eval/pull/115) [`a3c2136`](https://github.com/vercel-labs/agent-eval/commit/a3c2136f035071f4274ab7f4200fb81d1776a7ad) Thanks [@gaojude](https://github.com/gaojude)! - Reconnect on terminated HTTP streams in `SandboxManager.runCommand`/`runShell` so in-sandbox commands exceeding ~5 min don't fail spuriously with `error: "terminated"`.

## 0.12.0

### Minor Changes

- [#113](https://github.com/vercel-labs/agent-eval/pull/113) [`a209ae0`](https://github.com/vercel-labs/agent-eval/commit/a209ae099fd27048ee37de207d07a30c64e7431c) Thanks [@gaojude](https://github.com/gaojude)! - Add `cliPackage` and `effort` `agentOptions` for Claude Code. Lets users override the installed npm package (e.g. `@anthropic-ai/claude-code@next`) and pass `--effort <level>`, which is required by models that use the new `thinking.type.adaptive` API such as Opus 4.7.

## 0.11.0

### Minor Changes

- [#110](https://github.com/vercel-labs/agent-eval/pull/110) [`481637d`](https://github.com/vercel-labs/agent-eval/commit/481637dd6e5ea26465cae864a850880a42647209) Thanks [@gaojude](https://github.com/gaojude)! - Auto-retry non-model failures up to 5 rounds by default, then auto-acknowledge remaining. Control with `--max-retries <n>` or `--ack-failures`.

### Patch Changes

- [#112](https://github.com/vercel-labs/agent-eval/pull/112) [`f838bd7`](https://github.com/vercel-labs/agent-eval/commit/f838bd7363d51108952008bd54645a871efa709f) Thanks [@gaojude](https://github.com/gaojude)! - Pass experiment timeout to OpenCode provider config so the Vercel AI Gateway has a request-level timeout.

## 0.10.1

### Patch Changes

- [#108](https://github.com/vercel-labs/agent-eval/pull/108) [`5185640`](https://github.com/vercel-labs/agent-eval/commit/5185640dde9c0b77a474d29e7736b994a45eb9cf) Thanks [@gaojude](https://github.com/gaojude)! - Deep-merge vercel provider config in OpenCode agent and use user-space binary install path

## 0.10.0

### Minor Changes

- [#106](https://github.com/vercel-labs/agent-eval/pull/106) [`8d138a2`](https://github.com/vercel-labs/agent-eval/commit/8d138a28e7855ef5218c8cf1301064c6caca8e1f) Thanks [@jerilynzheng](https://github.com/jerilynzheng)! - Add `agentOptions` field to `ExperimentConfig` for passing agent-specific options (like `binaryUrl` and `extraProviders`) at runtime. This enables replicable eval configs for unreleased models that require patched agent binaries.

### Patch Changes

- [#104](https://github.com/vercel-labs/agent-eval/pull/104) [`df0dfb6`](https://github.com/vercel-labs/agent-eval/commit/df0dfb66572da228ae7f0797c7a1cdad545dbc52) Thanks [@runeb](https://github.com/runeb)! - Fix Codex agent to append to config.toml instead of overwriting it, preserving any config written by the experiment's setup function.

## 0.9.5

### Patch Changes

- [#99](https://github.com/vercel-labs/agent-eval/pull/99) [`ec11c4a`](https://github.com/vercel-labs/agent-eval/commit/ec11c4a6b5003748b2c145b167f7d4d38051c0b1) Thanks [@gaojude](https://github.com/gaojude)! - Add `override: true` to dotenv config so `.env.local` and `.env` values consistently take precedence over pre-existing shell environment variables.

## 0.9.4

### Patch Changes

- [#97](https://github.com/vercel-labs/agent-eval/pull/97) [`4815bab`](https://github.com/vercel-labs/agent-eval/commit/4815babe1753d82edd925574bfb7b014d1097b5d) Thanks [@gaojude](https://github.com/gaojude)! - Bump minimatch to 10.2.4 to fix ReDoS vulnerability (GHSA-3ppc-4f35-3m26)

## 0.9.3

### Patch Changes

- [#95](https://github.com/vercel-labs/agent-eval/pull/95) [`6ced2ea`](https://github.com/vercel-labs/agent-eval/commit/6ced2ea189a24a64552f10f670c58083840be905) Thanks [@gaojude](https://github.com/gaojude)! - Use the built-in `openai` provider in Codex config instead of re-declaring a custom OpenAI provider block.

- [#55](https://github.com/vercel-labs/agent-eval/pull/55) [`0f9ba7a`](https://github.com/vercel-labs/agent-eval/commit/0f9ba7ad7e5ae8aa312380eac789198c4f16e80c) Thanks [@hyf0](https://github.com/hyf0)! - Support `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code agent authentication. When set, the OAuth token is used instead of `ANTHROPIC_API_KEY`, enabling Claude Pro/Max subscription users to run evals without a separate API key.

## 0.9.2

### Patch Changes

- [`5aa83e4`](https://github.com/vercel-labs/agent-eval/commit/5aa83e4efd10826e85959e0f565042e4fe96a2c2) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Capture transcripts on a best-effort basis for failed and aborted runs (not just successful runs) across supported agents, so result folders can include transcripts when available for downstream ingestion and debugging.

## 0.9.1

### Patch Changes

- [`eb0eea9`](https://github.com/vercel-labs/agent-eval/commit/eb0eea919a89cbe8a0171ad56e9f135e944e42cc) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Wire Vercel Sandbox auth to use `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` from env vars when all are present, so CI can authenticate with access tokens instead of requiring OIDC context.

## 0.9.0

### Minor Changes

- [#85](https://github.com/vercel-labs/agent-eval/pull/85) [`0974903`](https://github.com/vercel-labs/agent-eval/commit/097490384cf6ae71cd5c18ce0a9b852c9648e2a3) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Inject transcript context into the sandbox before EVAL.ts runs. After the agent completes, the parsed transcript summary is written to `__agent_eval__/results.json` so tests can assert on agent behavior — shell commands executed, files modified, tool call counts, and more.

## 0.8.0

### Minor Changes

- [#81](https://github.com/vercel-labs/agent-eval/pull/81) [`330ec5e`](https://github.com/vercel-labs/agent-eval/commit/330ec5e8b727086cac1bc44c990ab25f6a905b31) Thanks [@gaojude](https://github.com/gaojude)! - Switch classifier model to Claude Haiku 4.5 and parallelize classification with p-limit (concurrency 4)

### Patch Changes

- [#80](https://github.com/vercel-labs/agent-eval/pull/80) [`620fb47`](https://github.com/vercel-labs/agent-eval/commit/620fb473ade4ca354c06f51f93d3b13f2fff32af) Thanks [@gaojude](https://github.com/gaojude)! - Fix `run-all` subcommand options (`--dry`, `--force`, `--smoke`, `--ack-failures`) being silently intercepted by the parent Commander.js program

- [#77](https://github.com/vercel-labs/agent-eval/pull/77) [`c8bcde3`](https://github.com/vercel-labs/agent-eval/commit/c8bcde36d11fa7f2f9999de72b47d6d83eaf42c3) Thanks [@gaojude](https://github.com/gaojude)! - Add StartRateLimiter to throttle sandbox starts and retry anomalously fast failures with exponential backoff

## 0.7.1

### Patch Changes

- [#75](https://github.com/vercel-labs/agent-eval/pull/75) [`9558ee9`](https://github.com/vercel-labs/agent-eval/commit/9558ee90b9bfd11f347977be249367f30527e631) Thanks [@gaojude](https://github.com/gaojude)! - Remove debug console.log from saveResults function

## 0.7.0

### Minor Changes

- [#73](https://github.com/vercel-labs/agent-eval/pull/73) [`be7ca15`](https://github.com/vercel-labs/agent-eval/commit/be7ca1560e8137baf3369fbdb859f9cde5f75778) Thanks [@gaojude](https://github.com/gaojude)! - Add Cursor CLI agent with direct API and stream-json transcript support. Enables testing against Cursor models (default: `composer-1.5`) through direct API access. The agent captures detailed execution transcripts in JSONL format and is fully integrated with the eval framework sandbox infrastructure.

- [#71](https://github.com/vercel-labs/agent-eval/pull/71) [`8f198d4`](https://github.com/vercel-labs/agent-eval/commit/8f198d4d183b9b919deb315c0a490d92394111de) Thanks [@gaojude](https://github.com/gaojude)! - Add Gemini CLI agent with direct API and stream-json transcript support. Enables testing against Gemini models (default: `gemini-3-pro-preview`) through direct Google API access. The agent captures detailed execution transcripts in JSONL format and is fully integrated with the eval framework sandbox infrastructure.

- [#74](https://github.com/vercel-labs/agent-eval/pull/74) [`087415c`](https://github.com/vercel-labs/agent-eval/commit/087415c73dbac50ce1ff3948b22d5770b5da363e) Thanks [@gaojude](https://github.com/gaojude)! - Add transcript parsers for Gemini and Cursor agents to the o11y module

## 0.6.2

### Patch Changes

- [#69](https://github.com/vercel-labs/agent-eval/pull/69) [`93c1a63`](https://github.com/vercel-labs/agent-eval/commit/93c1a6390a25e583ed63c7818a4403f614acf2d7) Thanks [@paoloricciuti](https://github.com/paoloricciuti)! - fix: add all the files to track newly created files

## 0.6.1

### Patch Changes

- [#64](https://github.com/vercel-labs/agent-eval/pull/64) [`f7b663a`](https://github.com/vercel-labs/agent-eval/commit/f7b663a4edef22ac2de8dc72775c0d6e9d0ab10f) Thanks [@paoloricciuti](https://github.com/paoloricciuti)! - feat: add option to save the updated project inside results

## 0.6.0

### Minor Changes

- [#65](https://github.com/vercel-labs/agent-eval/pull/65) [`cf50218`](https://github.com/vercel-labs/agent-eval/commit/cf50218fe2f3ec30241809edc91f356ca684e39d) Thanks [@gaojude](https://github.com/gaojude)! - Make classifier feature optional and add feature flag

  **Features:**

  - Added `isClassifierEnabled()` function to check if classifier is available (requires `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`)
  - Classifier is now optional: if neither env var is set, classification is skipped and all results are preserved
  - Warning message now displays when classifier is disabled, explaining why the keys are needed
  - Updated README to document classifier behavior and environment variable requirements

  **Changes:**

  - CLI skips entire classification block when classifier is disabled
  - Housekeeping no longer removes non-model failures when classifier is disabled (only removes incomplete/duplicate results)
  - All tests updated to properly enable classifier for tests that require it
  - Added test case for disabled classifier behavior

## 0.5.0

### Minor Changes

- [#63](https://github.com/vercel-labs/agent-eval/pull/63) [`bc5114c`](https://github.com/vercel-labs/agent-eval/commit/bc5114cea6638aa1704233ebed96a3d81e20ba12) Thanks [@gaojude](https://github.com/gaojude)! - Add live terminal dashboard for parallel experiment runs

### Patch Changes

- [#61](https://github.com/vercel-labs/agent-eval/pull/61) [`b846fc7`](https://github.com/vercel-labs/agent-eval/commit/b846fc7ec7c92579b90f659eddba08af23927cce) Thanks [@paoloricciuti](https://github.com/paoloricciuti)! - fix: allow user defined tests in `verifyNoTestFiles`

## 0.4.1

### Patch Changes

- [#58](https://github.com/vercel-labs/agent-eval/pull/58) [`6cd92aa`](https://github.com/vercel-labs/agent-eval/commit/6cd92aa8f681bf1af0c544589a44ec73d42844cd) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Fix transcript parsing for Codex and OpenCode agents

  **Codex:**

  - Added support for `item.started` and `item.completed` event types from OpenAI Responses API
  - Now properly parses `reasoning` items as thinking blocks
  - Now properly parses `command_execution` items as shell tool calls with exit codes
  - Now properly parses `agent_message` items as assistant messages
  - Fixed critical bug in `command_execution` success logic: changed from OR (`||`) to AND (`&&`) so commands with non-zero exit codes are correctly marked as failed even when status is "completed"
  - Transcript parsing now correctly reports turn counts, tool calls, thinking blocks, and shell command results

  **OpenCode:**

  - Fixed exit code checking for bash commands - now correctly marks commands with non-zero exit codes as failed
  - Shell commands with exit code 127 (command not found) now properly show `success: false` instead of `success: true`

  **Playground:**

  - Updated shell command display to check `success` field first, then fall back to exit code
  - Added tooltip showing exit code on hover for shell commands

  Both parsers are model-agnostic and work consistently across all model variants using their respective APIs.

## 0.4.0

### Minor Changes

- [#56](https://github.com/vercel-labs/agent-eval/pull/56) [`5e45159`](https://github.com/vercel-labs/agent-eval/commit/5e451599e036fc44c0b1c2bf0e9936a9ea131dcd) Thanks [@gaojude](https://github.com/gaojude)! - Support reasoning effort via model string query params for Codex (e.g. `gpt-5.3-codex?reasoningEffort=high`), install CA certificates in Docker sandbox, retry npm install once on failure, and exclude smoke test results from fingerprint-based reuse.

## 0.3.2

### Patch Changes

- [#49](https://github.com/vercel-labs/agent-eval/pull/49) [`465fbac`](https://github.com/vercel-labs/agent-eval/commit/465fbac30bb55f01089d977463a74a6dcbea3e63) Thanks [@paoloricciuti](https://github.com/paoloricciuti)! - fix: allow `VERCEL_OIDC_TOKEN` if `AI_GATEWAY_API_KEY` is not set

## 0.3.1

### Patch Changes

- [#47](https://github.com/vercel-labs/agent-eval/pull/47) [`e10e69b`](https://github.com/vercel-labs/agent-eval/commit/e10e69b2b3e6e4632ee88056bfb4eab1a57e6570) Thanks [@gaojude](https://github.com/gaojude)! - Fix fingerprint reuse: fingerprints are now persisted to `summary.json` so results can actually be reused across runs. Also fixes `--dry` to check reusability and report what would run, `--smoke` to always run fresh and skip housekeeping, and housekeeping to dedupe by fingerprint so results from different configs coexist.

## 0.3.0

### Minor Changes

- [#44](https://github.com/vercel-labs/agent-eval/pull/44) [`9f7af62`](https://github.com/vercel-labs/agent-eval/commit/9f7af6276ce0f61c79c31ef66cc47b161c0f0028) Thanks [@gaojude](https://github.com/gaojude)! - Add `run-all` command with fingerprinting, failure classification, and housekeeping.

  - **run-all command**: Auto-discovers `experiments/*.ts` and runs them all with fingerprint reuse, AI failure classification, auto-retry of infra failures, and housekeeping. Now the default when `agent-eval` is invoked with no arguments.
  - **Content fingerprinting**: Computes SHA-256 fingerprints from eval files + config. Skips evals with matching cached results. Safe to extend model arrays or add new evals.
  - **Failure classification**: Classifies failed evals as model/infra/timeout using AI via `gateway('anthropic/claude-sonnet-4-5')` with sandboxed tools. Requires `AI_GATEWAY_API_KEY`.
  - **Housekeeping**: Removes duplicate results, incomplete results, and empty timestamp directories after each experiment.
  - **--smoke flag**: Picks the first eval alphabetically and runs it once per model for quick setup verification.
  - **Output naming fix**: Script outputs moved to `outputs/scripts/{name}.txt` to prevent collision with `outputs/eval.txt`.

## 0.2.0

### Minor Changes

- [#34](https://github.com/vercel-labs/agent-eval/pull/34) [`01cff78`](https://github.com/vercel-labs/agent-eval/commit/01cff7846c7909d3fb38400b519a9a9968992294) Thanks [@paoloricciuti](https://github.com/paoloricciuti)! - fix: always add model name to experiment run

## 0.1.0

### Minor Changes

- [#30](https://github.com/vercel-labs/agent-eval/pull/30) [`a61c89e`](https://github.com/vercel-labs/agent-eval/commit/a61c89e371bb9b459e448360cd9c8572c37eecc4) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Add support for nested eval directories. You can now organize evals into folders and use glob patterns to filter them:

  ```
  evals/
    vercel-cli/
      deploy/
      link/
    flags/
      create/
      update/
  ```

  Filter examples in experiment config:

  - `evals: 'vercel-cli/*'` - Run all vercel-cli evals
  - `evals: ['vercel-cli/*', 'flags/*']` - Run multiple categories
  - `evals: '*/deploy'` - Run all deploy evals across folders
  - `evals: 'vercel-cli/deploy'` - Run specific nested eval

  Results automatically maintain the hierarchy (e.g., `results/experiment/.../vercel-cli/deploy/`).

## 0.0.15

### Patch Changes

- [#23](https://github.com/vercel-labs/agent-eval/pull/23) [`02b86e0`](https://github.com/vercel-labs/agent-eval/commit/02b86e0b172d61d3c828a2521404c32675e99876) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Added comprehensive README.md to the `init` template with setup instructions, usage examples, project structure overview, and tips for creating new evals.

## 0.0.14

### Patch Changes

- [#23](https://github.com/vercel-labs/agent-eval/pull/23) [`02b86e0`](https://github.com/vercel-labs/agent-eval/commit/02b86e0b172d61d3c828a2521404c32675e99876) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Also fixed `init` command to dynamically use the current package version (matching create-next-app pattern) instead of hardcoded "^0.0.1" in the generated package.json.

## 0.0.13

### Patch Changes

- [#21](https://github.com/vercel-labs/agent-eval/pull/21) [`5764ca9`](https://github.com/vercel-labs/agent-eval/commit/5764ca9ec4d3048943d99794052fd87e36e8eeb4) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Fix TypeScript config file loading by adding jiti support. Previously, running `npx @vercel/agent-eval <experiment>` with a TypeScript config file would fail with "Unknown file extension .ts" error. The CLI now properly loads both .ts and .js config files.

## 0.0.12

### Patch Changes

- [#18](https://github.com/vercel-labs/agent-eval/pull/18) [`85bfb21`](https://github.com/vercel-labs/agent-eval/commit/85bfb21b5491d66de5905163250121854ef93504) Thanks [@paoloricciuti](https://github.com/paoloricciuti)! - feat: add `editPrompt` config to experiment

## 0.0.11

### Patch Changes

- [`558abe5`](https://github.com/vercel-labs/agent-eval/commit/558abe59602b05e1c353fd5cd64ee5437de4b8a3) Thanks [@paoloricciuti](https://github.com/paoloricciuti)! - feat: accept array of models in experiment #10

## 0.0.10

### Patch Changes

- [#13](https://github.com/vercel-labs/agent-eval/pull/13) [`bb3c09b`](https://github.com/vercel-labs/agent-eval/commit/bb3c09bf5ded138ee693ed7b1e73486f40e947d6) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Add observability (o11y) module for transcript parsing and analysis

  - Normalized transcript parsing for Claude Code, Codex, and OpenCode agents
  - Summary statistics: tool calls, files read/modified, shell commands, errors
  - Save parsed transcript as `transcript.json` and raw as `transcript-raw.jsonl`
  - Include `o11y` summary and `transcriptRawPath` in `result.json`
  - Export `parseTranscript`, `loadTranscript`, `SUPPORTED_AGENTS` from public API
  - Fix Codex agent `wire_api` config and transcript capture on failure
