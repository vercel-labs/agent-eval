---
'@vercel/agent-eval': patch
---

Record renamed files in the agent's captured changes. `git diff` detects renames by default and reported a moved file as a single entry that the capture couldn't read, so the old path was never marked deleted and the new file's content was dropped from `copyFiles`. Renames are now captured as a deletion plus an added file. Paths containing quotes, backslashes, or non-ASCII characters, which git used to escape in its output, are now captured verbatim instead of being skipped.
