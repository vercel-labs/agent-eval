---
"@vercel/agent-eval": patch
---

Redact run credentials from agent run results. Agents configured through a file we write into the sandbox (opencode's `opencode.json`, codex's TOML) carry the live API key in the agent's cwd, so models read it while orienting and the value lands in the transcript — which consumers commit. Every text-bearing field of `AgentRunResult` (output, transcript, error, test and script output, generated file contents) is now scrubbed on the way out of a run. Redaction is exact-string against the key the framework injected, and happens after the in-sandbox judge reads the transcript so scoring is unaffected.
