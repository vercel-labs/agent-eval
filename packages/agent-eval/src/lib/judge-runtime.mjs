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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

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

  const data = await chatCompletion({
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
  });
  const content = msgContent(data);
  let verdict;
  try {
    verdict = parseVerdict(content);
  } catch {
    throw new Error('agent-eval judge: could not parse verdict JSON from model output: ' + content);
  }
  return { pass: !!verdict.pass, reason: String(verdict.reason == null ? '' : verdict.reason) };
}

/* ───────────────────────────── gateway plumbing ───────────────────────────── */

// No response_format: the gateway rejects OpenAI's json_object mode for several
// routes (e.g. Anthropic). We instruct JSON in the prompt and parse tolerantly.
async function chatCompletion(body) {
  if (!KEY) {
    throw new Error(
      'agent-eval judge: AI_GATEWAY_API_KEY (or VERCEL_OIDC_TOKEN) is not set in the eval environment'
    );
  }
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error('agent-eval judge: gateway error ' + res.status + ' ' + text);
  }
  return res.json();
}

function msgContent(data) {
  return (
    (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
  );
}

/* ─────────────────────────── codebase exploration ─────────────────────────── */

/**
 * Sentinel evidence: `expect(codebase()).toSatisfyCriterion(...)` makes the judge
 * EXPLORE the workspace (read files, grep, run the code) rather than grade a fixed
 * string. `root` defaults to the eval's working directory inside the sandbox.
 */
export function codebase(root) {
  return { __agentEvalKind: 'codebase', root: root || process.cwd() };
}

const JUDGE_SYSTEM =
  'You are a strict grader for an AI coding-agent eval. Investigate the project, then decide ' +
  'whether it clearly meets the CRITERION. Be skeptical; pass only if it is clearly met.';

// Prefer reusing an agent CLI already installed in the sandbox (it explores
// natively); fall back to a fetch tool-loop. Set AGENT_EVAL_JUDGE_EXPLORER=fetch
// to force the loop.
function findCli() {
  if ((process.env.AGENT_EVAL_JUDGE_EXPLORER || '').toLowerCase() === 'fetch') return null;
  for (const bin of ['claude']) {
    try {
      execFileSync('command', ['-v', bin], { stdio: 'ignore', shell: true });
      return bin;
    } catch {
      /* not installed */
    }
  }
  return null;
}

function exploreViaCli(bin, root, criterion, opts) {
  const model = opts.model || MODEL;
  const prompt =
    JUDGE_SYSTEM +
    '\n\nCRITERION:\n' +
    criterion +
    '\n\nInspect this project (read files, run commands as needed), then respond with ONLY ' +
    'a JSON object: {"pass": boolean, "reason": string}.';
  // The CLI talks to the same gateway, anthropic-style base (no /v1), bearer = KEY.
  const env = Object.assign({}, process.env, {
    ANTHROPIC_BASE_URL: BASE.replace(/\/v1\/?$/, ''),
    ANTHROPIC_AUTH_TOKEN: KEY,
    ANTHROPIC_API_KEY: '',
  });
  const args = ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions'];
  if (model) args.push('--model', model);
  const out = execFileSync(bin, args, { cwd: root, encoding: 'utf8', env: env, maxBuffer: 32 * 1024 * 1024 });
  // claude -p --output-format json => { result: "<final text>" }
  let text = out;
  try {
    text = JSON.parse(out).result || out;
  } catch {
    /* not JSON-wrapped; use raw output */
  }
  return parseVerdict(text);
}

function safePath(root, rel) {
  const abs = resolve(root, rel || '.');
  return abs === root || abs.startsWith(root + '/') ? abs : null;
}

function toolDef(name, description, props, required) {
  const properties = {};
  for (const k of Object.keys(props)) properties[k] = { type: props[k] };
  return {
    type: 'function',
    function: { name: name, description: description, parameters: { type: 'object', properties, required } },
  };
}

const EXPLORER_TOOLS = [
  toolDef('list_dir', 'List entries at a path relative to the project root.', { path: 'string' }, []),
  toolDef(
    'read_file',
    'Read a file relative to the project root (optional line offset/limit).',
    { path: 'string', offset: 'number', limit: 'number' },
    ['path']
  ),
  toolDef(
    'grep',
    'Regex search across files under a dir relative to the project root.',
    { pattern: 'string', path: 'string' },
    ['pattern']
  ),
  toolDef(
    'submit_verdict',
    'Submit your final judgment once you have enough evidence.',
    { pass: 'boolean', reason: 'string' },
    ['pass', 'reason']
  ),
];

function runTool(root, name, args) {
  const target = safePath(root, args.path);
  if (name === 'list_dir') {
    if (!target) return { error: 'path outside project root' };
    try {
      return {
        entries: readdirSync(target).map((e) => ({ name: e, dir: statSync(resolve(target, e)).isDirectory() })),
      };
    } catch {
      return { error: 'cannot list ' + args.path };
    }
  }
  if (name === 'read_file') {
    if (!target) return { error: 'path outside project root' };
    try {
      const lines = readFileSync(target, 'utf8').split('\n');
      const offset = args.offset || 0;
      const limit = args.limit || 400;
      return { content: lines.slice(offset, offset + limit).join('\n'), totalLines: lines.length };
    } catch {
      return { error: 'cannot read ' + args.path };
    }
  }
  if (name === 'grep') {
    const base = safePath(root, args.path || '.');
    if (!base) return { error: 'path outside project root' };
    let re;
    try {
      re = new RegExp(args.pattern, 'i');
    } catch {
      return { error: 'bad regex' };
    }
    const matches = [];
    const walk = (dir) => {
      let entries = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (matches.length >= 50) return;
        if (e === 'node_modules' || e === '.git') continue;
        const p = resolve(dir, e);
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(p);
        } else {
          try {
            readFileSync(p, 'utf8')
              .split('\n')
              .forEach((ln, i) => {
                if (matches.length < 50 && re.test(ln)) {
                  matches.push(p.slice(root.length + 1) + ':' + (i + 1) + ': ' + ln.slice(0, 200));
                }
              });
          } catch {
            /* skip binary/unreadable */
          }
        }
      }
    };
    walk(base);
    return { matches };
  }
  return { error: 'unknown tool ' + name };
}

async function exploreViaFetch(root, criterion, opts) {
  const model = opts.model || MODEL;
  if (!model) throw new Error('agent-eval judge: no judge model set (AGENT_EVAL_JUDGE_MODEL)');
  const messages = [
    { role: 'system', content: JUDGE_SYSTEM },
    {
      role: 'user',
      content: 'CRITERION:\n' + criterion + '\n\nInspect the project from its root, then call submit_verdict.',
    },
  ];
  for (let turn = 0; turn < 12; turn++) {
    const data = await chatCompletion({
      model: model,
      temperature: 0,
      tools: EXPLORER_TOOLS,
      tool_choice: 'auto',
      messages: messages,
    });
    const msg = data.choices[0].message;
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) return parseVerdict(msg.content || ''); // model answered in prose
    for (const c of calls) {
      let args = {};
      try {
        args = JSON.parse(c.function.arguments || '{}');
      } catch {
        /* ignore malformed args */
      }
      if (c.function.name === 'submit_verdict') {
        return { pass: !!args.pass, reason: String(args.reason == null ? '' : args.reason) };
      }
      const result = runTool(root, c.function.name, args);
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result).slice(0, 8000) });
    }
  }
  throw new Error('agent-eval judge: explorer exceeded its turn budget without a verdict');
}

async function explore(root, criterion, opts) {
  const bin = findCli();
  if (bin) {
    try {
      const verdict = exploreViaCli(bin, root, criterion, opts);
      console.error('[agent-eval judge] explored via ' + bin + ' CLI');
      return verdict;
    } catch (e) {
      console.error(
        '[agent-eval judge] ' + bin + ' CLI explorer failed, falling back to fetch loop: ' +
          (e && e.message ? e.message : e)
      );
    }
  }
  console.error('[agent-eval judge] explored via fetch tool-loop');
  return exploreViaFetch(root, criterion, opts);
}

// Exposed for unit tests only (not part of the public surface).
export const __test = { runTool, safePath };

/* ───────────────────────────────── matcher ────────────────────────────────── */

expect.extend({
  async toSatisfyCriterion(received, criterion, opts) {
    opts = opts || {};
    const v =
      received && received.__agentEvalKind === 'codebase'
        ? await explore(received.root, criterion, opts)
        : await judge(String(received), criterion, opts);
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
