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
import { getAgent, hasAgent } from './agents/index.js';

/**
 * Fields from the config that affect eval results.
 * Functions (setup, editPrompt) can't be hashed — documented as a limitation.
 */
interface FingerprintableConfig {
  agent: string;
  model: string;
  modelPolicy?: string;
  scripts: string[];
  timeout: number;
  earlyExit: boolean;
  runs: number;
  webResearch?: boolean;
  disableBundledSkills?: boolean;
  agentFingerprint?: Record<string, unknown>;
  judge?: { agent?: string; model: string };
}

interface ReuseCompatibilityInput {
  webResearch?: true;
  disableBundledSkills?: true;
  agentFingerprint?: Record<string, unknown>;
}

function agentFingerprintExtra(config: RunnableExperimentConfig): Record<string, unknown> | undefined {
  if (!hasAgent(config.agent)) return undefined;
  return getAgent(config.agent).definition?.fingerprintExtra?.(config);
}

function bundledSkillsIsolationApplies(config: RunnableExperimentConfig): boolean {
  if (!config.disableBundledSkills) return false;
  const agentNames = new Set([config.agent, config.judge?.agent ?? config.agent]);
  for (const agentName of agentNames) {
    if (!hasAgent(agentName)) return true;
    if (getAgent(agentName).definition?.bundledSkillsControl !== 'not-applicable') return true;
  }
  return false;
}

/** Build the config slice hashed into result-reuse fingerprints. */
export function fingerprintConfigInput(config: RunnableExperimentConfig): FingerprintableConfig {
  const input: FingerprintableConfig = {
    agent: config.agent,
    model: config.model,
    scripts: [...config.scripts].sort(),
    timeout: config.timeout,
    earlyExit: config.earlyExit,
    runs: config.runs,
  };
  if (config.modelPolicy === 'native-default') {
    input.modelPolicy = config.modelPolicy;
  }
  if (config.webResearch) {
    input.webResearch = true;
  }
  if (bundledSkillsIsolationApplies(config)) {
    input.disableBundledSkills = true;
  }
  const agentFingerprint = agentFingerprintExtra(config);
  if (agentFingerprint && Object.keys(agentFingerprint).length > 0) {
    input.agentFingerprint = agentFingerprint;
  }
  if (config.judge) {
    input.judge = { agent: config.judge.agent, model: config.judge.model };
  }
  return input;
}

/**
 * Hash opt-in runtime behavior that must never be silently carried across
 * cached results. Undefined preserves historical default behavior.
 */
export function computeReuseCompatibilityFingerprint(
  config: RunnableExperimentConfig,
): string | undefined {
  const input: ReuseCompatibilityInput = {};
  if (config.webResearch) input.webResearch = true;
  if (bundledSkillsIsolationApplies(config)) input.disableBundledSkills = true;
  const agentFingerprint = agentFingerprintExtra(config);
  if (agentFingerprint && Object.keys(agentFingerprint).length > 0) {
    input.agentFingerprint = agentFingerprint;
  }
  if (Object.keys(input).length === 0) return undefined;
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
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
 * Hash every eval-directory file into the given hash, in deterministic order.
 * Shared by {@link computeContentFingerprint} and {@link computeFingerprint} so
 * the two stay in lockstep — the combined fingerprint's file bytes are byte-for-byte
 * what the content fingerprint hashes, just with config appended.
 */
function hashEvalFiles(hash: ReturnType<typeof createHash>, evalPath: string): void {
  const files = collectFiles(evalPath);
  for (const file of files) {
    hash.update(`file:${file.relativePath}\n`);
    hash.update(file.content);
    hash.update('\0');
  }
}

/**
 * Compute a fingerprint of ONLY the eval's files (no config).
 *
 * This is the "did the eval itself change" signal: it changes when an eval is
 * edited or re-synced with different content, but NOT when a benign config field
 * (e.g. timeout) is bumped. Result reuse/refingerprinting uses it to carry forward
 * config-only changes without ever masking a real eval change. Hex SHA-256.
 */
export function computeContentFingerprint(evalPath: string): string {
  const hash = createHash('sha256');
  hashEvalFiles(hash, evalPath);
  return hash.digest('hex');
}

/**
 * Compute a fingerprint for an (eval, config) pair.
 *
 * Hashes: all eval directory files + config fields that affect results.
 * Returns a hex SHA-256 digest. The file-hashing is identical to
 * {@link computeContentFingerprint}; config is appended after, so this value is
 * byte-for-byte unchanged from before the content/config split (existing cached
 * fingerprints stay valid).
 */
export function computeFingerprint(evalPath: string, config: RunnableExperimentConfig): string {
  const hash = createHash('sha256');

  // Hash all files in the eval directory (sorted for determinism)
  hashEvalFiles(hash, evalPath);

  // Hash config fields that affect results
  const configForHash = fingerprintConfigInput(config);
  hash.update(`config:${JSON.stringify(configForHash)}`);

  return hash.digest('hex');
}

/** What `refingerprint` should do to one cached result's summary. */
export interface RefingerprintDecision {
  /** New combined fingerprint to write, or undefined to leave as-is. */
  fingerprint?: string;
  /** New content fingerprint to write, or undefined to leave as-is. */
  contentFingerprint?: string;
  /** True when the eval content changed and the result was left stale (not re-stamped). */
  stale: boolean;
}

/**
 * Decide how to refingerprint one cached result — the content-aware replacement for
 * the old "re-stamp everything" behavior. The whole point: carry forward benign
 * config changes WITHOUT masking a real eval-content change.
 *
 *   - content unchanged → carry the new combined fingerprint (a config-only change)
 *   - content changed    → leave it stale (don't touch); honest "this eval changed"
 *   - legacy (no stored content fp) → adopt the current content fp only if the result
 *     is already fully current; otherwise leave stale (we can't prove content matches)
 */
export function decideRefingerprint(
  stored: {
    fingerprint?: string;
    contentFingerprint?: string;
    reuseCompatibilityFingerprint?: string;
  },
  current: {
    fingerprint: string;
    contentFingerprint: string;
    reuseCompatibilityFingerprint?: string;
  }
): RefingerprintDecision {
  if (stored.reuseCompatibilityFingerprint !== current.reuseCompatibilityFingerprint) {
    return { stale: true };
  }
  if (stored.contentFingerprint === undefined) {
    if (stored.fingerprint === current.fingerprint) {
      return { contentFingerprint: current.contentFingerprint, stale: false };
    }
    return { stale: true };
  }
  if (stored.contentFingerprint === current.contentFingerprint) {
    if (stored.fingerprint !== current.fingerprint) {
      return { fingerprint: current.fingerprint, stale: false };
    }
    return { stale: false };
  }
  return { stale: true };
}
