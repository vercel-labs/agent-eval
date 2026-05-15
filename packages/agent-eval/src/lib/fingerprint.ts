/**
 * Content fingerprinting for eval result reuse.
 *
 * A fingerprint captures the eval files + config fields that affect results.
 * If the fingerprint matches and the result is valid, the eval can be skipped.
 */

import { createHash } from 'crypto';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { RunnableExperimentConfig } from './types.js';

/**
 * Fields from the config that affect eval results.
 * Functions (setup, editPrompt) can't be hashed — documented as a limitation.
 */
interface FingerprintableConfig {
  agent: string;
  model: string;
  scripts: string[];
  timeout: number;
  maxTurns?: number;
  earlyExit: boolean;
  runs: number;
}

/**
 * Recursively collects all files in a directory, sorted for deterministic hashing.
 * Skips node_modules and .git.
 */
function collectFiles(dir: string, basePath: string = ''): Array<{ relativePath: string; content: string }> {
  const files: Array<{ relativePath: string; content: string }> = [];
  const entries = readdirSync(dir).sort();

  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const fullPath = join(dir, entry);
    const relativePath = basePath ? `${basePath}/${entry}` : entry;
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...collectFiles(fullPath, relativePath));
    } else {
      files.push({ relativePath, content: readFileSync(fullPath, 'utf-8') });
    }
  }

  return files;
}

/**
 * Compute a fingerprint for an (eval, config) pair.
 *
 * Hashes: all eval directory files + config fields that affect results.
 * Returns a hex SHA-256 digest.
 */
export function computeFingerprint(evalPath: string, config: RunnableExperimentConfig): string {
  const hash = createHash('sha256');

  // Hash all files in the eval directory (sorted for determinism)
  const files = collectFiles(evalPath);
  for (const file of files) {
    hash.update(`file:${file.relativePath}\n`);
    hash.update(file.content);
    hash.update('\0');
  }

  // Hash config fields that affect results
  const configForHash: FingerprintableConfig = {
    agent: config.agent,
    model: config.model,
    scripts: [...config.scripts].sort(),
    timeout: config.timeout,
    maxTurns: config.maxTurns,
    earlyExit: config.earlyExit,
    runs: config.runs,
  };
  hash.update(`config:${JSON.stringify(configForHash)}`);

  return hash.digest('hex');
}
