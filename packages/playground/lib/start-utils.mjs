import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve the playground HTTP port.
 * `--port`/`-p` wins, then `PORT`, then 3000.
 *
 * @param {string | undefined} explicit
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolvePlaygroundPort(explicit, env = process.env) {
  for (const candidate of [explicit, env.PORT, "3000"]) {
    const raw = candidate?.toString().trim();
    if (raw) {
      return raw;
    }
  }
  return "3000";
}

/**
 * Next.js 16.2.4+ `setupFsCheck` calls `routesManifest.onMatchHeaders.map()`.
 * Playground builds published before that key existed crash at startup with
 * `TypeError: Cannot read properties of undefined (reading 'map')`.
 *
 * @param {string} playgroundRoot
 * @returns {boolean} true when the manifest was rewritten
 */
export function repairRoutesManifest(playgroundRoot) {
  const manifestPath = join(playgroundRoot, ".next", "routes-manifest.json");
  if (!existsSync(manifestPath)) {
    return false;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (Array.isArray(manifest.onMatchHeaders)) {
    return false;
  }

  manifest.onMatchHeaders = [];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return true;
}

/**
 * `next start` needs a production build. A local checkout often has none —
 * fall back to `next dev` so `file:` / monorepo launches still work.
 *
 * @param {string} playgroundRoot
 * @returns {"start" | "dev"}
 */
export function resolveNextCommand(playgroundRoot) {
  return existsSync(join(playgroundRoot, ".next", "BUILD_ID")) ? "start" : "dev";
}
