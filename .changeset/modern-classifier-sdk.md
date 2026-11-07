---
"@vercel/agent-eval": major
---

Migrate failure classification to AI SDK 7 before AI SDK 5 support is removed from AI Gateway. Remove the unused Anthropic provider dependency and use the SDK's instructions option for the classifier prompt.

This release requires Node.js 22 or later, up from Node.js 18. Upgrade the host runtime before updating Agent Eval; the package remains ESM.
