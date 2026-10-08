---
'@vercel/agent-eval': patch
---

Bound the provenance version command. It runs once per run after install, and a CLI whose `--version` hung (on an update check or a prompt, say) would have held every run until its timeout failed it. The command now gets 30 seconds, configurable with `timeoutMs` on the `versionCommand` result, after which it is abandoned, killed in the sandbox where coreutils `timeout` is available, and `agentCliVersion` is left unset. The run carries on either way.
