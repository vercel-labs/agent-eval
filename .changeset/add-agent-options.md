---
"@vercel/agent-eval": minor
---

Add `agentOptions` field to `ExperimentConfig` for passing agent-specific options (like `binaryUrl` and `extraProviders`) at runtime. This enables replicable eval configs for unreleased models that require patched agent binaries.
