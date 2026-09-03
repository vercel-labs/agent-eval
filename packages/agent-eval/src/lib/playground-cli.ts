import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/**
 * Resolve the playground HTTP port.
 * `--port` wins, then `PORT`, then 3000. Empty values are skipped so
 * `PORT= npx @vercel/agent-eval playground` still starts.
 */
export function resolvePlaygroundPort(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  for (const candidate of [explicit, env.PORT, '3000']) {
    const raw = candidate?.toString().trim();
    if (raw) {
      return raw;
    }
  }
  return '3000';
}

/**
 * Prefer a playground checkout next to this package (monorepo / `file:` install)
 * when `next` is resolvable there. Otherwise use an installed playground
 * package. Returns null so the CLI can fall back to `npx`.
 *
 * `fromDir` is the directory of the compiled/source CLI file
 * (`dist/` or `src/`).
 */
export function resolvePlaygroundBin(fromDir: string): string | null {
  const candidates = [
    resolve(fromDir, '../../playground/bin.mjs'),
    resolvePlaygroundPackageBin(fromDir),
    resolvePlaygroundPackageBin(process.cwd()),
  ];

  for (const bin of candidates) {
    if (bin && existsSync(bin) && playgroundHasNext(bin)) {
      return bin;
    }
  }
  return null;
}

function resolvePlaygroundPackageBin(fromDir: string): string | null {
  try {
    const require = createRequire(resolve(fromDir, 'index.js'));
    const pkg = require.resolve('@vercel/agent-eval-playground/package.json');
    return resolve(dirname(pkg), 'bin.mjs');
  } catch {
    return null;
  }
}

function playgroundHasNext(binPath: string): boolean {
  try {
    createRequire(binPath).resolve('next/package.json');
    return true;
  } catch {
    return false;
  }
}
