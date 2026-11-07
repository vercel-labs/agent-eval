/**
 * Housekeeping for eval results.
 *
 * After experiments complete, consolidate results:
 * - For each (experiment, eval) pair: keep only the latest valid result
 * - Remove older duplicates and dangling/incomplete results
 * - Prune group and timestamp directories left empty by those removals
 */

import { readdirSync, rmSync, existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { isClassifierEnabled, isNonModelFailure } from './classifier.js';
import { findEvalResultDirs, isRunDirName } from './results.js';

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
 * Group and timestamp directories left empty by those removals are then pruned;
 * results that were kept are never modified.
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

    const evalDirs = findEvalResultDirs(tsDir);

    // Group directories that a removal below may have left empty.
    const orphanedGroups = new Set<string>();

    for (const evalDir of evalDirs) {
      const evalResultDir = join(tsDir, evalDir);

      // Read fingerprint to distinguish different configs (e.g. smoke vs full)
      const fingerprint = readFingerprint(evalResultDir);
      const dedupeKey = fingerprint ? `${evalDir}:${fingerprint}` : evalDir;

      if (seenEvals.has(dedupeKey)) {
        // Older duplicate with same fingerprint — remove
        if (!options?.dry) {
          rmSync(evalResultDir, { recursive: true });
        }
        markGroupsOrphaned(evalDir, orphanedGroups);
        stats.removedDuplicates++;
        continue;
      }

      // Check if this result is complete
      // Note: non-model failures are only cleaned up if the classifier is enabled
      const isNonModel = isClassifierEnabled() && isNonModelFailure(evalResultDir);
      if (isComplete(evalResultDir) && !isSmoke(evalResultDir) && !isNonModel) {
        seenEvals.add(dedupeKey);
      } else if (isNonModel) {
        if (!options?.dry) {
          rmSync(evalResultDir, { recursive: true });
        }
        markGroupsOrphaned(evalDir, orphanedGroups);
        stats.removedNonModelFailures++;
      } else {
        // Incomplete or smoke — remove
        if (!options?.dry) {
          rmSync(evalResultDir, { recursive: true });
        }
        markGroupsOrphaned(evalDir, orphanedGroups);
        stats.removedIncomplete++;
      }
    }

    // Prune group directories the removals above emptied, deepest first, then
    // the timestamp directory itself. Only ancestors of something we deleted are
    // considered — results we chose to keep are never walked into.
    const deepestFirst = [...orphanedGroups].sort(
      (a, b) => b.split('/').length - a.split('/').length
    );
    for (const group of deepestFirst) {
      if (removeIfEmpty(join(tsDir, group), options?.dry)) stats.removedEmptyDirs++;
    }
    if (removeIfEmpty(tsDir, options?.dry)) stats.removedEmptyDirs++;
  }

  return stats;
}

/**
 * OS metadata files that should not keep an otherwise-empty directory alive.
 * Deliberately an allowlist: any other dotfile (.gitignore, .github/, .env) is
 * real content and must not be swept away with the directory holding it.
 */
const IGNORABLE_ENTRIES = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * Record every group directory between `evalDir` and the timestamp root, so the
 * ones a removal just emptied can be pruned.
 */
function markGroupsOrphaned(evalDir: string, orphaned: Set<string>): void {
  const segments = evalDir.split('/');
  segments.pop();
  while (segments.length > 0) {
    orphaned.add(segments.join('/'));
    segments.pop();
  }
}

/**
 * Remove `dir` if it holds nothing but OS metadata. Returns whether it went.
 *
 * A directory that cannot be read is left alone: never delete contents that
 * were never inspected.
 */
function removeIfEmpty(dir: string, dry = false): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.some((e) => !IGNORABLE_ENTRIES.has(e))) return false;
  if (!dry) {
    try {
      rmSync(dir, { recursive: true });
    } catch {
      return false;
    }
  }
  return true;
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
      if (!isRunDirName(entry)) continue;
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
