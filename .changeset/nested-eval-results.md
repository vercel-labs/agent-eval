---
'@vercel/agent-eval': patch
---

Fix housekeeping and result reuse for nested eval directories

Results for nested evals (e.g. `caching/cache-bypass`) are now discovered at any
depth, so they are deduplicated, reused, and cleaned up under their full name
instead of being skipped. Group directories are pruned only once every eval
beneath them is gone, and results that housekeeping keeps are no longer walked
into or modified.
