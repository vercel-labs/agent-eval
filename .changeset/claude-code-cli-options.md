---
'@vercel/agent-eval': minor
---

Add `cliPackage` and `effort` `agentOptions` for Claude Code. Lets users override the installed npm package (e.g. `@anthropic-ai/claude-code@next`) and pass `--effort <level>`, which is required by models that use the new `thinking.type.adaptive` API such as Opus 4.7.
