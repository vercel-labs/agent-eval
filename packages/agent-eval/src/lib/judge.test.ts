import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { buildJudgePrompt, parseJudgeVerdict, judge, isFixtureExcluded } from './judge.js';

describe('buildJudgePrompt', () => {
  it('includes codebase + transcript instructions and lists criteria', () => {
    const p = buildJudgePrompt(['greet() is exported', 'uses next/link'], {
      hasCodebase: true,
      hasTranscript: true,
    });
    expect(p).toContain('Inspect the project in the current directory');
    expect(p).toContain('__judge__/transcript.md');
    expect(p).toContain('1. greet() is exported');
    expect(p).toContain('2. uses next/link');
    expect(p).toContain('__judge__/verdict.json');
    expect(p).toContain('"results"');
  });

  it('omits the codebase instruction when there is no codebase', () => {
    const p = buildJudgePrompt(['x'], { hasCodebase: false, hasTranscript: true });
    expect(p).not.toContain('Inspect the project in the current directory');
    expect(p).toContain("transcript");
  });

  it('omits the transcript instruction when there is no transcript', () => {
    const p = buildJudgePrompt(['x'], { hasCodebase: true, hasTranscript: false });
    expect(p).not.toContain('__judge__/transcript.md');
  });
});

describe('parseJudgeVerdict', () => {
  const criteria = ['c1', 'c2'];

  it('parses a clean results object', () => {
    const raw = JSON.stringify({
      results: [
        { criterion: 'c1', pass: true, reason: 'ok' },
        { criterion: 'c2', pass: false, reason: 'nope' },
      ],
    });
    expect(parseJudgeVerdict(raw, criteria)).toEqual([
      { criterion: 'c1', pass: true, reason: 'ok' },
      { criterion: 'c2', pass: false, reason: 'nope' },
    ]);
  });

  it('tolerates prose and ```json fences around the object', () => {
    const raw = 'Here is my verdict:\n```json\n{"results":[{"criterion":"c1","pass":true,"reason":"good"}]}\n```\nDone.';
    expect(parseJudgeVerdict(raw, ['c1'])).toEqual([{ criterion: 'c1', pass: true, reason: 'good' }]);
  });

  it('backfills the criterion text from the input when the model omits it', () => {
    const raw = '{"results":[{"pass":true,"reason":"r1"},{"pass":false,"reason":"r2"}]}';
    const out = parseJudgeVerdict(raw, criteria);
    expect(out[0].criterion).toBe('c1');
    expect(out[1].criterion).toBe('c2');
  });

  it('coerces pass to a boolean', () => {
    const raw = '{"results":[{"criterion":"c1","pass":"yes","reason":"r"}]}';
    expect(parseJudgeVerdict(raw, ['c1'])[0].pass).toBe(true);
  });

  it('throws when there is no parseable verdict', () => {
    expect(() => parseJudgeVerdict('no json here', criteria)).toThrow(/could not parse/);
    expect(() => parseJudgeVerdict(undefined, criteria)).toThrow(/could not parse/);
  });
});

describe('isFixtureExcluded', () => {
  it('excludes node_modules and .git trees (whole-segment match)', () => {
    expect(isFixtureExcluded(join('node_modules', 'react', 'index.js'))).toBe(true);
    expect(isFixtureExcluded(join('.git', 'HEAD'))).toBe(true);
    expect(isFixtureExcluded('node_modules')).toBe(true);
    expect(isFixtureExcluded('.git')).toBe(true);
  });

  it('KEEPS .github / .gitignore / sources (no loose substring match)', () => {
    expect(isFixtureExcluded(join('.github', 'workflows', 'ci.yml'))).toBe(false);
    expect(isFixtureExcluded('.gitignore')).toBe(false);
    expect(isFixtureExcluded('.gitattributes')).toBe(false);
    expect(isFixtureExcluded(join('src', 'index.ts'))).toBe(false);
    expect(isFixtureExcluded('')).toBe(false); // the codebase root itself
  });
});

describe('judge (input validation, no sandbox)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env = { ...saved };
  });
  afterEach(() => {
    process.env = saved;
  });

  it('requires at least one criterion', async () => {
    await expect(judge({ criteria: [], transcript: 't' })).rejects.toThrow(/at least one criterion/);
  });

  it('requires a codebase or a transcript', async () => {
    await expect(judge({ criteria: 'c' })).rejects.toThrow(/codebase.*or.*transcript|provide a/);
  });

  it('requires an API key (no sandbox is created before this check)', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    await expect(judge({ criteria: 'c', transcript: 't' })).rejects.toThrow(/no API key.*AI_GATEWAY_API_KEY/);
  });
});
