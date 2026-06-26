---
'@vercel/agent-eval': minor
---

Add `codebase()` evidence for LLM-judge assertions — the judge explores the workspace itself instead of grading pre-collected evidence:

```ts
import { codebase } from './__agent_eval__/judge.mjs';
await expect(codebase()).toSatisfyCriterion('greet() is exported and returns a non-empty string');
```

It reuses an agent CLI already installed in the sandbox (native exploration), and falls back to a built-in, path-sandboxed tool-loop (`read_file`/`grep`/`list_dir`) — force the loop with `AGENT_EVAL_JUDGE_EXPLORER=fetch`. The generated vitest config now uses a higher `testTimeout` so judge assertions (which call a model, and may run a multi-turn explorer) aren't killed by the 5s default.
