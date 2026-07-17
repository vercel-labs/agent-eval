# @vercel/agent-eval

Test AI coding agents on your framework. Measure what actually works.

## Why?

You're building a frontend framework and want AI agents to work well with it. But how do you know if:
- Your documentation helps agents write correct code?
- Adding an MCP server improves agent success rates?
- Sonnet performs as well as Opus for your use cases?
- Your latest API changes broke agent compatibility?

**This framework gives you answers.** Run controlled experiments, measure pass rates, compare techniques.

## Quick Start

```bash
# Create a new eval project
npx @vercel/agent-eval init my-agent-evals
cd my-agent-evals

# Install dependencies
npm install

# Add your API keys
cp .env.example .env
# Edit .env with your AI_GATEWAY_API_KEY and VERCEL_TOKEN

# Preview what will run (no API calls, no cost)
npx @vercel/agent-eval --dry

# Run all experiments
npx @vercel/agent-eval
```

## CLI

### Run all experiments

```bash
npx @vercel/agent-eval
```

With no arguments, the CLI discovers every `experiments/*.ts` file and runs them all. Each experiment runs in parallel. Results with matching fingerprints are reused automatically (see [Result Reuse](#result-reuse)).

### Run a single experiment

```bash
npx @vercel/agent-eval cc
```

The argument is the experiment filename without `.ts`. This resolves to `experiments/cc.ts`.

### Flags

| Flag                 | Description                                                                                |
|----------------------|--------------------------------------------------------------------------------------------|
| `--dry`              | Preview what would run without executing. No API calls, no cost.                           |
| `--smoke`            | Quick setup verification. Picks the first eval alphabetically, runs once per model.        |
| `--force`            | Ignore cached fingerprints and re-run everything. Only applies when running all.           |
| `--ack-failures`     | Keep non-model failures as final results instead of deleting them.                         |

Flags work with both modes:

```bash
npx @vercel/agent-eval --dry          # preview all experiments
npx @vercel/agent-eval cc --dry       # preview a single experiment
npx @vercel/agent-eval --smoke        # smoke test all experiments
npx @vercel/agent-eval cc --smoke     # smoke test one experiment
```

### Other commands

```bash
npx @vercel/agent-eval init <name>          # scaffold a new eval project
npx @vercel/agent-eval playground           # launch web-based results viewer
npx @vercel/agent-eval playground --watch   # live mode (watches for new results)
```

## Creating Evals

Each eval tests one specific task an agent should be able to do with your framework.

### Directory structure

```
evals/
  create-button-component/
    PROMPT.md           # Task for the agent
    EVAL.ts             # Tests to verify success (or EVAL.tsx for JSX)
    package.json        # Your framework as a dependency
    src/                # Starter code
```

**PROMPT.md** -- what you want the agent to do:

```markdown
Create a Button component using MyFramework.

Requirements:
- Export a Button component from src/components/Button.tsx
- Accept `label` and `onClick` props
- Use the framework's styling system for hover states
```

**EVAL.ts** -- how you verify it worked:

```typescript
import { test, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

test('Button component exists', () => {
  expect(existsSync('src/components/Button.tsx')).toBe(true);
});

test('has required props', () => {
  const content = readFileSync('src/components/Button.tsx', 'utf-8');
  expect(content).toContain('label');
  expect(content).toContain('onClick');
});

test('project builds', () => {
  execSync('npm run build', { stdio: 'pipe' });
});
```

Use **EVAL.tsx** when your tests require JSX syntax (React Testing Library, component rendering). You only need one eval file per fixture -- choose `.tsx` if any test needs JSX.

### Asserting on agent behavior

EVAL.ts tests can assert not just on the files the agent produced, but on *how* it worked — which shell commands it ran, which files it read, how many tool calls it made, etc. The framework automatically parses the agent's transcript and writes the results to `__agent_eval__/results.json` in the sandbox before your tests run.

```typescript
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';

test('agent used the correct scaffolding command', () => {
  const results = JSON.parse(readFileSync('__agent_eval__/results.json', 'utf-8'));
  const commands = results.o11y.shellCommands.map((c: { command: string }) => c.command);
  expect(commands).toContain('npx create-next-app project');
});

test('agent did not make excessive tool calls', () => {
  const results = JSON.parse(readFileSync('__agent_eval__/results.json', 'utf-8'));
  expect(results.o11y.totalToolCalls).toBeLessThan(50);
});
```

The `results.o11y` object is a `TranscriptSummary` with these fields:

| Field | Type | Description |
|-------|------|-------------|
| `shellCommands` | `{ command, exitCode?, success? }[]` | Shell commands the agent ran |
| `filesRead` | `string[]` | Files the agent read |
| `filesModified` | `string[]` | Files the agent wrote or edited |
| `toolCalls` | `Record<ToolName, number>` | Count of each tool type used |
| `totalToolCalls` | `number` | Total tool calls made |
| `webFetches` | `{ url, method?, status?, success? }[]` | Web fetches made |
| `totalTurns` | `number` | Conversation turns |
| `errors` | `string[]` | Errors encountered |
| `thinkingBlocks` | `number` | Thinking/reasoning blocks |

> **Note**: If the agent's transcript is unavailable (e.g. the agent crashed before producing output), `results.o11y` will be `null`.

### Agentic LLM judge

For open-ended quality checks that exact assertions can't express, EVAL.ts can run an **agentic LLM judge**. Each judge assertion re-invokes the *same agent* that did the codegen, **in the same sandbox**, to evaluate a criterion — then returns pass/fail. No fresh sandbox, no copying evidence around.

```typescript
import { test, expect } from 'vitest';
import { environment, transcript } from '@vercel/agent-eval/eval';

// Judge the final state: the agent explores the project (read/grep/run) for evidence.
test('uses server components', async () => {
  await expect(environment).toSatisfyCriterion('uses Server Components for the product list');
});

// Judge the transcript: how the agent worked. It reads the transcript by path, so the
// full transcript is never stuffed into a prompt.
test('diagnosed properly', async () => {
  await expect(transcript).toSatisfyCriterion('diagnosed with DevTools, not trial-and-error edits');
});

// Numeric: the judge scores 0-1; assert a threshold (still pass/fail overall).
test('quality bar', async () => {
  await expect(environment).toScoreAtLeast('production-quality error handling', 0.8);
});
```

Two subjects, imported from `@vercel/agent-eval/eval` — no paths, the subject is implicit:

- `environment` — the judge agent explores the final sandbox state (cwd) with its own tools.
- `transcript` — the judge agent reads the materialized transcript by path.

Two matchers, on either subject:

- `toSatisfyCriterion(criterion)` — passes when the judge decides the criterion is satisfied.
- `toScoreAtLeast(criterion, threshold)` — passes when the judge's 0–1 score is `>= threshold`.

One deterministic matcher, on `transcript` only — no judge run, free and exact:

- `toContainText(needle)` — passes when the raw transcript contains the substring, or matches the `RegExp` (use `/…/i` for case-insensitive). Built for `.not`, i.e. asserting the agent *never* said or reached for something:

```typescript
test('never suggested the pages router API', () => {
  expect(transcript).not.toContainText('getServerSideProps');
  expect(transcript).not.toContainText(/getserversideprops/i); // any casing
});
```

A missing or empty transcript **throws** (fails the test even under `.not`) — an uncaptured transcript is an infra failure, not evidence of absence. Note the transcript is the agent's native format (for `claude-code`, raw session JSONL), so text containing quotes or newlines appears JSON-escaped there; stick to identifier-like needles or match the escaped form with a `RegExp`. For semantic "never did X" checks, phrase the negation *inside* a `toSatisfyCriterion` criterion instead — do not use `.not.toSatisfyCriterion(...)`, which would invert the judge's fail-closed default into a fail-open one.

You supply only the **criterion** string; the framework owns the judge prompt and the verdict contract. On failure the assertion message carries the judge's reasoning, e.g. `[judge:environment] FAIL (score 0.42): product list is a Client Component`, so a failed judge clause is distinguishable from a failed deterministic test or a crash.

By default the judge uses the **same agent and model** as the run under test (self-grading). Because each assertion is a real agent run, it costs time and tokens — keep criteria focused.

**Pin the judge** to grade every run with one fixed agent + model — the apples-to-apples choice when comparing models, since the judge quality no longer varies with the model under test (and a model never grades itself):

```typescript
const config: ExperimentConfig = {
  agent: 'codex',
  model: 'gpt-5.4',
  // Grade with a fixed Claude judge regardless of the model under test.
  judge: { agent: 'vercel-ai-gateway/claude-code', model: 'claude-opus-4-8' },
};
```

- `judge.model` is required (pinning the model is the point).
- `judge.agent` is optional and defaults to the codegen agent — omit it to keep the same harness and only pin the model. When it names a different agent, that agent's CLI is installed in the sandbox automatically and its key is resolved from its own env var (falling back to `VERCEL_OIDC_TOKEN`).
- Pinning changes the eval fingerprint, so a pinned run won't reuse self-graded cached results.

> **Note**: requires `validation: 'vitest'` (the default). The framework gives the eval process the run's credentials automatically so the judge can call the agent CLI in-sandbox.

## Configuration Reference

### Experiment config

```typescript
// experiments/my-experiment.ts
import type { ExperimentConfig } from '@vercel/agent-eval';

const config: ExperimentConfig = {
  // Required: which agent to use
  agent: 'vercel-ai-gateway/claude-code',

  // Model to use. Omit this to use the underlying agent CLI's native default.
  // Provide an array to run the same experiment across multiple models.
  model: 'opus',

  // How many times to run each eval (default: 1)
  runs: 10,

  // Stop after first success? (default: true)
  earlyExit: false,

  // npm scripts that must pass after agent finishes (default: [])
  scripts: ['build', 'lint'],

  // Validation mode after the agent finishes (default: 'vitest')
  // 'vitest' - run EVAL.ts/EVAL.tsx plus configured scripts
  // 'none' - response-only mode; skip EVAL.ts/EVAL.tsx, run scripts if provided
  validation: 'vitest',

  // Timeout per run in seconds (default: 600)
  timeout: 600,

  // Filter which evals to run (default: '*' for all)
  evals: '*',
  // evals: ['specific-eval'],
  // evals: (name) => name.startsWith('api-'),

  // Setup function for sandbox pre-configuration
  setup: async (sandbox) => {
    await sandbox.writeFiles({ '.env': 'API_KEY=test' });
    await sandbox.runCommand('npm', ['run', 'setup']);
  },

  // Rewrite the prompt before running
  editPrompt: (prompt) => `Use the skill.\n\n${prompt}`,

  // Custom post-run analysis hook. Can attach analysis/metadata to result.json.
  onRunComplete: async ({ runData }) => ({
    ...runData,
    result: {
      ...runData.result,
      analysis: { mentionedBrands: ['Vercel'] },
    },
  }),

  // Optional brands to compare in downstream analysis.
  brands: [
    {
      id: 'vercel',
      name: 'Vercel',
      domain: 'vercel.com',
      aliases: ['Vercel Platform'],
      isYourBrand: true,
    },
  ],

  // Sandbox backend (default: 'auto' -- Vercel if token present, else Docker)
  sandbox: 'auto',

  // Copy project files to results directory (default: 'none')
  // 'none' - don't copy files
  // 'changed' - copy only files modified by the agent
  // 'all' - copy the entire project including original fixture files
  copyFiles: 'changed',

  // Pin the agentic LLM judge (see "Agentic LLM judge" above). Omit to self-grade
  // with the codegen agent+model. `model` required; `agent` defaults to codegen.
  judge: { agent: 'vercel-ai-gateway/claude-code', model: 'claude-opus-4-8' },
};

export default config;
```

### Agent selection

```typescript
// Vercel AI Gateway (recommended -- unified billing and observability)
agent: 'vercel-ai-gateway/claude-code'  // Claude Code via AI Gateway
agent: 'vercel-ai-gateway/codex'        // OpenAI Codex via AI Gateway
agent: 'vercel-ai-gateway/opencode'     // OpenCode via AI Gateway

// Direct API (uses provider keys directly)
agent: 'claude-code'  // requires ANTHROPIC_API_KEY
agent: 'codex'        // requires OPENAI_API_KEY
agent: 'gemini'       // requires GEMINI_API_KEY
agent: 'cursor'       // requires CURSOR_API_KEY
```

### Multi-model experiments

Provide an array of models to run the same experiment on each one. Results are stored under separate directories (`experiment-name/model-name`):

```typescript
const config: ExperimentConfig = {
  agent: 'vercel-ai-gateway/claude-code',
  model: ['opus', 'sonnet'],
  runs: 10,
};
```

### Native agent defaults

When `model` is omitted, Agent Eval does not pass a model override. The
underlying agent CLI chooses the same native default it would use for a normal
user run:

```typescript
const config: ExperimentConfig = {
  agent: 'vercel-ai-gateway/claude-code',
  runs: 10,
};
```

Results use `modelPolicy: 'native-default'`, `requestedModel` is omitted, and
`observedModel` is populated when the agent CLI exposes the runtime model in its
transcript or logs. Provide `model` to force a specific model.

### OpenCode model format

OpenCode uses Vercel AI Gateway exclusively. The OpenCode CLI reads models as
`{providerID}/{modelID}`, where the provider is the CLI's own `vercel` (AI
Gateway) provider — so both of these forms work:

```typescript
model: 'anthropic/claude-sonnet-4'        // canonical gateway id — vercel/ is added automatically
model: 'vercel/anthropic/claude-sonnet-4' // OpenCode's native form — passed verbatim
```

When the prefix was added automatically, `observedModel` is reported back in
the request's namespace (`anthropic/claude-sonnet-4`), so requested-vs-observed
comparisons hold. Models targeting a provider configured via
`agentOptions.extraProviders` are passed verbatim.

### Response-only evals

Use `validation: 'none'` for tasks where the important output is the agent's
answer rather than changed files passing `EVAL.ts`.

```typescript
const config: ExperimentConfig = {
  agent: 'vercel-ai-gateway/claude-code',
  model: 'sonnet',
  validation: 'none',
  runs: 10,
  earlyExit: false,
  brands: [
    { id: 'vercel', name: 'Vercel', aliases: ['Vercel Platform'], isYourBrand: true },
    { id: 'netlify', name: 'Netlify' },
    { id: 'railway', name: 'Railway' },
  ],
  onRunComplete: async ({ runData }) => {
    // Add custom brand/recommendation analysis here.
    return runData;
  },
};
```

Response-only fixtures still need `PROMPT.md` and `package.json`, but they do
not need `EVAL.ts` or `EVAL.tsx`.

## A/B Testing

The real power is comparing different approaches. Create multiple experiment configs:

```typescript
// experiments/control.ts
import type { ExperimentConfig } from '@vercel/agent-eval';

const config: ExperimentConfig = {
  agent: 'vercel-ai-gateway/claude-code',
  model: 'opus',
  runs: 10,
  earlyExit: false,
};

export default config;
```

```typescript
// experiments/with-mcp.ts
import type { ExperimentConfig } from '@vercel/agent-eval';

const config: ExperimentConfig = {
  agent: 'vercel-ai-gateway/claude-code',
  model: 'opus',
  runs: 10,
  earlyExit: false,
  setup: async (sandbox) => {
    await sandbox.runCommand('npm', ['install', '-g', '@myframework/mcp-server']);
    await sandbox.writeFiles({
      '.claude/settings.json': JSON.stringify({
        mcpServers: { myframework: { command: 'myframework-mcp' } }
      })
    });
  },
};

export default config;
```

```bash
npx @vercel/agent-eval
```

Compare the results:
```
control (baseline):     7/10 passed (70%)
with-mcp:              9/10 passed (90%)
```

| Experiment | Control | Treatment |
|------------|---------|-----------|
| MCP impact | No MCP | With MCP server |
| Model comparison | Haiku | Sonnet / Opus |
| Documentation | Minimal docs | Rich examples |
| System prompt | Default | Framework-specific |
| Tool availability | Read/write only | + custom tools |

## Results

Results are saved to `results/<experiment>/<timestamp>/`:

```
results/
  with-mcp/
    2026-01-27T10-30-00Z/
      create-button/
        summary.json            # Pass rate, fingerprint, classification
        classification.json     # Cached failure classification (if failed)
        run-1/
          result.json           # Individual run result + o11y summary
          transcript.json       # Parsed/structured agent transcript
          transcript-raw.jsonl  # Raw agent output (for debugging)
          outputs/
            eval.txt            # EVAL.ts test output
            scripts/
              build.txt         # npm script output
          project/              # Agent-generated files (if copyFiles is set)
            src/
              Button.tsx        # Files created/modified by the agent
```

### summary.json

Each eval directory contains a `summary.json` with:

```json
{
  "totalRuns": 2,
  "passedRuns": 0,
  "passRate": "0%",
  "meanDuration": 45.2,
  "fingerprint": "a1b2c3...",
  "classification": {
    "failureType": "infra",
    "failureReason": "Rate limited (HTTP 429) — model never ran"
  },
  "valid": false
}
```

The `fingerprint` field enables result reuse across runs. The `classification` and `valid` fields appear only for failed evals -- `valid: false` marks non-model failures so they are not reused by fingerprinting and are automatically retried.

### Playground UI

Browse results in a web-based dashboard:

```bash
npx @vercel/agent-eval playground
```

This opens a local Next.js app with:
- **Overview** dashboard with stats and recent experiments
- **Experiment detail** with per-eval pass rates and run results
- **Transcript viewer** to inspect agent tool calls, thinking, and errors
- **Compare** two runs side-by-side with pass rate deltas

Options:
```bash
npx @vercel/agent-eval playground --results-dir ./results --evals-dir ./evals --port 3001
```

### File Copying

By default, the framework only saves test outputs and transcripts. Use the `copyFiles` config option to also save the files generated by the agent:

```typescript
const config: ExperimentConfig = {
  copyFiles: 'changed',  // or 'all' or 'none' (default)
};
```

**Options:**

- **`none`** (default) — Don't copy any project files, only save outputs and transcripts
- **`changed`** — Copy only files that were modified, created, or deleted by the agent
- **`all`** — Copy the complete project including both the original fixture files and agent changes

Files are saved to `results/<experiment>/<timestamp>/<eval>/run-N/project/`. The framework uses git to track changes, so files must be text-based to be captured.

## Result Reuse

The framework computes a SHA-256 fingerprint for each (eval, config) pair. The fingerprint covers all eval directory files and the config fields that affect results: `agent`, `model`, `scripts`, `timeout`, `earlyExit`, and `runs`.

On subsequent runs, evals with a matching fingerprint and a valid cached result (at least one passing run) are skipped automatically. This means:

- **Adding new evals** -- safe, no existing results to invalidate.
- **Extending the model array** -- safe, each model gets its own experiment directory.
- **Changing the `evals` filter** -- safe, the filter is not part of the fingerprint.
- **Editing an eval file** -- only invalidates that specific eval.
- **Changing config fields** (agent, model, timeout, etc.) -- invalidates all evals in that experiment.

Use `--force` to bypass fingerprinting and re-run everything. Functions like `setup` and `editPrompt` cannot be hashed, so use `--force` when you change those.

Each result also stores a `contentFingerprint` — a hash of the eval files **only**, independent of config. This separates "the eval itself changed" from "a config field changed."

### Carrying forward config-only changes

A benign config change (e.g. bumping `timeout`) changes the combined fingerprint and would otherwise re-run every eval. `agent-eval refingerprint` carries those forward in the cached results **without masking a real eval change**:

```bash
agent-eval refingerprint            # all experiments
agent-eval refingerprint cc --dry   # preview one experiment
```

For each cached result it compares the eval's current `contentFingerprint` to the stored one: if the content is unchanged it re-stamps the combined fingerprint (the result stays cached); if the content **changed** it leaves the result stale so it re-runs. `agent-eval status` already classifies by eval *content*, so it never reports a config-only change as work — run `refingerprint` after editing an experiment config to carry that change into the cache (`run` does this automatically).

### After changing or syncing evals: status → pick what to run

Run `agent-eval` with no arguments. It shows the work, then — in a terminal — lets you multi-select which experiments to run. It never re-runs everything:

```bash
agent-eval
```
```
Evals needing work:
  new      agent-026-no-serial-await
  changed  agent-024-avoid-redundant-usestate

Work to do — 6 run(s) across 3 experiment(s):
  claude-opus-4.6      2 to run  (22 up to date)
  ...

Pick experiments to run:
   1  claude-opus-4.6
   2  claude-sonnet-4.6
Numbers (e.g. 1,3), "all", or Enter to skip:
```

Status classifies each eval by **content**, so a benign config change (e.g. pinning a judge) is never reported as work. The same building blocks work non-interactively:

```bash
agent-eval status                  # read-only: what's new/changed, per experiment
agent-eval status --check          # exit non-zero if anything is new/changed (simple CI gate)
agent-eval status --json           # machine-readable, for custom CI policy
agent-eval run claude-sonnet-4.6   # run the named experiment(s) — new/changed evals only
```

**Accepting staleness is the consumer's call, not the framework's.** `agent-eval` only *reports* — it has no `keep`/`acknowledge`. If you want to leave some experiments on an older eval while keeping others fresh, do that in your own CI: read `agent-eval status --json` (per-experiment `new`/`changed`) and fail only on experiments not in your accepted-stale list. (See next-evals-oss's `scripts/check-stale.mjs` for an example.)

> `refingerprint` (carry config-only changes forward) runs automatically inside `run`; your sync script should call `agent-eval refingerprint` after pulling evals so committed results pick up benign config changes without re-running.

## Failure Classification

When evals fail, the framework optionally classifies each failure as one of:

- **model** -- the agent tried but wrote incorrect code
- **infra** -- infrastructure broke (API errors, rate limits, crashes)
- **timeout** -- the run hit its time limit

Classification uses Claude Sonnet 4.5 via the Vercel AI Gateway with sandboxed read-only tools to inspect result files. This requires `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` to be set.

### Classifier Status

- **Enabled** (with `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`): Classifications are cached in `classification.json`. Non-model failures are removed by default so they can be re-run; pass `--ack-failures` to keep them as final results.
- **Disabled** (without keys): The classifier is skipped. All results are preserved as-is. Housekeeping will not remove non-model failures (only incomplete and duplicate results). Add `AI_GATEWAY_API_KEY` to `.env` to enable the classifier.

## Housekeeping

After each experiment completes, the framework automatically:
- Removes duplicate results for the same eval (keeps the newest)
- Removes incomplete results (missing `summary.json` or transcripts)
- Removes empty timestamp directories

## Environment Variables

Every run requires an API key for the agent and a token for the sandbox. Classifier is optional.

| Variable             | Required when                          | Description                                                                                  |
|----------------------|----------------------------------------|----------------------------------------------------------------------------------------------|
| `AI_GATEWAY_API_KEY` | `vercel-ai-gateway/` agents or classifier | Vercel AI Gateway key -- required for `vercel-ai-gateway/` agents and failure classification |
| `ANTHROPIC_API_KEY`  | `agent: 'claude-code'`                 | Direct Anthropic API key                                                                     |
| `OPENAI_API_KEY`     | `agent: 'codex'`                       | Direct OpenAI API key                                                                        |
| `GEMINI_API_KEY`     | `agent: 'gemini'`                      | Direct Google Gemini API key                                                                 |
| `CURSOR_API_KEY`     | `agent: 'cursor'`                      | Direct Cursor API key                                                                        |
| `VERCEL_TOKEN`       | Always (pick one)                      | Vercel personal access token -- for local dev                                                |
| `VERCEL_OIDC_TOKEN`  | Always (pick one) OR for classifier    | Vercel OIDC token -- for CI/CD pipelines, or enables classifier without `AI_GATEWAY_API_KEY` |

The **classifier is optional**: if neither `AI_GATEWAY_API_KEY` nor `VERCEL_OIDC_TOKEN` is set, failure classification is skipped and all results are preserved as-is. Set either key to enable the classifier, which automatically identifies and removes non-model failures (infrastructure errors, rate limits, timeouts).

OpenCode only supports Vercel AI Gateway (`vercel-ai-gateway/opencode`). There is no direct API option for OpenCode.

### Setup

The `init` command generates a `.env.example` file. Copy it and fill in your keys:

```bash
cp .env.example .env
```

The framework loads `.env.local` first, then `.env` as a fallback, via [dotenv](https://github.com/motdotla/dotenv).

### Vercel AI Gateway (recommended)

One key for all models:

```bash
AI_GATEWAY_API_KEY=your-ai-gateway-api-key
VERCEL_TOKEN=your-vercel-token
```

### Direct API keys (no Vercel account required)

If you don't have a Vercel account, use provider API keys directly:

```bash
ANTHROPIC_API_KEY=sk-ant-...      # For Claude Code
OPENAI_API_KEY=sk-proj-...        # For Codex
```

And choose ONE sandbox option (no Vercel key needed):

```bash
# Option 1: Use Docker (free, no account needed)
# Just set sandbox: 'docker' in your experiment config, that's it!

# Option 2: Use Vercel (requires free account)
VERCEL_TOKEN=your-vercel-token
```

#### Minimal setup example

Claude Code via direct API with Docker sandbox:

```typescript
// experiments/my-eval.ts
import type { ExperimentConfig } from '@vercel/agent-eval';

const config: ExperimentConfig = {
  agent: 'claude-code',  // Direct API (not vercel-ai-gateway/...)
  model: 'opus',
  runs: 1,
  sandbox: 'docker',     // No VERCEL_TOKEN needed
};

export default config;
```

Then just set:
```bash
ANTHROPIC_API_KEY=sk-ant-...
```

That's it! The classifier will be disabled (since you don't have `AI_GATEWAY_API_KEY`), but all features work fine — you'll just see a warning that non-model failure classification is skipped.

## Tips

**Start with `--dry`**: Always preview before running to verify your config and avoid unexpected costs.

**Use `--smoke` first**: Verify API keys, model IDs, and sandbox connectivity before launching a full run.

**Use multiple runs**: Single runs don't tell you reliability. Use `runs: 10` and `earlyExit: false` for meaningful data.

**Isolate variables**: Change one thing at a time between experiments. Don't compare "Opus with MCP" to "Haiku without MCP".

**Test incrementally**: Start with simple tasks, add complexity as you learn what works.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow and release process.

## License

MIT
