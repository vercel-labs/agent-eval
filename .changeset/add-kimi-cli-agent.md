---
"@vercel/agent-eval": minor
---

Add Kimi CLI agent harness. Supports two variants: `vercel-ai-gateway/kimi` (routes through the Vercel AI Gateway's OpenAI-compatible endpoint — no Moonshot account required) and `kimi` (direct Moonshot API via `MOONSHOT_API_KEY`). The sandbox installs Kimi CLI via `uv tool install kimi-cli` and runs it in `--print --output-format stream-json` mode, with a transcript parser that normalizes Kimi's OpenAI-style JSONL to the common o11y schema.
