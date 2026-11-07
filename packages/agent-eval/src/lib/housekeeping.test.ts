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
    // Enable classifier for tests that expect non-model failures to be cleaned up
    process.env.AI_GATEWAY_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    // Clean up env var
    delete process.env.AI_GATEWAY_API_KEY;
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

  it('keeps non-model failures when classifier is disabled', () => {
    const evalDir = join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'eval-1');
    createResult(evalDir, { passedRuns: 0 });
    writeFileSync(
      join(evalDir, 'classification.json'),
      JSON.stringify({ failureType: 'infra', failureReason: 'API error' })
    );

    // Disable classifier by removing env var
    delete process.env.AI_GATEWAY_API_KEY;

    const stats = housekeep(TEST_DIR, 'exp');

    // Non-model failures should NOT be removed when classifier is disabled
    expect(stats.removedNonModelFailures).toBe(0);
    expect(existsSync(evalDir)).toBe(true);
  });

  it('handles nested eval directories without deleting parent groups', () => {
    // Newer timestamp with two nested evals under 'caching'
    createResult(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'caching', 'cache-bypass'), {});
    createResult(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'caching', 'cached-handler'), {});

    // Older timestamp with duplicate
    createResult(join(TEST_DIR, 'exp', '2024-01-25T12-00-00.000Z', 'caching', 'cache-bypass'), {});

    const stats = housekeep(TEST_DIR, 'exp');

    expect(stats.removedDuplicates).toBe(1);
    expect(stats.removedIncomplete).toBe(0);

    // Newer results should exist
    expect(existsSync(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'caching', 'cache-bypass'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'caching', 'cached-handler'))).toBe(true);

    // Older duplicate should be removed
    expect(existsSync(join(TEST_DIR, 'exp', '2024-01-25T12-00-00.000Z', 'caching', 'cache-bypass'))).toBe(false);
    // And empty old timestamp dir should be removed
    expect(existsSync(join(TEST_DIR, 'exp', '2024-01-25T12-00-00.000Z'))).toBe(false);
  });

  it('removes incomplete nested results and cleans up empty parent directories', () => {
    const incompleteDir = join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'group', 'subgroup', 'eval-1');
    mkdirSync(incompleteDir, { recursive: true });
    // Write run-1 without summary.json (crashed/incomplete run)
    mkdirSync(join(incompleteDir, 'run-1'), { recursive: true });

    const stats = housekeep(TEST_DIR, 'exp');

    expect(stats.removedIncomplete).toBe(1);
    // subgroup, group, and the timestamp dir
    expect(stats.removedEmptyDirs).toBe(3);
    expect(existsSync(join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z'))).toBe(false);
  });

  it('leaves kept results untouched, including empty and hidden contents', () => {
    const evalDir = join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z', 'eval-1');
    createResult(evalDir, {});
    // saveResults creates run-N/outputs/ unconditionally, often with nothing in it
    const outputs = join(evalDir, 'run-1', 'outputs');
    mkdirSync(outputs, { recursive: true });
    // A copied fixture whose only contents are dotfiles
    const workflows = join(evalDir, 'run-1', 'project', '.github', 'workflows');
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(workflows, 'ci.yml'), 'name: ci\n');

    const stats = housekeep(TEST_DIR, 'exp');

    expect(stats.removedEmptyDirs).toBe(0);
    expect(existsSync(outputs)).toBe(true);
    expect(existsSync(join(workflows, 'ci.yml'))).toBe(true);
  });

  it('removes crashed eval directories that never got a run dir', () => {
    const tsDir = join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z');
    const crashed = join(tsDir, 'group', 'eval-1');
    mkdirSync(crashed, { recursive: true });
    writeFileSync(join(crashed, 'partial.log'), 'boom\n');

    const stats = housekeep(TEST_DIR, 'exp');

    expect(stats.removedIncomplete).toBe(1);
    expect(existsSync(tsDir)).toBe(false);
  });

  it('does not delete a group directory whose eval is named like a run', () => {
    const tsDir = join(TEST_DIR, 'exp', '2024-01-26T12-00-00.000Z');
    createResult(join(tsDir, 'caching', 'run-1'), {});
    createResult(join(tsDir, 'caching', 'cache-bypass'), {});

    const stats = housekeep(TEST_DIR, 'exp');

    expect(stats.removedIncomplete).toBe(0);
    expect(existsSync(join(tsDir, 'caching', 'run-1', 'summary.json'))).toBe(true);
    expect(existsSync(join(tsDir, 'caching', 'cache-bypass', 'summary.json'))).toBe(true);
  });
});
