/**
 * LLM-judge support (host side).
 *
 * The judge itself runs *inside* the sandbox, in the eval fixture's vitest worker
 * (see `judge-runtime.mjs`). This module supplies the pieces the harness needs to
 * wire that up:
 *   - the runtime source to inject (`getJudgeRuntimeSource`)
 *   - the sandbox paths it reads (`TRANSCRIPT_EVENTS_PATH`, `JUDGE_RUNTIME_PATH`)
 *   - the env to forward onto the `npx vitest` exec (`resolveJudgeEnv`)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Well-known context directory inside the sandbox (matches TRANSCRIPT_CONTEXT_DIR). */
export const AGENT_EVAL_DIR = '__agent_eval__';

/** Full normalized transcript (events), written for the judge to read. */
export const TRANSCRIPT_EVENTS_PATH = `${AGENT_EVAL_DIR}/transcript.json`;

/** Injected zero-dep judge runtime that EVAL.ts imports. */
export const JUDGE_RUNTIME_PATH = `${AGENT_EVAL_DIR}/judge.mjs`;

/**
 * Default judge model. Independent of the model under test — judging should use a
 * strong, fixed model so multi-model sweeps stay consistent and nothing self-scores.
 * Override per-experiment via the `AGENT_EVAL_JUDGE_MODEL` env var.
 */
export const DEFAULT_JUDGE_MODEL = 'anthropic/claude-opus-4-8';

let cachedSource: string | undefined;

/**
 * Read the judge runtime source (the `.mjs` shipped alongside this module).
 * Works in dev (src) and in the published package (dist) because the build copies
 * `judge-runtime.mjs` next to the compiled output.
 */
export function getJudgeRuntimeSource(): string {
  if (cachedSource === undefined) {
    const runtimeUrl = new URL('./judge-runtime.mjs', import.meta.url);
    cachedSource = readFileSync(fileURLToPath(runtimeUrl), 'utf8');
  }
  return cachedSource;
}

/**
 * Build the env to forward onto the in-sandbox `npx vitest` exec so the judge can
 * reach the gateway. Returns `undefined` when no gateway credential is available
 * (then judge-based assertions are simply not wired — vitest runs as before).
 *
 * @param model Optional explicit judge model (e.g. from experiment config). Falls
 *   back to `AGENT_EVAL_JUDGE_MODEL`, then `DEFAULT_JUDGE_MODEL`.
 */
export function resolveJudgeEnv(model?: string): Record<string, string> | undefined {
  const key = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN;
  if (!key) return undefined;

  const env: Record<string, string> = {
    AI_GATEWAY_API_KEY: key,
    AGENT_EVAL_JUDGE_MODEL: model ?? process.env.AGENT_EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
  };

  const base = process.env.AGENT_EVAL_JUDGE_BASE_URL;
  if (base) env.AGENT_EVAL_JUDGE_BASE_URL = base;

  // codebase() explorer strategy: 'fetch' forces the tool-loop; otherwise an
  // in-sandbox agent CLI is used when present.
  const explorer = process.env.AGENT_EVAL_JUDGE_EXPLORER;
  if (explorer) env.AGENT_EVAL_JUDGE_EXPLORER = explorer;

  return env;
}
