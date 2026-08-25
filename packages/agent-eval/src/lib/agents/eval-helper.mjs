/**
 * In-sandbox eval helper — the EVAL.ts agentic-judge surface.
 *
 * Shipped INTO the sandbox by the orchestrator (like run.mjs) and aliased to
 * `@vercel/agent-eval/eval` + registered as a vitest setup file by the generated
 * vitest config. That lets EVAL.ts do:
 *
 *   import { environment, transcript } from '@vercel/agent-eval/eval';
 *
 *   test('quality', async () => {
 *     await expect(environment).toSatisfyCriterion('uses Server Components for the list');
 *     await expect(transcript).toSatisfyCriterion('diagnosed with DevTools, not guesswork');
 *     await expect(environment).toScoreAtLeast('code quality', 0.8);
 *     expect(transcript).not.toContainText('getServerSideProps'); // deterministic, no judge
 *   });
 *
 * It is AGENTIC and reuses the SAME harness: each assertion re-invokes the codegen
 * agent's runner (`__agent_eval__/run.mjs`, already shipped) IN this sandbox. The
 * judge explores the final state (cwd) or reads the materialized transcript file —
 * no fresh sandbox, no copying evidence around, no new harness. Codex runner
 * re-invocations skip the native-default shell canary via the per-sandbox marker
 * (~/.codex/agent-eval-canary.json, see codex/run.mjs) — only the first
 * invocation pays it.
 *
 * Zero-dependency apart from `vitest` (already present in the fixture). Runs only
 * in-sandbox. The path constants below mirror shared.ts (the orchestrator writes
 * these files before validation).
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { expect } from 'vitest';

// Canonical sandbox paths (kept in sync with shared.ts).
const RUNNER_PATH = '__agent_eval__/run.mjs';
const JUDGE_CONFIG_PATH = '__agent_eval__/judge-config.json';
const TRANSCRIPT_FILE = '__agent_eval__/transcript.txt';
const JUDGE_IO_DIR = '__agent_eval__/judge';

/**
 * The two things you can judge — import sentinels, NOT paths. The matcher routes
 * on which one you pass; the path/cwd resolution is an internal detail.
 */
export const environment = { __judgeSubject: 'environment' };
export const transcript = { __judgeSubject: 'transcript' };

/** Path to the materialized transcript. Rarely needed — prefer the `transcript` subject. */
export function transcriptPath() {
  return TRANSCRIPT_FILE;
}

/**
 * Build the judge prompt for a subject + criterion. Framework-owned: you supply
 * only the criterion; the scaffolding (skeptical stance, how to gather evidence,
 * and the verdict output contract) is fixed so the verdict parses reliably.
 */
export function buildJudgePrompt(subject, criterion, verdictPath, opts = {}) {
  const lines = [];
  lines.push(
    "You are a strict, skeptical judge evaluating an AI coding agent's work. " +
      'Decide the criterion ONLY on clear evidence; when in doubt, FAIL it.'
  );
  lines.push('');
  if (subject === 'transcript') {
    lines.push(
      `Read the agent's transcript at ${TRANSCRIPT_FILE} (open it with your tools) to ` +
        'see how the agent worked. Cite what the transcript actually shows; do not assume.'
    );
  } else {
    lines.push(
      'Inspect the project in the current directory — read files, grep, run commands as ' +
        'needed — to gather concrete evidence.'
    );
  }
  lines.push('');
  lines.push(`Criterion: ${criterion}`);
  lines.push('');
  if (opts.numeric) {
    lines.push(
      'Also give a score from 0 to 1 (1 = fully satisfies the criterion). Set pass=true ' +
        'iff the criterion is satisfied.'
    );
  }
  lines.push(`When done, write your verdict to ${verdictPath} as JSON of exactly this shape:`);
  lines.push(
    '{"pass": true|false,' +
      (opts.numeric ? ' "score": <0-1>,' : '') +
      ' "reason": "<1-2 sentences citing concrete evidence>"}'
  );
  lines.push('Then print that same JSON as your final message.');
  return lines.join('\n');
}

/**
 * Parse a verdict from the verdict file or the agent's final output. Tolerant of
 * surrounding prose / ```json fences. Returns null when nothing parseable is found.
 */
export function parseJudgeVerdict(raw) {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*"pass"[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    return {
      pass: !!obj.pass,
      score: typeof obj.score === 'number' ? obj.score : undefined,
      reason: typeof obj.reason === 'string' ? obj.reason : '',
    };
  } catch {
    return null;
  }
}

/* ───────────────────────────── judge invocation ───────────────────────────── */

let counter = 0;
function nextId() {
  counter += 1;
  return `${process.pid}-${counter}`;
}

function readJudgeConfig() {
  try {
    return JSON.parse(readFileSync(JUDGE_CONFIG_PATH, 'utf8'));
  } catch {
    // No config (e.g. run outside the orchestrator) → reuse the codegen runner and
    // let the agent CLI pick its default model.
    return { runnerPath: RUNNER_PATH, model: null, extra: null };
  }
}

/** spawn + collect, resolving on exit. Never rejects: judge failures become verdicts. */
function spawnCollect(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: process.cwd(), env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => resolve({ stdout, stderr: `${stderr}\n${err.message}`, status: -1 }));
    child.on('close', (status) => resolve({ stdout, stderr, status }));
  });
}

/**
 * Run one agentic judgment IN this sandbox by re-invoking the codegen agent's
 * runner. Async ON PURPOSE, not as style: the vitest worker answers the main
 * process over an RPC channel whose per-call timeout is hardcoded to 60s (birpc's
 * DEFAULT_TIMEOUT — no vitest config or env var reaches it). A judge run takes
 * however long the model takes, routinely past a minute, and the old spawnSync
 * blocked the worker's event loop for all of it, so in-flight calls like
 * onTaskUpdate timed out and vitest failed the file EVEN WHEN EVERY TEST PASSED.
 * Keeping the loop alive while the judge works is the entire fix; the sandbox
 * timeout still bounds the run. Returns {pass, score?, reason}.
 */
async function runJudge(subject, criterion, opts = {}) {
  const id = nextId();
  mkdirSync(JUDGE_IO_DIR, { recursive: true });
  const verdictPath = `${JUDGE_IO_DIR}/${id}-verdict.json`;
  const resultPath = `${JUDGE_IO_DIR}/${id}-result.json`;
  const cfg = readJudgeConfig();

  // Same AgentRunInput contract the runner already understands. The judge model +
  // host-computed extra come from judge-config.json: by default they match the
  // codegen run (self-grade); when the experiment pins a judge, runnerPath points at
  // the pinned agent's judge-run.mjs and model is the pinned model. No secrets here —
  // the key rides in process.env (inherited from the orchestrator's validation env).
  const runnerPath = cfg.runnerPath ?? RUNNER_PATH;
  const input = {
    prompt: buildJudgePrompt(subject, criterion, verdictPath, opts),
    model: cfg.model ?? undefined,
    disableBundledSkills: cfg.disableBundledSkills ?? undefined,
    cwd: process.cwd(),
    resultPath,
    extra: cfg.extra ?? undefined,
  };

  const res = await spawnCollect('node', [runnerPath, JSON.stringify(input)]);

  // Prefer the verdict file the judge agent wrote; then the runner result's output
  // (the agent's final message); then raw stdout.
  let verdict = existsSync(verdictPath) ? parseJudgeVerdict(readFileSync(verdictPath, 'utf8')) : null;
  if (!verdict && existsSync(resultPath)) {
    try {
      const rr = JSON.parse(readFileSync(resultPath, 'utf8'));
      verdict = parseJudgeVerdict(rr.output);
      if (!verdict && !rr.ok) {
        return { pass: false, reason: `judge agent failed: ${rr.error || 'unknown error'}` };
      }
    } catch {
      /* fall through */
    }
  }
  if (!verdict) verdict = parseJudgeVerdict(res.stdout || '');
  if (!verdict) {
    const tail = (res.stdout || res.stderr || '').slice(-300);
    return { pass: false, reason: `could not parse a judge verdict (node exit ${res.status}). Tail: ${tail}` };
  }
  return verdict;
}

function subjectOf(received) {
  return received && typeof received === 'object' ? received.__judgeSubject : undefined;
}

// Async matchers — `await expect(...)`, as every example here shows. The await is
// load-bearing: vitest does not track a custom matcher's promise, so an un-awaited
// judge call floats free of its test — a failing verdict surfaces as an unhandled
// rejection instead of failing the test, and a passing one is never even read.
expect.extend({
  async toSatisfyCriterion(received, criterion) {
    const subject = subjectOf(received);
    if (!subject) {
      return {
        pass: false,
        message: () =>
          'toSatisfyCriterion expects `environment` or `transcript` from @vercel/agent-eval/eval',
      };
    }
    const v = await runJudge(subject, criterion);
    return {
      pass: v.pass,
      message: () =>
        `[judge:${subject}] ${v.pass ? 'PASS' : 'FAIL'}` +
        (typeof v.score === 'number' ? ` (score ${v.score})` : '') +
        ` — ${criterion}\n  reason: ${v.reason}`,
    };
  },

  async toScoreAtLeast(received, criterion, threshold) {
    const subject = subjectOf(received);
    if (!subject) {
      return {
        pass: false,
        message: () =>
          'toScoreAtLeast expects `environment` or `transcript` from @vercel/agent-eval/eval',
      };
    }
    const v = await runJudge(subject, criterion, { numeric: true });
    const score = typeof v.score === 'number' ? v.score : v.pass ? 1 : 0;
    const pass = score >= threshold;
    return {
      pass,
      message: () =>
        `[judge:${subject}] score ${score} ${pass ? '>=' : '<'} ${threshold} — ${criterion}\n  reason: ${v.reason}`,
    };
  },

  /**
   * Deterministic transcript assertion — reads the materialized transcript and
   * checks for an exact substring or a RegExp match (use `/…/i` for
   * case-insensitive). No judge run, so it is free and exact; built for `.not`
   * ("the agent never reached for X"):
   *
   *   expect(transcript).not.toContainText('getServerSideProps');
   *   expect(transcript).not.toContainText(/getserversideprops/i);
   *
   * Misuse and a missing/empty transcript THROW instead of returning pass:false —
   * a returned failure would invert into a silent pass under `.not`, and an
   * uncaptured transcript is an infra failure, not evidence of absence.
   *
   * The transcript is the agent's NATIVE format (e.g. claude-code = raw session
   * JSONL), so text containing quotes/newlines appears JSON-escaped there; stick
   * to identifier-like needles or match the escaped form with a RegExp.
   */
  toContainText(received, needle) {
    if (subjectOf(received) !== 'transcript') {
      throw new Error('toContainText expects `transcript` from @vercel/agent-eval/eval');
    }
    const isRegex = needle instanceof RegExp;
    if (!isRegex && (typeof needle !== 'string' || needle.length === 0)) {
      throw new Error('toContainText expects a non-empty string or a RegExp to search for');
    }
    const text = existsSync(TRANSCRIPT_FILE) ? readFileSync(TRANSCRIPT_FILE, 'utf8') : '';
    if (!text) {
      throw new Error(
        `toContainText: transcript at ${TRANSCRIPT_FILE} is missing or empty — ` +
          'transcript capture failed, so nothing can be asserted about it'
      );
    }
    let idx = -1;
    let matched = '';
    if (isRegex) {
      // Strip g/y so exec always searches from the start, regardless of the
      // needle's lastIndex state or reuse across assertions.
      const re = new RegExp(needle.source, needle.flags.replace(/[gy]/g, ''));
      const m = re.exec(text);
      if (m) {
        if (m[0] === '') {
          throw new Error(
            `toContainText: ${String(needle)} matches the empty string, which would make the assertion vacuous`
          );
        }
        idx = m.index;
        matched = m[0];
      }
    } else {
      idx = text.indexOf(needle);
      matched = needle;
    }
    const pass = idx !== -1;
    const display = isRegex ? String(needle) : JSON.stringify(needle);
    return {
      pass,
      message: () => {
        if (pass) {
          // Shown when `.not` fails: cite where the needle actually appears.
          const start = Math.max(0, idx - 60);
          const context = text
            .slice(start, idx + matched.length + 60)
            .replace(/\n/g, '\\n');
          return `[transcript] expected NOT to contain ${display}, but found it at char ${idx}: …${context}…`;
        }
        return `[transcript] expected to contain ${display} (searched ${text.length} chars)`;
      },
    };
  },
});
