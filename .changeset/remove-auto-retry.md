---
"@vercel/agent-eval": minor
---

Remove auto-retry of non-model failures. The `--max-retries` flag is gone; non-model failures are now removed by default (re-run to retry) or kept with `--ack-failures`.
