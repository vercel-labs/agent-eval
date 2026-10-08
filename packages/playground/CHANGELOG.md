# @vercel/agent-eval-playground

## 0.1.4

### Patch Changes

- [#209](https://github.com/vercel-labs/agent-eval/pull/209) [`a94b027`](https://github.com/vercel-labs/agent-eval/commit/a94b027e78533ba617c8b19c919a4b4d5f81d8fd) Thanks [@molebox](https://github.com/molebox)! - Record token usage and cost on every run. The transcript parsers now read the usage each agent CLI reports (Claude Code session entries, de-duplicated by message id; Codex `turn.completed` and saved-session `token_count` totals; OpenCode `step_finish` events; Gemini `result` stats) into a new `TokenUsage` type. fx reports usage only in `fx ask --json`, not in its saved-session transcript, so its runner returns those counts through a new optional `usage` field on the runner result. Usage appears as `usage` on `EvalRunResult` and in `result.json`, as `o11y.usage` in the transcript summary that EVAL.ts reads from `__agent_eval__/results.json`, and as an aggregated `usage` block in `summary.json` when at least one run reported usage. Nothing is estimated: fields the CLI doesn't report are left out, and `costUsd` is recorded only when the CLI itself reports a cost. Usage covers the code-generation run, not judge assertions. Custom agents can return `usage` from `run()` or from their runner directly. The playground shows tokens and cost per run.

## 0.1.3

### Patch Changes

- [#58](https://github.com/vercel-labs/agent-eval/pull/58) [`e42dbf7`](https://github.com/vercel-labs/agent-eval/commit/e42dbf7d4c285bfc1799ac173a1e9f65b9e15169) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Fix shell command success/failure display

  - Updated shell command badges to check `success` field first, then fall back to `exitCode === 0`
  - Added tooltip showing exit code on hover
  - Commands with non-zero exit codes now correctly display in red (destructive variant)

## 0.1.2

### Patch Changes

- [#36](https://github.com/vercel-labs/agent-eval/pull/36) [`621e989`](https://github.com/vercel-labs/agent-eval/commit/621e9893e5e6f6ea0bb454a914cf93f8c58bea42) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Fix playground UI to correctly display nested eval results by recursively discovering eval directories instead of only checking immediate subdirectories

- [#34](https://github.com/vercel-labs/agent-eval/pull/34) [`8d712a6`](https://github.com/vercel-labs/agent-eval/commit/8d712a63500c9560519f51093d19ce4f6e501ebe) Thanks [@paoloricciuti](https://github.com/paoloricciuti)! - fix: adapt to new result structure

## 0.1.1

### Patch Changes

- [`08499ab`](https://github.com/vercel-labs/agent-eval/commit/08499abc1b4670f2a25a15e99d995ab2600acb8b) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Move TypeScript from devDependencies to dependencies to fix "Cannot find module 'typescript'" error when running via npx.

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

## 0.0.5

### Patch Changes

- [`6159d01`](https://github.com/vercel-labs/agent-eval/commit/6159d01b6e2a064bfb4abd8006b7797c553c58f2) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Run playground in production mode (`next start`) instead of dev mode (`next dev`) to fix React version conflicts and "Cannot read properties of null (reading 'useInsertionEffect')" errors when running via npx.

## 0.0.4

### Patch Changes

- [`23e2d43`](https://github.com/vercel-labs/agent-eval/commit/23e2d439e6cead7939633dcf753c5c8f29f7892a) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Add repository field to package.json to fix npm provenance verification error during publishing.

## 0.0.3

### Patch Changes

- [`6425d0a`](https://github.com/vercel-labs/agent-eval/commit/6425d0acb4e6e4bcb5f95d34001e1e369a7484ab) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Fix build error caused by invalid `shadcn/tailwind.css` import in globals.css. The import has been removed as all styles are already inlined in the file.

## 0.0.2

### Patch Changes

- [#25](https://github.com/vercel-labs/agent-eval/pull/25) [`4228d3c`](https://github.com/vercel-labs/agent-eval/commit/4228d3c50b8a09d4434c5969335a9d397daaba2b) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Fix React version conflicts when running playground via npx. The playground now builds during publish and runs in production mode (`next start`) instead of development mode (`next dev`), eliminating "Invalid hook call" errors caused by multiple React instances.
