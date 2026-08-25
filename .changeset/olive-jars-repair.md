---
"@vercel/agent-eval": patch
---

Install vitest before validating when the agent removed it. Validation shells out to `npx vitest` and the generated `vitest.config.ts` imports `vitest/config`, resolved from the workspace — but package.json belongs to the agent for the length of a run. An agent scaffolding into an empty directory often replaces that file outright instead of editing it, its next `npm install` prunes vitest, and npx then downloads vitest into a cache that does not satisfy the config's import. The run dies at startup with `Cannot find package 'vitest'`, which is indistinguishable from a bad result: the eval never executes, yet the harness records a failure for work it never graded. `runValidation` now checks for `node_modules/vitest` first and installs it when missing, with `--no-save` and `--no-package-lock` so neither the manifest nor the lockfile enters the captured diff as if the agent had written it.
