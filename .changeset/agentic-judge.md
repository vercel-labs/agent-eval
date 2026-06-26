---
'@vercel/agent-eval': minor
---

Add `judge()` — an agentic LLM judge built on the plugin model. It runs a real agent as the judge: the agent explores a codebase with its own tools and/or reads a transcript, then returns a structured verdict.

```ts
import { judge } from '@vercel/agent-eval';

const v = await judge({
  criteria: ['greet() is exported and returns a non-empty string', 'imports next/link'],
  codebase: '/path/to/project',   // the judge agent explores it (agentic)
  transcript,                      // and/or judge how the agent worked
});
v.pass;       // true iff every criterion passed
v.results;    // [{ criterion, pass, reason }, ...]
```

A judge is just an agent run, so it reuses the whole plugin orchestrator (sandbox, CLI, agentic tool use) and writes its verdict to a file captured back to the host — working across every supported agent. The judge model is independent of the model under test.
