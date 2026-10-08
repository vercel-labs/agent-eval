---
'@vercel/agent-eval': minor
---

Add reporters, a first-class way to send results somewhere besides the local `results/` tree. Set `reporters` on `ExperimentConfig` (or pass them to `runExperiment()`) with objects that implement `onRunComplete`, called once per finished run after the experiment's own `onRunComplete` hook, and `onExperimentComplete`, called after results are saved and, in the CLI, after failure classification, with the `reused` evals and the `classifications` included. Reporter errors are caught, logged, and listed in the CLI output, and never change eval results. Payloads go through the same credential redaction as results. Two reporters are built in: `jsonlReporter({ path })` appends one line per run, and `httpReporter({ url, headers })` POSTs each event as JSON with a small retry. Reporters are not part of the result-reuse fingerprint.
