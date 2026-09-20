---
"@vercel/agent-eval": patch
---

Fix Docker sandbox containers leaking when the CLI is interrupted. Active containers are now tracked and stopped on `SIGINT`/`SIGTERM`.
