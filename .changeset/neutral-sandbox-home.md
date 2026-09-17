---
"@vercel/agent-eval": patch
---

Neutralise the home directory on Vercel sandboxes. The default account there is `vercel-sandbox` (`HOME=/home/vercel-sandbox`, `MAIL=/var/spool/mail/vercel-sandbox`), which every agent CLI can observe through `homedir()` and `~`. `prepareNeutralWorkspace` now seeds `/home/user` from the original home and returns `HOME`/`MAIL` alongside the existing `USER`/`LOGNAME` overrides, and the orchestrator applies that env to install and config-file steps too, so `~/.codex`, `~/.claude`, global CLI installs, the runner, and judge validation all resolve the same home. Docker and other non-Vercel sandboxes are unchanged.
