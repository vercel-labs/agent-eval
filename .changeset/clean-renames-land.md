---
'@vercel/agent-eval': patch
---

Record renamed files in the agent's captured changes. `git diff` detects renames by default and reported a moved file as a single entry that the capture couldn't read, so the old path was never marked deleted and the new file's content was dropped from `copyFiles`. Renames are now captured as a deletion plus an added file. Paths containing quotes, backslashes, or non-ASCII characters, which git used to escape in its output, are now captured verbatim instead of being skipped.

Captured paths are now validated before they are used. The capture runs git inside the agent's sandbox, where an agent can replace `git`, so a path that isn't a canonical workspace path (absolute, containing `.` or `..` segments, or inside a `.git` directory) is dropped. This also guards `copyFiles`, which previously joined captured paths onto the results directory and could be made to write or delete files outside it on the machine running the eval.
