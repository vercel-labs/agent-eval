---
"@vercel/agent-eval": patch
---

Add `override: true` to dotenv config so `.env.local` and `.env` values consistently take precedence over pre-existing shell environment variables.
