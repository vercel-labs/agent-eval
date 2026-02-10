/**
 * Housekeeping for eval results.
 *
 * After experiments complete, consolidate results:
 * - For each (experiment, eval) pair: keep only the latest valid result
 * - Remove older duplicates and dangling/incomplete results
 * - Remove empty timestamp directories
 */

import { readdirSync, rmSync, existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { isNonModelFailure } from './classifier.js';

interface HousekeepingStats {
  removedDuplicates: number;
  removedIncomplete: number;
  removedNonModelFailures: number;
  removedEmptyDirs: number;
}

/**
 * Run housekeeping on a single experiment's results directory.
 *
 * For each eval: keeps the newest complete result (has summary.json and
 * at least one transcript), removes older duplicates and incomplete results.
 * Removes empty timestamp directories afterward.
 */
export function housekeep(
  resultsDir: string,
  experimentName: string,
  options?: { dry?: boolean }
): HousekeepingStats {
  const stats: HousekeepingStats = {
    removedDuplicates: 0,
    removedIncomplete: 0,
    removedNonModelFailures: 0,
    removedEmptyDirs: 0,
  };

  const experimentDir = join(resultsDir, experimentName);
  if (!existsSync(experimentDir)) return stats;

  // Get all timestamps sorted newest first
  let timestamps: string[];
  try {
    timestamps = readdirSync(experimentDir)
      .filter((t) => !t.startsWith('.'))
      .filter((t) => {
        try {
          return statSync(join(experimentDir, t)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse();
  } catch {
    return stats;
  }

  // Track which (eval, fingerprint) pairs we've already seen (newest wins).
  // Results with different fingerprints (e.g. smoke vs full run) are not
  // duplicates of each other and should coexist.
  const seenEvals = new Set<string>();

  for (const timestamp of timestamps) {
    const tsDir = join(experimentDir, timestamp);

    let evalDirs: string[];
    try {
      evalDirs = readdirSync(tsDir).filter((d) => !d.startsWith('.'));
    } catch {
      continue;
    }

    for (const evalDir of evalDirs) {
      const evalResultDir = join(tsDir, evalDir);

      if (!statSync(evalResultDir).isDirectory()) continue;

      // Read fingerprint to distinguish different configs (e.g. smoke vs full)
      const fingerprint = readFingerprint(evalResultDir);
      const dedupeKey = fingerprint ? `${evalDir}:${fingerprint}` : evalDir;

      if (seenEvals.has(dedupeKey)) {
        // Older duplicate with same fingerprint — remove
        if (!options?.dry) {
          rmSync(evalResultDir, { recursive: true });
        }
        stats.removedDuplicates++;
        continue;
      }

      // Check if this result is complete (smoke and non-model failures are always cleaned up)
      if (isComplete(evalResultDir) && !isSmoke(evalResultDir) && !isNonModelFailure(evalResultDir)) {
        seenEvals.add(dedupeKey);
      } else if (isNonModelFailure(evalResultDir)) {
        if (!options?.dry) {
          rmSync(evalResultDir, { recursive: true });
        }
        stats.removedNonModelFailures++;
      } else {
        // Incomplete or smoke — remove
        if (!options?.dry) {
          rmSync(evalResultDir, { recursive: true });
        }
        stats.removedIncomplete++;
      }
    }

    // Check if timestamp dir is now empty
    try {
      const remaining = readdirSync(tsDir).filter((d) => !d.startsWith('.'));
      if (remaining.length === 0) {
        if (!options?.dry) {
          rmSync(tsDir, { recursive: true });
        }
        stats.removedEmptyDirs++;
      }
    } catch {
      // Directory already removed or inaccessible
    }
  }

  return stats;
}

/**
 * Check if an eval result is from a smoke test.
 */
function isSmoke(evalResultDir: string): boolean {
  try {
    const summary = JSON.parse(readFileSync(join(evalResultDir, 'summary.json'), 'utf-8'));
    return summary.smoke === true;
  } catch {
    return false;
  }
}

/**
 * Read the fingerprint from an eval result's summary.json, if present.
 */
function readFingerprint(evalResultDir: string): string | undefined {
  try {
    const summary = JSON.parse(readFileSync(join(evalResultDir, 'summary.json'), 'utf-8'));
    return summary.fingerprint;
  } catch {
    return undefined;
  }
}

/**
 * Check if an eval result directory is complete.
 * Complete means: has summary.json and at least one run with a transcript.
 */
function isComplete(evalResultDir: string): boolean {
  const summaryPath = join(evalResultDir, 'summary.json');
  if (!existsSync(summaryPath)) return false;

  // Check for at least one transcript
  try {
    const entries = readdirSync(evalResultDir);
    for (const entry of entries) {
      if (!entry.startsWith('run-')) continue;
      const runDir = join(evalResultDir, entry);
      if (
        existsSync(join(runDir, 'transcript-raw.jsonl')) ||
        existsSync(join(runDir, 'transcript.json'))
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }

  // No transcript found — but summary.json exists.
  // Still consider complete if summary shows 0% (model produced nothing, which is valid).
  try {
    const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
    return summary.totalRuns > 0;
  } catch {
    return false;
  }
}
