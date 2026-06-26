/**
 * Agentic LLM judge.
 *
 * `judge()` runs a real agent — the same plugin agents the framework already
 * orchestrates — as a JUDGE. It explores a codebase and/or reads a transcript,
 * evaluates your criteria, and returns a structured verdict.
 *
 * Because a judge is just an agent run, it reuses the entire plugin orchestrator
 * (sandbox lifecycle, CLI install, agentic tool use) via `runWithDefinition`. The
 * judge agent inspects the project with its OWN tools (read/grep/run) rather than
 * grading a fixed evidence blob — i.e. it is genuinely agentic. The verdict is
 * returned the same way an eval's generated files are: the judge writes a small
 * JSON file and the orchestrator's git-diff capture brings it back to the host.
 *
 * Super-easy usage:
 *
 *   import { judge } from '@vercel/agent-eval';
 *
 *   // Judge a codebase (the judge agent explores it):
 *   const v = await judge({
 *     criteria: 'greet() is exported and returns a non-empty string',
 *     codebase: '/path/to/project',
 *   });
 *   v.pass; // boolean
 *
 *   // Judge a transcript (how the agent worked):
 *   await judge({
 *     criteria: 'Used React DevTools to diagnose, not trial-and-error',
 *     transcript,
 *   });
 *
 *   // Judge both, with several criteria:
 *   await judge({ criteria: ['…', '…'], codebase: '/p', transcript });
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep, relative } from 'node:path';

// Import from the registry's index (NOT registry.js) so the built-in agents are
// registered as a side effect before getAgent() is called.
import { getAgent } from './agents/index.js';
import type { AgentType, ModelTier, SandboxBackend } from './types.js';

/** Sandbox-relative directory for judge I/O (transcript in, verdict out). */
const JUDGE_DIR = '__judge__';
const TRANSCRIPT_FILE = `${JUDGE_DIR}/transcript.md`;
const VERDICT_FILE = `${JUDGE_DIR}/verdict.json`;

/**
 * Whether a codebase-relative path lives inside a tree we never copy into the judge
 * fixture: `node_modules` (heavyweight) or `.git` (recreated in-sandbox). Matched by
 * whole path SEGMENT, so siblings like `.github` / `.gitignore` are KEPT (a plain
 * `includes('/.git')` would wrongly drop them). Exported for unit testing.
 */
export function isFixtureExcluded(relativePath: string): boolean {
  return relativePath.split(sep).some((seg) => seg === 'node_modules' || seg === '.git');
}

/** The default judge agent — a strong, gateway-routed coding agent. */
const DEFAULT_JUDGE_AGENT: AgentType = 'vercel-ai-gateway/claude-code';

export interface JudgeOptions {
  /** What to evaluate. A single criterion or several (each judged independently). */
  criteria: string | string[];
  /**
   * A codebase to judge: a directory path. The judge agent explores it with its
   * own tools (agentic). `node_modules` and `.git` are not copied.
   */
  codebase?: string;
  /** A transcript to judge (e.g. an agent run's transcript), made available to the judge. */
  transcript?: string;
  /** Which agent acts as the judge. Default: `vercel-ai-gateway/claude-code`. */
  agent?: AgentType;
  /** Judge model. Default: the judge agent's own default model (claude → opus). */
  model?: ModelTier;
  /** API key for the judge agent. Default: `process.env[agent.getApiKeyEnvVar()]`. */
  apiKey?: string;
  /** Sandbox timeout in seconds. Default: 600. */
  timeout?: number;
  /** Sandbox backend. Default: 'auto'. */
  sandbox?: SandboxBackend | 'auto';
}

/** One criterion's verdict. */
export interface CriterionVerdict {
  criterion: string;
  pass: boolean;
  reason: string;
}

/** The judge's overall verdict. */
export interface JudgeVerdict {
  /** True iff every criterion passed. */
  pass: boolean;
  /** Per-criterion verdicts, in the order the criteria were given. */
  results: CriterionVerdict[];
  /** The judge agent's own transcript (for debugging the judgment). */
  judgeTranscript?: string;
  /** The raw verdict text the judge produced (for debugging). */
  raw?: string;
}

/**
 * Build the judge prompt. Exported for tests.
 *
 * Instructs the judge to (optionally) inspect the codebase and/or the transcript,
 * evaluate each criterion skeptically, and emit a verdict BOTH as a file (the
 * reliable channel, captured via git-diff) and as its final message (a fallback).
 */
export function buildJudgePrompt(
  criteria: string[],
  opts: { hasCodebase: boolean; hasTranscript: boolean }
): string {
  const lines: string[] = [];
  lines.push(
    "You are a strict, skeptical judge evaluating an AI coding agent's work. " +
      'Decide each criterion ONLY on clear evidence; when in doubt, FAIL it.'
  );
  lines.push('');
  if (opts.hasCodebase) {
    lines.push(
      'Inspect the project in the current directory — read files, grep, run commands as ' +
        'needed — to gather evidence.'
    );
  }
  if (opts.hasTranscript) {
    lines.push(`Read the agent's transcript at ${TRANSCRIPT_FILE} to see how it worked.`);
  }
  lines.push('');
  lines.push('Evaluate these criteria:');
  criteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  lines.push('');
  lines.push(
    `When done, write your verdict to ${VERDICT_FILE} as JSON of exactly this shape:`
  );
  lines.push('{"results":[{"criterion":"<criterion text>","pass":true|false,"reason":"<1-2 sentences citing evidence>"}]}');
  lines.push('Include one entry per criterion, in the same order. Then print the same JSON as your final message.');
  return lines.join('\n');
}

/**
 * Parse a judge verdict from raw text. Tolerant of prose / ```json fences around
 * the object. Exported for tests. Throws if no usable verdict is found.
 */
export function parseJudgeVerdict(raw: string | undefined, criteria: string[]): CriterionVerdict[] {
  if (raw) {
    // Grab the JSON object that contains "results" (handles fences / surrounding prose).
    const match = raw.match(/\{[\s\S]*"results"[\s\S]*\}/);
    if (match) {
      try {
        const obj = JSON.parse(match[0]);
        if (Array.isArray(obj.results) && obj.results.length > 0) {
          return obj.results.map((r: { criterion?: unknown; pass?: unknown; reason?: unknown }, i: number) => ({
            criterion: String(r.criterion ?? criteria[i] ?? `criterion ${i + 1}`),
            pass: !!r.pass,
            reason: String(r.reason ?? ''),
          }));
        }
      } catch {
        // fall through to the throw
      }
    }
  }
  throw new Error('judge: could not parse a verdict from the judge output');
}

/**
 * Judge a codebase and/or a transcript against one or more criteria, using an
 * agent as an agentic judge. Returns a structured pass/fail verdict.
 */
export async function judge(options: JudgeOptions): Promise<JudgeVerdict> {
  const criteria = Array.isArray(options.criteria) ? options.criteria : [options.criteria];
  if (criteria.length === 0) {
    throw new Error('judge: at least one criterion is required');
  }
  if (!options.codebase && !options.transcript) {
    throw new Error('judge: provide a `codebase` and/or a `transcript` to judge');
  }

  const agent = getAgent(options.agent ?? DEFAULT_JUDGE_AGENT);
  const apiKey = options.apiKey ?? process.env[agent.getApiKeyEnvVar()];
  if (!apiKey) {
    throw new Error(`judge: no API key — set ${agent.getApiKeyEnvVar()} or pass options.apiKey`);
  }
  const model = options.model ?? agent.getDefaultModel();

  // Build a temp judge "fixture": the codebase (if any) + the transcript file + a
  // fallback package.json so the orchestrator's `npm install` step has something to
  // run. NOTE: if the copied codebase brings its OWN package.json, install runs its
  // full dependency tree in-sandbox (slow, and a broken install fails the judge).
  // No EVAL.ts → validation is skipped; the judge prompt drives the run and the
  // verdict comes back as a captured generated file.
  const dir = mkdtempSync(join(tmpdir(), 'agent-eval-judge-'));
  try {
    if (options.codebase) {
      const root = options.codebase;
      cpSync(root, dir, {
        recursive: true,
        // cpSync passes absolute source paths; compare segments RELATIVE to the
        // codebase root so an ancestor dir named node_modules/.git can't match.
        filter: (src) => !isFixtureExcluded(relative(root, src)),
      });
    }
    if (!existsSync(join(dir, 'package.json'))) {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'judge-target', private: true, type: 'module' }, null, 2)
      );
    }
    if (options.transcript) {
      mkdirSync(join(dir, JUDGE_DIR), { recursive: true });
      writeFileSync(join(dir, TRANSCRIPT_FILE), options.transcript);
    }

    const prompt = buildJudgePrompt(criteria, {
      hasCodebase: !!options.codebase,
      hasTranscript: !!options.transcript,
    });

    // A judge is just an agent run: validation 'none' (no EVAL.ts), the judge prompt
    // drives an agentic exploration, and the verdict file is captured like any other
    // generated file (git diff). Reuses the whole plugin orchestrator.
    const result = await agent.run(dir, {
      prompt,
      model,
      apiKey,
      validation: 'none',
      scripts: [],
      timeout: (options.timeout ?? 600) * 1000,
      sandbox: options.sandbox,
    });

    // The judge agent CLI itself failed (and didn't leave a verdict) → surface it.
    if (!result.success && !result.generatedFiles?.[VERDICT_FILE]) {
      throw new Error(`judge: the judge agent failed: ${result.error ?? 'unknown error'}`);
    }

    // Prefer the verdict file; fall back to the judge's final message.
    const verdictRaw = result.generatedFiles?.[VERDICT_FILE] ?? result.output;
    const results = parseJudgeVerdict(verdictRaw, criteria);

    return {
      pass: results.every((r) => r.pass),
      results,
      judgeTranscript: result.transcript,
      raw: verdictRaw,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
