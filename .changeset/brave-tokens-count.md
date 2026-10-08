---
'@vercel/agent-eval': minor
'@vercel/agent-eval-playground': patch
---

Record token usage and cost on every run. The transcript parsers now read the usage each agent CLI reports (Claude Code session entries, de-duplicated by message id; Codex `turn.completed` and saved-session `token_count` totals; OpenCode `step_finish` events; Gemini `result` stats; `fx ask --json` usage) into a new `TokenUsage` type. It appears as `usage` on `EvalRunResult` and in `result.json`, as `o11y.usage` in the transcript summary that EVAL.ts reads from `__agent_eval__/results.json`, and as an aggregated `usage` block in `summary.json` when at least one run reported usage. Nothing is estimated: fields the CLI doesn't report are left out, and `costUsd` is recorded only when the CLI itself reports a cost. Usage covers the code-generation run, not judge assertions. Custom agents can return `usage` from `run()` directly. The playground shows tokens and cost per run.
