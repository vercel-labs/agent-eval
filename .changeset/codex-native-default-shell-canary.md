---
'@vercel/agent-eval': patch
---

Verify and repair the shell tool for native-default Codex runs. Codex CLI >= 0.144.0 (published 2026-07-09) exposes no shell/exec tool to the model when config.toml uses a custom `model_provider` (e.g. the AI Gateway) and omits the `model` key — exactly what native-default runs write. The model still answers, but it cannot run commands, read files, or use installed skills, and it sometimes fabricates command output instead of reporting the missing tool. run.mjs now pre-verifies native-default runs with a fabrication-proof shell canary (a `command_execution` item must carry a random nonce), repairs by re-stating the CLI's own resolved default model as an explicit top-level `model` key in the profile config, re-verifies, and fails loudly if the tool is still unavailable. The repair is surfaced as an optional `modelRepair` field on `RunnerResult`.
