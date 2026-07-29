---
'@vercel/agent-eval': major
---

Fix silent binary-file corruption when collecting results

Collected project trees were not faithful copies. Two paths decoded every file
as UTF-8, replacing each invalid byte with U+FFFD — silently destroying icons,
images and fonts and inflating them ~1.8x:

- `captureGeneratedFiles` read the agent's diff with `sandbox.readFile`, which
  hands back command stdout (a string).
- `readFixtureFiles` read fixtures with `'utf-8'`, corrupting every binary asset
  a fixture ships when `copyFiles: 'all'` is used.

Both now preserve bytes. `Sandbox` gains `readFileBuffer(path)`, which routes
through `base64` so the existing transport round-trips losslessly, and the
`copyFiles: 'all'` fixture copy uses `copyFileSync` instead of read-then-write —
the bytes never enter the heap, so a whole fixture tree is no longer buffered in
memory.

**Breaking:** `generatedFiles` is now `Record<string, Buffer>` instead of
`Record<string, string>` on both `AgentRunResult` and `EvalRunData`. Code reading
it in an `onRunComplete` hook mostly keeps working at runtime (a `Buffer`
stringifies in template literals, `String(...)` and `JSON.parse(...)`), but
TypeScript consumers that annotate it as `string` need `.toString('utf-8')`.
`readFixtureFiles` likewise returns `Map<string, Buffer>`.
