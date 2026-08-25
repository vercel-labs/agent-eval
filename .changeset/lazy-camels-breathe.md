---
"@vercel/agent-eval": patch
---

Judge matchers no longer block the vitest worker. `toSatisfyCriterion` and `toScoreAtLeast` ran the in-sandbox judge agent with `spawnSync`, freezing the worker's event loop for the length of a model run. The worker answers the main process over an RPC channel whose per-call timeout is hardcoded to 60 seconds (birpc's default — no vitest option or env var reaches it), so any judge slower than that made vitest emit an unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` and exit non-zero even when every assertion passed: a green eval recorded as a failure, and the slower the judge model, the more often. The judge now runs via async `spawn` and the matchers are async, so the event loop keeps servicing the RPC channel while the judge works. Judge calls must be awaited — `await expect(environment).toSatisfyCriterion(...)` — which is what every published example already shows.
