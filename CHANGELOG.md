# @vercel/agent-eval

## 0.0.10

### Patch Changes

- [#13](https://github.com/vercel-labs/agent-eval/pull/13) [`bb3c09b`](https://github.com/vercel-labs/agent-eval/commit/bb3c09bf5ded138ee693ed7b1e73486f40e947d6) Thanks [@allenzhou101](https://github.com/allenzhou101)! - Add observability (o11y) module for transcript parsing and analysis

  - Normalized transcript parsing for Claude Code, Codex, and OpenCode agents
  - Summary statistics: tool calls, files read/modified, shell commands, errors
  - Save parsed transcript as `transcript.json` and raw as `transcript-raw.jsonl`
  - Include `o11y` summary and `transcriptRawPath` in `result.json`
  - Export `parseTranscript`, `loadTranscript`, `SUPPORTED_AGENTS` from public API
  - Fix Codex agent `wire_api` config and transcript capture on failure
