---
'@vercel/agent-eval': minor
---

Ship public types for the `@vercel/agent-eval/eval` judge surface. Importing `environment`/`transcript` now also augments Vitest's `expect` with the `toSatisfyCriterion` and `toScoreAtLeast` matchers — EVAL.ts files type-check with no manual `declare module 'vitest'` boilerplate. The `eval` subpath is now a real package export (resolvable in editors, not just the in-sandbox alias), and `JudgeSubject` / `JudgeVerdict` types are exported for advanced use.
