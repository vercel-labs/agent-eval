---
"@vercel/agent-eval": patch
---

Fix Cursor CLI `spawnSync agent ENOENT` on the Docker sandbox. The official installer writes `~/.local/bin/agent` and exits 0 without putting that directory on PATH; Docker exec also overwrote PATH with a root-oriented list that omitted `~/.local/bin` and left HOME as `/root`. Sandbox-user execs now set HOME to the `node` user home and include `~/.local/bin` on PATH, and the Cursor runner resolves the installer symlink directly.
