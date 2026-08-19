/**
 * Build step: copy the in-sandbox `.mjs` artifacts into the compiled output:
 *   - each agent's runner   `src/lib/agents/<agent>/run.mjs` → `dist/lib/agents/<agent>/run.mjs`
 *   - the eval helper       `src/lib/agents/eval-helper.mjs` → `dist/lib/agents/eval-helper.mjs`
 *   - its hand-written types `src/lib/agents/eval-helper.d.mts` → `dist/lib/agents/eval-helper.d.mts`
 *
 * `tsc` only emits .ts → .js; these `.mjs` files are plain JS artifacts that ship
 * as-is and get read at runtime via `new URL(..., import.meta.url)` next to the
 * compiled code. So they must sit beside the compiled output in dist.
 */

import { readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'src/lib/agents';
const OUT = 'dist/lib/agents';

let copied = 0;
for (const entry of readdirSync(SRC, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const runner = join(SRC, entry.name, 'run.mjs');
  if (!existsSync(runner)) continue;
  const destDir = join(OUT, entry.name);
  mkdirSync(destDir, { recursive: true });
  copyFileSync(runner, join(destDir, 'run.mjs'));
  copied++;
}

// The in-sandbox eval helper (shipped by the orchestrator before validation).
mkdirSync(OUT, { recursive: true });
copyFileSync(join(SRC, 'eval-helper.mjs'), join(OUT, 'eval-helper.mjs'));
copied++;

// Its hand-authored types. `tsc` does not emit input .d.mts files to outDir, so
// without this copy the `./eval` subpath export in package.json points at a file
// that never reaches dist or the published tarball, and consumers get no types.
copyFileSync(join(SRC, 'eval-helper.d.mts'), join(OUT, 'eval-helper.d.mts'));
copied++;

console.log(`copy-runners: copied ${copied} file(s) into ${OUT}`);
