/**
 * The version of this package, read from its own package.json. Both
 * `src/lib/version.ts` and the compiled `dist/lib/version.js` sit two levels
 * below the package root.
 */

import { readFileSync } from 'node:fs';

export const AGENT_EVAL_VERSION: string = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
).version;
