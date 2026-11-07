---
'@vercel/agent-eval': minor
---

Parse Codex paginated saved-session transcripts when `codex exec --json` produces no JSONL. Read completed items without double-counting their duplicate `response_item` records, preserve the raw transcript and token accounting, and apply Codex's command-display secret masking. Exclude session files that predate the run and require an unambiguous exec session when no thread ID is available, so fallback cannot select a canary or child-agent transcript.

When Codex parsing fails without usable events, including unsupported legacy activity even with a terminal error, omit `o11y` from saved results and expose `o11y: null` to EVAL.ts instead of misleading zero counters. Keep usable partial results, successfully parsed empty runs, and both transcript files. Other agents retain their existing summary behavior. Saved sessions can omit in-flight commands and stdout-only retry notifications; error counts can differ between sources.

Expose optional top-level `usage` in EVAL.ts's `__agent_eval__/results.json`, even without a usable transcript summary. Preserve `o11y.usage` when a summary is available and continue to prefer runner-reported usage over transcript usage.
