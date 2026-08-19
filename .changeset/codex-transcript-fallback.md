---
'@vercel/agent-eval': patch
---

Fall back to the saved Codex session transcript when `codex exec --json` does not
echo the full JSONL to stdout. The runner already read the session file under
`~/.codex/sessions` to detect the observed model, but discarded it for result
capture, so those runs recorded no transcript at all. `observedModel` now also
falls back to the stdout transcript when the session file is missing.
