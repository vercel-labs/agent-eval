import { existsSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * Discover eval result directories under a timestamp directory.
 *
 * Eval names may contain slashes, so a timestamp can contain nested result
 * directories such as ui/design/layout/summary.json. The returned names are
 * relative to timestampDir and normalized with forward slashes to match eval
 * ids and fingerprint keys.
 */
export function discoverEvalResultDirs(timestampDir: string): string[] {
  const resultDirs: string[] = [];

  function toEvalName(dir: string): string {
    return relative(timestampDir, dir).split(sep).join('/');
  }

  function walk(dir: string): void {
    if (existsSync(join(dir, 'summary.json'))) {
      resultDirs.push(toEvalName(dir));
      return;
    }

    let childDirs: string[];
    try {
      childDirs = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.') && !entry.name.startsWith('run-'))
        .filter((entry) => {
          try {
            return entry.isDirectory() && statSync(join(dir, entry.name)).isDirectory();
          } catch {
            return false;
          }
        })
        .map((entry) => entry.name);
    } catch {
      return;
    }

    if (childDirs.length === 0 && dir !== timestampDir) {
      resultDirs.push(toEvalName(dir));
      return;
    }

    for (const child of childDirs) {
      walk(join(dir, child));
    }
  }

  walk(timestampDir);
  return resultDirs.sort();
}
