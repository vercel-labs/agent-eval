---
"@vercel/agent-eval": minor
---

Add opt-in `--concurrency <n>` to cap active eval attempts across all experiments and models in a command. Library users can share a `ConcurrencyLimiter` across `runExperiment()` calls. Attempts retain their slots through retries and sandbox cleanup; queue time does not count against the eval timeout. Cleanup failure or a 60-second cleanup deadline cancels the capped run without admitting more work. Custom agents receive `requireCleanup` and can report uncertain cleanup with the exported `SandboxCleanupError`. Existing best-effort cleanup error handling is retained without a cap.

Also fix `StartRateLimiter` stalling callers that arrive after a window fills exactly, which can prevent later models or queued attempts from starting.
