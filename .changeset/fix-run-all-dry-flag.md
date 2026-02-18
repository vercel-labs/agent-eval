---
"@vercel/agent-eval": patch
---

Fix `run-all` subcommand options (`--dry`, `--force`, `--smoke`, `--ack-failures`) being silently intercepted by the parent Commander.js program
