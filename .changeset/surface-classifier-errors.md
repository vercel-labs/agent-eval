---
"@vercel/agent-eval": patch
---

Surface AI Gateway errors during classification instead of swallowing them. `classifyWithAI` and `classifyFailure` now throw on gateway/network failures, and `runAllCommand` collects per-eval classifier errors and prints them at the end of the classify phase. Previously a 402 (insufficient funds), network blip, or any other gateway error would silently leave failures with no `classification.json`, which the cache reuse path then refuses to reuse — causing those evals to re-run on every subsequent invocation.
