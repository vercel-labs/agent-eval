---
'@vercel/agent-eval': patch
---

Parse saved transcripts with the parser the agent definition names. `saveResults` looked up the parser by the experiment's agent ID, which names no parser for a registered custom agent, so a custom agent with `o11yAgentName: 'claude-code'` got a `transcript.json` with no events and an empty `o11y` summary in `result.json`, even though EVAL.ts and token usage already used the definition's parser. The saved transcript keeps the experiment's agent ID as its `agent`.
