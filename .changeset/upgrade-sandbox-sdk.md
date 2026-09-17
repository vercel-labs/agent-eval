---
"@vercel/agent-eval": patch
---

Upgrade `@vercel/sandbox` to version 3 while preserving the existing Node.js 24 runtime and ephemeral sandbox lifecycle. Version 3 transparently starts a new session when the previous one stopped; because eval sandboxes are ephemeral that would continue a run on an empty filesystem, so the wrapper now fails the run with `SandboxSessionRecycledError` instead, matching the hard failure previous versions produced.
