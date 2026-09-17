---
"@vercel/agent-eval": minor
---

Upgrade `@vercel/sandbox` to version 3 while preserving the existing Node.js 24 runtime and ephemeral sandbox lifecycle. Version 3 transparently starts a new session when the previous one stopped; because eval sandboxes are ephemeral that would continue a run on an empty filesystem, so the wrapper now fails the run with `SandboxSessionRecycledError` instead, matching the hard failure previous versions produced.

Two opt-in options for the Vercel backend, both unset by default so existing experiments are unchanged: `sandboxImage` boots the sandbox from a Vercel Container Registry image (for example `vercel/sandbox/node:24` or a digest-pinned custom image) instead of the legacy runtime, and `sandboxUser` runs the agent as a freshly created Linux user with its own home and workspace instead of the sandbox's default account. In user mode, command environments are delivered through a user-owned file sourced by a bash bootstrap rather than command arguments, so agent auth tokens stay out of process listings and sandbox command records. Both options are available on `ExperimentConfig`, `AgentRunOptions`, and `SandboxOptions` (`image` / `user`), and both are part of the result-reuse fingerprint so cached default-environment results are not reused for them.
