---
'@vercel/agent-eval': minor
---

Record provenance on every run. `EvalRunResult` and `result.json` gain a `provenance` object with the `@vercel/agent-eval` version, the agent CLI version, the sandbox backend, the digest-pinned sandbox image (when `sandboxImage` is set), and the sandbox user. The CLI version comes from a new optional `versionCommand` on `AgentDefinition`, which the orchestrator runs once after install; every built-in agent defines one, and a failing or silent version command leaves the field unset without failing the run. `SandboxManager` and `DockerSandboxManager` expose `backend` and `username`. Provenance is not part of the result-reuse fingerprint.
