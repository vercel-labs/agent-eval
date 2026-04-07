---
"@vercel/agent-eval": patch
---

Fix Codex agent to append to config.toml instead of overwriting it, preserving any config written by the experiment's setup function.
