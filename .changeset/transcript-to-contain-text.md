---
'@vercel/agent-eval': minor
---

Add `expect(transcript).toContainText(needle)` — a deterministic, judge-free EVAL.ts matcher over the materialized transcript. Built for `.not` ("the agent never reached for X"): substring absence checks no longer need a judge run or manual `readFileSync(transcriptPath())`. Misuse (wrong subject, empty needle) and a missing/empty transcript throw instead of returning a failed verdict, so `.not` can never invert them into a silent pass.
