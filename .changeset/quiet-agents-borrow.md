---
'@vercel/agent-eval': minor
---

Add `agentEnv` to `ExperimentConfig` and `AgentRunOptions` for tasks that need authenticated tools. The variables are merged into the agent process's environment only: they never appear in command arguments (with `sandboxUser`, they travel through the existing user-owned env file), and validation and judge runs don't receive them. Every value is added to the credential redaction, so results, transcripts, outputs, copied files, and reporter payloads are scrubbed. A key that collides with the agent's authentication variables or the workspace identity variables (`USER`, `LOGNAME`) is rejected before a sandbox boots. Only the sorted key names enter the result-reuse fingerprint, and only when `agentEnv` is set. Redaction now also matches the JSON-escaped forms of every credential (including the API key), so a value containing quotes, backslashes, newlines, or non-ASCII characters can't be recovered from a JSON transcript or file.
