---
'@vercel/agent-eval': patch
---

Support `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code agent authentication. When set, the OAuth token is used instead of `ANTHROPIC_API_KEY`, enabling Claude Pro/Max subscription users to run evals without a separate API key.
