# @vercel/agent-eval

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
