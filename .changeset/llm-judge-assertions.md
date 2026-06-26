---
'@vercel/agent-eval': minor
---

Add LLM-as-judge assertions for `EVAL.ts`. You can now grade qualitative criteria that deterministic checks can't express:

```ts
import { transcript, diff } from './__agent_eval__/judge.mjs';

await expect(transcript()).toSatisfyCriterion('Used React DevTools to diagnose, not guesswork');
await expect(diff()).toSatisfyCriterion('Added Suspense boundaries; did not use force-dynamic');
```

`toSatisfyCriterion` is a normal async vitest matcher, so a failed verdict is just a failed test — it rides the existing pass-rate, result reuse, and dashboard. The judge runs inside the sandbox (zero added fixture deps), calls the AI Gateway with the credential the harness already forwards, and uses a judge model independent of the model under test (override via `AGENT_EVAL_JUDGE_MODEL`). The full normalized transcript is now also exposed to `EVAL.ts` for evidence.
