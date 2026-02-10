import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { housekeep } from './housekeeping.js';

const TEST_DIR = '/tmp/eval-framework-housekeeping-test';

function createResult(
  dir: string,
  opts: { summary?: boolean; transcript?: boolean; passedRuns?: number }
) {
  mkdirSync(dir, { recursive: true });
  if (opts.summary !== false) {
    writeFileSync(
      join(dir, 'summary.json'),
      JSON.stringify({
        totalRuns: 2,
        passedRuns: opts.passedRuns ?? 1,
        passRate: '50%',
        meanDuration: 10,
      })
    );
  }
  if (opts.transcript !== false) {
    const runDir = join(dir, 'run-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'result.json'), JSON.stringify({ status: 'passed', duration: 10 }));
    writeFileSync(join(runDir, 'transcript-raw.jsonl'), '{"role":"assistant"}\n');
  }
}

describe('housekeep', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('keeps newest result and removes older duplicate', () => {
    // Newer timestamp
    createResult(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'eval-1'), {});
    // Older timestamp
    createResult(join(TEST_DIR, 'exp', '2024-01-25T12-00-00.000Z', 'eval-1'), {});

    const stats = housekeep(TEST_DIR, 'exp');

    expect(stats.removedDuplicates).toBe(1);
    expect(existsSync(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'eval-1'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'exp', '2024-01-25T12-00-00.000Z', 'eval-1'))).toBe(false);
  });

  it('removes incomplete results (no summary)', () => {
    createResult(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'eval-1'), {
      summary: false,
    });

    const stats = housekeep(TEST_DIR, 'exp');

    expect(stats.removedIncomplete).toBe(1);
    expect(existsSync(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'eval-1'))).toBe(false);
  });

  it('removes empty timestamp directories', () => {
    // Create a result, then mark it as incomplete so it gets removed
    createResult(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'eval-1'), {
      summary: false,
    });

    const stats = housekeep(TEST_DIR, 'exp');

    expect(stats.removedEmptyDirs).toBe(1);
    expect(existsSync(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z'))).toBe(false);
  });

  it('dry run does not delete anything', () => {
    createResult(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'eval-1'), {});
    createResult(join(TEST_DIR, 'exp', '2024-01-25T12-00-00.000Z', 'eval-1'), {});

    const stats = housekeep(TEST_DIR, 'exp', { dry: true });

    expect(stats.removedDuplicates).toBe(1);
    // Both should still exist
    expect(existsSync(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'eval-1'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'exp', '2024-01-25T12-00-00.000Z', 'eval-1'))).toBe(true);
  });

  it('handles non-existent experiment gracefully', () => {
    const stats = housekeep(TEST_DIR, 'no-such-exp');
    expect(stats.removedDuplicates).toBe(0);
    expect(stats.removedIncomplete).toBe(0);
    expect(stats.removedEmptyDirs).toBe(0);
  });

  it('removes results with infra classification from classification.json', () => {
    const evalDir = join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'eval-1');
    createResult(evalDir, { passedRuns: 0 });
    writeFileSync(
      join(evalDir, 'classification.json'),
      JSON.stringify({ failureType: 'infra', failureReason: 'API error' })
    );

    const stats = housekeep(TEST_DIR, 'exp');

    expect(stats.removedNonModelFailures).toBe(1);
    expect(existsSync(evalDir)).toBe(false);
  });

  it('removes results with timeout classification from classification.json', () => {
    const evalDir = join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'eval-1');
    createResult(evalDir, { passedRuns: 0 });
    writeFileSync(
      join(evalDir, 'classification.json'),
      JSON.stringify({ failureType: 'timeout', failureReason: 'Hit time limit' })
    );

    const stats = housekeep(TEST_DIR, 'exp');

    expect(stats.removedNonModelFailures).toBe(1);
    expect(existsSync(evalDir)).toBe(false);
  });

  it('keeps results with model classification', () => {
    const evalDir = join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'eval-1');
    createResult(evalDir, { passedRuns: 0 });
    writeFileSync(
      join(evalDir, 'classification.json'),
      JSON.stringify({ failureType: 'model', failureReason: 'Incorrect code' })
    );

    const stats = housekeep(TEST_DIR, 'exp');

    expect(stats.removedNonModelFailures).toBe(0);
    expect(existsSync(evalDir)).toBe(true);
  });

  it('keeps results without transcript if summary has totalRuns > 0', () => {
    createResult(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'eval-1'), {
      transcript: false,
      passedRuns: 0,
    });

    const stats = housekeep(TEST_DIR, 'exp');

    // Should be kept (model failure with valid summary)
    expect(stats.removedIncomplete).toBe(0);
    expect(existsSync(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'eval-1'))).toBe(true);
  });
});
