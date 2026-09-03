---
"@vercel/agent-eval": patch
---

Fix Cursor CLI Docker setup: `node:*-slim` has no `curl`, so `curl https://cursor.com/install | bash` failed with `curl: command not found`, and even after a successful install `spawnSync agent` missed `~/.local/bin`. Sandbox setup now installs `curl` (and fails if apt does), sets HOME to the `node` user home, puts `~/.local/bin` on PATH, and the Cursor runner resolves the installer symlink directly.
