---
"@vercel/agent-eval": patch
---

Reconnect on terminated HTTP streams in `SandboxManager.runCommand`/`runShell` so in-sandbox commands exceeding ~5 min don't fail spuriously with `error: "terminated"`.
