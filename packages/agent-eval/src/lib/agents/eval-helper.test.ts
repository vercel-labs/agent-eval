import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Importing the helper registers the matchers on `expect` as a side effect; the
// toContainText suite below relies on that, the rest exercises the pure exports.
import {
  buildJudgePrompt,
  parseJudgeVerdict,
  transcriptPath,
  environment,
  transcript,
} from './eval-helper.mjs';

// The helper ships as plain .mjs (no types), so declare the matcher for this file.
// The type parameter must match vitest's own `Assertion<T = any>` declaration.
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> {
    toContainText(needle: string | RegExp): T;
    toSatisfyCriterion(criterion: string): Promise<T>;
    toScoreAtLeast(criterion: string, threshold: number): Promise<T>;
  }
}

describe('buildJudgePrompt', () => {
  it('environment variant: explores cwd, embeds criterion + verdict path + contract', () => {
    const p = buildJudgePrompt('environment', 'uses Server Components', '__agent_eval__/judge/1-verdict.json');
    expect(p).toContain('Inspect the project in the current directory');
    expect(p).not.toContain('__agent_eval__/transcript.txt');
    expect(p).toContain('Criterion: uses Server Components');
    expect(p).toContain('__agent_eval__/judge/1-verdict.json');
    expect(p).toContain('"pass": true|false');
    expect(p).not.toContain('"score"'); // non-numeric by default
  });

  it('transcript variant: points at the materialized transcript, not cwd exploration', () => {
    const p = buildJudgePrompt('transcript', 'used DevTools', '__agent_eval__/judge/2-verdict.json');
    expect(p).toContain('__agent_eval__/transcript.txt');
    expect(p).not.toContain('Inspect the project in the current directory');
    expect(p).toContain('Criterion: used DevTools');
  });

  it('numeric mode asks for a score and includes it in the contract', () => {
    const p = buildJudgePrompt('environment', 'code quality', 'v.json', { numeric: true });
    expect(p).toContain('score from 0 to 1');
    expect(p).toContain('"score": <0-1>');
  });
});

describe('parseJudgeVerdict', () => {
  it('parses a clean verdict object', () => {
    expect(parseJudgeVerdict('{"pass":true,"reason":"ok"}')).toEqual({
      pass: true,
      score: undefined,
      reason: 'ok',
    });
  });

  it('tolerates prose and ```json fences around the object', () => {
    const raw = 'Here:\n```json\n{"pass":false,"reason":"nope"}\n```\ndone';
    expect(parseJudgeVerdict(raw)).toEqual({ pass: false, score: undefined, reason: 'nope' });
  });

  it('keeps a numeric score', () => {
    expect(parseJudgeVerdict('{"pass":true,"score":0.7,"reason":"good"}')).toEqual({
      pass: true,
      score: 0.7,
      reason: 'good',
    });
  });

  it('coerces a truthy non-boolean pass and a missing reason', () => {
    const v = parseJudgeVerdict('{"pass":"yes"}');
    expect(v?.pass).toBe(true);
    expect(v?.reason).toBe('');
  });

  it('returns null when nothing parseable is present', () => {
    expect(parseJudgeVerdict('no json here')).toBeNull();
    expect(parseJudgeVerdict(undefined)).toBeNull();
    expect(parseJudgeVerdict('{ broken "pass": true ')).toBeNull();
  });
});

describe('subjects', () => {
  it('environment and transcript are distinct judge sentinels', () => {
    expect(environment).toEqual({ __judgeSubject: 'environment' });
    expect(transcript).toEqual({ __judgeSubject: 'transcript' });
  });

  it('transcriptPath() returns the canonical materialized path', () => {
    expect(transcriptPath()).toBe('__agent_eval__/transcript.txt');
  });
});

describe('toContainText', () => {
  // The matcher reads the transcript relative to cwd (as it does in-sandbox), so
  // run each test from a temp dir holding a fixture transcript.
  let dir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'eval-helper-test-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(content: string) {
    mkdirSync('__agent_eval__', { recursive: true });
    writeFileSync(transcriptPath(), content);
  }

  it('passes when the transcript contains the substring', () => {
    writeTranscript('the agent then added getServerSideProps to page.tsx');
    expect(transcript).toContainText('getServerSideProps');
  });

  it('.not passes when the transcript does not contain the substring', () => {
    writeTranscript('the agent used a Server Component');
    expect(transcript).not.toContainText('getServerSideProps');
  });

  it('fails with the searched size when the substring is absent', () => {
    writeTranscript('clean');
    expect(() => expect(transcript).toContainText('getServerSideProps')).toThrowError(
      /expected to contain "getServerSideProps" \(searched 5 chars\)/
    );
  });

  it('.not failure cites where the needle appears', () => {
    writeTranscript('line one\nthen getServerSideProps showed up\nline three');
    expect(() => expect(transcript).not.toContainText('getServerSideProps')).toThrowError(
      /expected NOT to contain "getServerSideProps", but found it at char 14: …line one\\nthen getServerSideProps showed up\\nline three…/
    );
  });

  it('throws when the transcript file is missing — even under .not', () => {
    // No vacuous pass: an uncaptured transcript must fail the assertion outright.
    expect(() => expect(transcript).not.toContainText('anything')).toThrowError(
      /transcript at __agent_eval__\/transcript\.txt is missing or empty/
    );
  });

  it('throws when the transcript file is empty — even under .not', () => {
    writeTranscript('');
    expect(() => expect(transcript).not.toContainText('anything')).toThrowError(
      /missing or empty/
    );
  });

  it('throws on a non-transcript subject so .not cannot invert it into a pass', () => {
    expect(() => expect(environment).toContainText('x')).toThrowError(
      /toContainText expects `transcript`/
    );
    expect(() => expect(environment).not.toContainText('x')).toThrowError(
      /toContainText expects `transcript`/
    );
  });

  it('throws on an empty or non-string, non-RegExp needle', () => {
    writeTranscript('content');
    expect(() => expect(transcript).toContainText('')).toThrowError(
      /non-empty string or a RegExp/
    );
    expect(() =>
      expect(transcript).toContainText(42 as unknown as string)
    ).toThrowError(/non-empty string or a RegExp/);
  });

  it('accepts a RegExp needle, e.g. case-insensitive via the i flag', () => {
    writeTranscript('the agent added GetServerSideProps to the page');
    expect(transcript).toContainText(/getserversideprops/i);
    expect(transcript).not.toContainText(/useEffect/i);
  });

  it('regex .not failure cites the ACTUAL matched text, not the pattern', () => {
    writeTranscript('reached for GETSERVERSIDEPROPS here');
    expect(() =>
      expect(transcript).not.toContainText(/getserversideprops/i)
    ).toThrowError(
      /expected NOT to contain \/getserversideprops\/i, but found it at char 12: …reached for GETSERVERSIDEPROPS here…/
    );
  });

  it('is stable across assertions with a g-flagged regex (no lastIndex drift)', () => {
    writeTranscript('x marks the spot');
    const re = /x/g;
    expect(transcript).toContainText(re);
    expect(transcript).toContainText(re);
  });

  it('throws when the regex matches the empty string — the assertion would be vacuous', () => {
    writeTranscript('content');
    expect(() => expect(transcript).toContainText(/z*/)).toThrowError(
      /matches the empty string/
    );
  });
});

describe('judge matchers', () => {
  // runJudge resolves the runner and judge-config relative to cwd, exactly as it
  // does in-sandbox, so run each test from a temp dir holding a fake runner. The
  // fake honors the runner contract's output fallback: verdict JSON on stdout.
  let dir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'eval-helper-judge-'));
    process.chdir(dir);
    mkdirSync('__agent_eval__', { recursive: true });
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFakeRunner(script: string) {
    writeFileSync('fake-runner.mjs', script);
    writeFileSync(
      '__agent_eval__/judge-config.json',
      JSON.stringify({ runnerPath: 'fake-runner.mjs', model: null, extra: null })
    );
  }

  it('resolves a passing verdict through the runner round-trip', async () => {
    writeFakeRunner(
      `process.stdout.write(JSON.stringify({ pass: true, reason: 'fake evidence' }));`
    );
    await expect(environment).toSatisfyCriterion('anything at all');
  });

  it('a failing verdict fails the assertion (and .not inverts it)', async () => {
    writeFakeRunner(
      `process.stdout.write(JSON.stringify({ pass: false, reason: 'nope' }));`
    );
    await expect(expect(environment).toSatisfyCriterion('x')).rejects.toThrow(/reason: nope/);
    await expect(environment).not.toSatisfyCriterion('x');
  });

  it('does not block the event loop while the judge runs', async () => {
    // The regression this guards: the vitest worker's RPC heartbeat shares this
    // event loop, and its per-call timeout is hardcoded to 60s. A judge that
    // blocks the loop past that fails the whole file even when every test passes.
    // A timer firing while the judge is still out is only possible if the loop
    // stays alive — under the old spawnSync implementation this test hangs at
    // 'timer' until the judge returns, and the order assertion fails.
    writeFakeRunner(
      `setTimeout(() => {
        process.stdout.write(JSON.stringify({ pass: true, reason: 'slow ok' }));
      }, 300);`
    );
    const order: string[] = [];
    const judged = expect(environment)
      .toSatisfyCriterion('slow criterion')
      .then(() => order.push('judge'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    order.push('timer');
    await judged;
    expect(order).toEqual(['timer', 'judge']);
  });

  it('toScoreAtLeast compares the numeric score', async () => {
    writeFakeRunner(
      `process.stdout.write(JSON.stringify({ pass: true, score: 0.7, reason: 'ok' }));`
    );
    await expect(environment).toScoreAtLeast('quality', 0.6);
    await expect(environment).not.toScoreAtLeast('quality', 0.8);
  });
});
