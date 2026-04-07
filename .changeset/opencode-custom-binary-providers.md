---
"@vercel/agent-eval": patch
---

Add `binaryUrl` and `extraProviders` options to `createOpenCodeAgent`. `binaryUrl` downloads a custom OpenCode binary instead of installing from npm, and `extraProviders` adds provider entries to `opencode.json` — together these enable evals against early access models not yet listed on models.dev.
