import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createSandbox } = vi.hoisted(() => ({ createSandbox: vi.fn() }));
vi.mock('../sandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sandbox.js')>()),
  createSandbox,
}));

import { runWithDefinition } from './plugin/orchestrator.js';
import { LocalSandbox } from './plugin/local-sandbox.test-support.js';
import { createCodexDefinition } from './codex/agent.js';
import { TRANSCRIPT_CONTEXT_PATH } from './shared.js';
import type { AgentDefinition } from './plugin/contract.js';
import type { AgentRunResult } from './types.js';
import { agentResultToEvalRunData, createEvalSummary, createExperimentResults, saveResults } from '../results.js';
import type { RunnableExperimentConfig } from '../types.js';
import { CODEX_THREAD_ID, codexExecJsonl, codexLegacySessionJsonl, codexSessionJsonl, jsonl } from '../o11y/codex-transcripts.test-support.js';

/** What the stand-in `codex exec` does for the task prompt (the shell canary always succeeds). */
interface Scenario {
  /** Printed on stdout, as `codex exec --json` does. */
  stdout?: string;
  /** Written to ~/.codex/sessions, as Codex saves every session it starts. */
  session?: string;
  /** Other files created during the task, including child-agent sessions. */
  otherSessions?: Record<string, string>;
  stderr?: string;
  exitCode?: number;
}

/**
 * Runs the real Codex runner (run.mjs) and orchestrator end to end in a local
 * sandbox, against a stand-in `codex` binary. Check the activity available in
 * both sources and the artifacts consumers receive on fallback and failure.
 */
describe('Codex transcript sources', () => {
  let workDir: string;
  let fixtureDir: string;
  let sandboxes: LocalSandbox[];

  /** The Codex definition with its network installs replaced by local stand-ins. */
  const localCodex = (scenario: Scenario): AgentDefinition => {
    const scenarioPath = join(workDir, 'scenario.json');
    writeFileSync(scenarioPath, JSON.stringify(scenario));
    const fakeCodex = join(workDir, 'codex');
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
const fs = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.163.0'); process.exit(0); }
if (args[0] === 'login') { fs.readFileSync(0); process.exit(0); }
const sessions = join(process.env.HOME, '.codex', 'sessions', '2026', '10', '19');
fs.mkdirSync(sessions, { recursive: true });
const nonce = /agent-eval-shell-canary-[0-9a-f]+/.exec(args[args.length - 1]);
if (nonce) {
  const thread = '019a0c55-0000-7000-8000-00000000c0de';
  const item = { id: 'call_echo', type: 'command_execution', command: '/bin/bash -lc ' + "'echo " + nonce[0] + "'", aggregated_output: nonce[0] + '\\n', exit_code: 0, status: 'completed' };
  fs.writeFileSync(join(sessions, 'rollout-2026-10-19T12-00-00-' + thread + '.jsonl'), [
    { type: 'session_meta', payload: { id: thread, source: 'exec', cli_version: '0.163.0', history_mode: 'paginated' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'call_echo', command: ['/bin/bash', '-lc', 'echo ' + nonce[0]], status: 'completed', aggregated_output: nonce[0] + '\\n', exit_code: 0 } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 920 } } } },
  ].map((line) => JSON.stringify(line)).join('\\n'));
  console.log([{ type: 'thread.started', thread_id: thread }, { type: 'item.completed', item }].map((line) => JSON.stringify(line)).join('\\n'));
  process.exit(0);
}
const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, 'utf8'));
if (scenario.session) fs.writeFileSync(join(sessions, 'rollout-2026-10-19T12-00-01-${CODEX_THREAD_ID}.jsonl'), scenario.session);
for (const [name, content] of Object.entries(scenario.otherSessions ?? {})) fs.writeFileSync(join(sessions, name), content);
if (scenario.stdout) process.stdout.write(scenario.stdout + '\\n');
if (scenario.stderr) process.stderr.write(scenario.stderr);
process.exit(scenario.exitCode ?? 0);
`
    );
    const fakeVitest = join(workDir, 'vitest');
    // Reports what EVAL.ts would read from __agent_eval__/results.json.
    writeFileSync(fakeVitest, '#!/bin/sh\ncat __agent_eval__/results.json\n');
    return {
      ...createCodexDefinition({ useVercelAiGateway: true }),
      install: () => [
        {
          kind: 'shell',
          script: [
            'mkdir -p ~/.npm-global/bin node_modules/.bin node_modules/vitest',
            `cp '${fakeCodex}' ~/.npm-global/bin/codex && chmod +x ~/.npm-global/bin/codex`,
            `cp '${fakeVitest}' node_modules/.bin/vitest && chmod +x node_modules/.bin/vitest`,
            `echo '{"name":"vitest"}' > node_modules/vitest/package.json`,
          ].join(' && '),
          errorPrefix: 'stand-in install failed',
          errorBody: 'last10',
        },
      ],
    };
  };

  const run = (scenario: Scenario, model?: string) =>
    runWithDefinition(localCodex(scenario), fixtureDir, {
      prompt: 'Make the failing test pass.',
      model,
      timeout: 60_000,
      apiKey: 'local-test-api-key-0123456789',
    });

  /** Read the file EVAL.ts sees; validation output can also contain npx diagnostics. */
  const evalContext = (result: AgentRunResult) => {
    expect(result.testResult?.success).toBe(true);
    const sandbox = sandboxes.find((entry) => entry.sandboxId === result.sandboxId)!;
    return JSON.parse(readFileSync(join(sandbox.getWorkingDirectory(), TRANSCRIPT_CONTEXT_PATH), 'utf-8'));
  };

  /** The run's result.json and transcript.json as saveResults writes them. */
  const saved = (result: AgentRunResult) => {
    const config: RunnableExperimentConfig = {
      agent: 'vercel-ai-gateway/codex',
      model: 'openai/gpt-5.2-codex',
      evals: ['fixture'],
      runs: 1,
      earlyExit: true,
      scripts: [],
      validation: 'vitest',
      timeout: 60,
      sandbox: 'auto',
      copyFiles: 'none',
    };
    const runData = agentResultToEvalRunData(result, { o11yAgentName: 'codex' });
    const experiment = createExperimentResults(config, [createEvalSummary('fixture', [runData])], new Date(0), new Date(1));
    const dir = join(saveResults(experiment, { resultsDir: join(workDir, 'results'), experimentName: 'codex' }), 'fixture', 'run-1');
    const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf-8'));
    return {
      result: read('result.json'),
      transcript: runData.transcript ? read('transcript.json') : undefined,
      rawTranscript: runData.transcript ? readFileSync(join(dir, 'transcript-raw.jsonl'), 'utf-8') : undefined,
    };
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'agent-eval-codex-transcript-'));
    fixtureDir = join(workDir, 'fixture');
    mkdirSync(fixtureDir);
    writeFileSync(join(fixtureDir, 'package.json'), '{"name":"fixture"}');
    writeFileSync(join(fixtureDir, 'EVAL.ts'), "import { test } from 'vitest';\ntest('ok', () => {});\n");
    sandboxes = [];
    createSandbox.mockImplementation(async () => {
      // userBinFirst puts ~/.npm-global/bin first on PATH, so the stand-in
      // shadows any real codex on the host.
      const sandbox = new LocalSandbox({ userBinFirst: true });
      sandboxes.push(sandbox);
      return sandbox;
    });
  });

  afterEach(() => {
    for (const sandbox of sandboxes) sandbox.dispose();
    rmSync(workDir, { recursive: true, force: true });
    createSandbox.mockReset();
  });

  it('reports the same activity whether the transcript came from stdout or the saved session', async () => {
    const fromStdout = await run({ stdout: codexExecJsonl(), session: codexSessionJsonl() }, 'openai/gpt-5.2-codex');
    const fromSession = await run({ session: codexSessionJsonl(), stderr: 'codex: no JSONL on stdout\n' }, 'openai/gpt-5.2-codex');

    expect(fromStdout.provenance?.agentCliVersion).toBe('codex-cli 0.163.0');
    expect(fromStdout.transcript).toBe(codexExecJsonl());
    // The fallback keeps the raw session file as the transcript.
    expect(fromSession.transcript).toBe(codexSessionJsonl());

    // What EVAL.ts reads from __agent_eval__/results.json.
    const stdoutContext = evalContext(fromStdout);
    const sessionContext = evalContext(fromSession);
    expect(stdoutContext.o11y).toMatchObject({
      totalTurns: 1,
      totalToolCalls: 3,
      shellCommands: [
        { command: '/bin/bash -lc ls', exitCode: 0, success: true },
        { command: `/bin/bash -lc "sed -n '1,20p' src/sum.test.js"`, exitCode: 0, success: true },
        { command: "/bin/bash -lc 'npm test'", exitCode: 1, success: false },
      ],
      usage: { inputTokens: 315, outputTokens: 122, cacheReadTokens: 24448, totalTokens: 24885 },
    });
    expect(stdoutContext.usage).toEqual(stdoutContext.o11y.usage);
    expect(sessionContext).toEqual(stdoutContext);

    // What saveResults writes.
    const stdoutSaved = saved(fromStdout);
    const sessionSaved = saved(fromSession);
    expect(sessionSaved.result.o11y).toEqual(stdoutSaved.result.o11y);
    expect(sessionSaved.result.usage).toEqual(stdoutSaved.result.usage);
    expect(sessionSaved.transcript.summary).toEqual(stdoutSaved.transcript.summary);
    expect(sessionSaved.transcript.parseSuccess).toBe(true);
  });

  it('keeps a legacy session and its usage without publishing unsupported activity', async () => {
    const raw = codexLegacySessionJsonl();
    const result = await run({ session: raw }, 'openai/gpt-5.2-codex');
    const context = evalContext(result);
    const stored = saved(result);
    const usage = {
      inputTokens: 315,
      outputTokens: 122,
      cacheReadTokens: 24448,
      cacheWriteTokens: 0,
      reasoningTokens: 64,
      totalTokens: 24885,
    };

    expect.soft(context).toEqual({ o11y: null, usage });
    expect.soft(stored.result).not.toHaveProperty('o11y');
    expect(stored.result.usage).toEqual(usage);
    expect(stored.transcript.parseSuccess).toBe(false);
    expect(stored.transcript.parseErrors).toEqual([expect.stringContaining('legacy history mode')]);
    expect(stored.rawTranscript).toBe(raw);
  });

  it.each([0, 1])('captures the task session after the canary when exec exits with %i', async (exitCode) => {
    const raw = codexSessionJsonl();
    const result = await run({ session: raw, exitCode, stderr: exitCode ? 'task failed\n' : undefined });
    const stored = saved(result);

    expect(result.success).toBe(exitCode === 0);
    expect(result.transcript).toBe(raw);
    expect(result.observedModel).toBe('gpt-5.2-codex');
    expect(stored.result.o11y).toMatchObject({ totalTurns: 1, totalToolCalls: 3 });
    // The canary reports 920 tokens; these counts belong to the task itself.
    expect(stored.result.usage.totalTokens).toBe(24885);
    expect(stored.rawTranscript).toBe(raw);
    expect(stored.transcript.parseSuccess).toBe(true);
  });

  it("does not report the shell canary's session as the transcript of a run that saved none", async () => {
    // A native-default run first verifies the shell tool with a canary exec,
    // which saves its own session. The task exec then fails before printing
    // anything or saving a session.
    const result = await run({ stderr: 'Error: could not start the thread\n', exitCode: 1 });

    expect(result.success).toBe(false);
    expect(result.transcript).toBeUndefined();
    const { result: savedResult } = saved(result);
    expect(savedResult.o11y).toBeUndefined();
    expect(savedResult.usage).toBeUndefined();
  });

  const childSession = JSON.stringify({
    type: 'session_meta',
    payload: {
      id: 'child-thread', history_mode: 'paginated',
      source: { subagent: { thread_spawn: { parent_thread_id: CODEX_THREAD_ID, depth: 1 } } },
    },
  });

  it('selects the parent exec session regardless of child filenames or malformed files', async () => {
    const raw = codexSessionJsonl();
    const result = await run({
      session: raw,
      otherSessions: {
        'rollout-2026-10-19T12-00-00-child.jsonl': childSession,
        'rollout-2026-10-19T12-00-02-child.jsonl': childSession,
        'rollout-2026-10-19T12-00-03-incomplete.jsonl': '{"type":"session_meta",',
      },
    });

    expect(result.transcript).toBe(raw);
    expect(evalContext(result).o11y.totalToolCalls).toBe(3);
    expect(saved(result).result.usage.totalTokens).toBe(24885);
  });

  it.each([
    { name: 'only a child session', session: undefined, other: childSession },
    { name: 'multiple exec sessions', session: codexSessionJsonl(), other: codexSessionJsonl('another-thread') },
    { name: 'an unknown session source', session: undefined, other: '{"type":"session_meta","payload":{"id":"unknown"}}' },
  ])('does not guess a parent transcript with $name', async ({ session, other }) => {
    const result = await run({ session, otherSessions: { 'rollout-2026-10-19T12-00-02-other.jsonl': other } });

    expect(result.transcript).toBeUndefined();
    expect(evalContext(result).o11y).toBeNull();
    expect(saved(result).result).not.toHaveProperty('o11y');
  });

  it('uses the stdout thread id when multiple exec sessions exist', async () => {
    const raw = codexSessionJsonl();
    const result = await run({
      stdout: codexExecJsonl(), session: raw,
      otherSessions: { 'rollout-2026-10-19T12-00-02-other.jsonl': codexSessionJsonl('another-thread').replaceAll('gpt-5.2-codex', 'other-model') },
    });

    expect(result.transcript).toBe(codexExecJsonl());
    expect(result.observedModel).toBe('gpt-5.2-codex');
  });

  it('masks recognizable command secrets in both summaries while retaining the source transcript', async () => {
    // Synthetic credential not provided to the framework's exact-value redactor.
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123';
    const raw = jsonl(
      { type: 'session_meta', payload: { id: CODEX_THREAD_ID, source: 'exec', history_mode: 'paginated' } },
      { type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'CommandExecution', id: 'cmd', command: ['true', secret],
        status: 'completed', exit_code: 0, aggregated_output: '',
      } } },
    );
    const result = await run({ session: raw }, 'openai/gpt-5.2-codex');
    const stored = saved(result);
    const expected = [{ command: 'true [REDACTED_SECRET]', exitCode: 0, success: true }];

    expect(evalContext(result).o11y.shellCommands).toEqual(expected);
    expect(stored.result.o11y.shellCommands).toEqual(expected);
    expect(stored.transcript.summary.shellCommands).toEqual(expected);
    expect(stored.rawTranscript).toBe(raw);
  });
});
