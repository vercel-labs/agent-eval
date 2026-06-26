/**
 * agent-eval LLM-judge runtime — injected into the sandbox as `__agent_eval__/judge.mjs`.
 *
 * Zero-dependency on purpose: it runs inside the eval fixture's own vitest worker,
 * so it relies only on the fixture's `vitest` (always present) and Node globals
 * (`fetch`, `node:fs`, `node:child_process`). It must NOT import anything that the
 * fixture wouldn't already have installed.
 *
 * Importing this module:
 *   1. exposes evidence helpers — `transcript()`, `diff()`, `files()`
 *   2. registers the async `expect(...).toSatisfyCriterion(criterion)` matcher
 *
 * Configuration comes from env (forwarded onto the `npx vitest` exec by the harness):
 *   AI_GATEWAY_API_KEY / VERCEL_OIDC_TOKEN  — gateway auth (required)
 *   AGENT_EVAL_JUDGE_MODEL                  — judge model id (required)
 *   AGENT_EVAL_JUDGE_BASE_URL               — gateway base (default: AI Gateway)
 *   AGENT_EVAL_DIR                          — context dir (default: __agent_eval__)
 */
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const DIR = process.env.AGENT_EVAL_DIR || '__agent_eval__';
const BASE = process.env.AGENT_EVAL_JUDGE_BASE_URL || 'https://ai-gateway.vercel.sh/v1';
const MODEL = process.env.AGENT_EVAL_JUDGE_MODEL;
const KEY = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;

function readJSON(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Normalized agent transcript (assistant text, thinking, tool calls + results). */
export function transcript() {
  const data = readJSON(DIR + '/transcript.json', { events: [] });
  const events = data.events || [];
  if (!events.length) return '(transcript unavailable)';
  return events
    .map(function (e) {
      if (e.type === 'tool_call' && e.tool) {
        return '[tool:' + e.tool.name + '] ' + JSON.stringify(e.tool.args || {});
      }
      if (e.type === 'tool_result' && e.tool) {
        const r =
          typeof e.tool.result === 'string' ? e.tool.result : JSON.stringify(e.tool.result || '');
        return '[result:' + e.tool.name + '] ' + String(r).slice(0, 2000);
      }
      const tag = e.type === 'thinking' ? 'thinking' : e.role || e.type;
      return '[' + tag + '] ' + (e.content || '');
    })
    .join('\n');
}

/** The agent's code changes, as a unified diff against the pre-run commit. */
export function diff() {
  try {
    // Stage first so newly-created (untracked) files show up — `git diff HEAD`
    // alone omits them, which is most of what an agent produces.
    try {
      execSync('git add -A', { stdio: 'ignore' });
    } catch {
      /* not a git repo */
    }
    const out = execSync('git diff --cached HEAD', { encoding: 'utf8' });
    return out ? out.slice(0, 100000) : '(no changes)';
  } catch {
    return '(diff unavailable)';
  }
}

/** Contents of one or more files in the workspace, concatenated. */
export function files(...paths) {
  return paths
    .map(function (p) {
      try {
        return '--- ' + p + ' ---\n' + readFileSync(p, 'utf8');
      } catch {
        return '--- ' + p + ' ---\n(missing)';
      }
    })
    .join('\n\n');
}

function parseVerdict(content) {
  // Tolerate prose / ```json fences around the JSON object.
  const match = content.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : content);
}

/** Ask the judge model whether `evidence` satisfies `criterion`. */
export async function judge(evidence, criterion, opts) {
  opts = opts || {};
  if (!KEY) {
    throw new Error(
      'agent-eval judge: AI_GATEWAY_API_KEY (or VERCEL_OIDC_TOKEN) is not set in the eval environment'
    );
  }
  const model = opts.model || MODEL;
  if (!model) {
    throw new Error('agent-eval judge: no judge model set (AGENT_EVAL_JUDGE_MODEL)');
  }

  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      // No response_format: the gateway rejects OpenAI's json_object mode for
      // several routes (e.g. Anthropic). We instruct JSON in the prompt and parse
      // tolerantly (parseVerdict handles prose / ```json fences).
      model: model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict grader for an AI coding-agent eval. Decide whether the EVIDENCE ' +
            'satisfies the CRITERION. Reply ONLY with JSON of the form ' +
            '{"pass": boolean, "reason": string}. Pass only if the criterion is clearly met.',
        },
        { role: 'user', content: 'CRITERION:\n' + criterion + '\n\nEVIDENCE:\n' + String(evidence) },
      ],
    }),
  });

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error('agent-eval judge: gateway error ' + res.status + ' ' + body);
  }

  const data = await res.json();
  const content =
    (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ||
    '';
  let verdict;
  try {
    verdict = parseVerdict(content);
  } catch {
    throw new Error('agent-eval judge: could not parse verdict JSON from model output: ' + content);
  }
  return { pass: !!verdict.pass, reason: String(verdict.reason == null ? '' : verdict.reason) };
}

expect.extend({
  async toSatisfyCriterion(received, criterion, opts) {
    const v = await judge(received, criterion, opts);
    return {
      pass: v.pass,
      message: function () {
        return v.pass
          ? 'expected criterion NOT to be satisfied, but the judge passed it: ' + v.reason
          : 'criterion not satisfied — judge: ' + v.reason;
      },
    };
  },
});
