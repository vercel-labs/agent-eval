---
'@vercel/agent-eval': patch
---

Run the eval file without loading the workspace `tsconfig.json`, so a tsconfig that references deleted generated files (like Nuxt's `.nuxt/tsconfig.*.json`) no longer stops validation before any test runs.
