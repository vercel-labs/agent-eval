import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createSandbox } = vi.hoisted(() => ({ createSandbox: vi.fn() }));
vi.mock('../sandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sandbox.js')>()),
  createSandbox,
}));

import { runWithDefinition } from './plugin/orchestrator.js';
import { LocalSandbox } from './plugin/local-sandbox.test-support.js';
import { createFxDefinition } from './fx/agent.js';
import { fxUsage } from './fx/run.mjs';
import type { AgentDefinition } from './plugin/contract.js';

describe('fxUsage', () => {
  it('maps fx ask JSON usage, keeping only the counts fx reported', () => {
    expect(fxUsage({ usage: { input_tokens: 1200, output_tokens: 450 } })).toEqual({
      inputTokens: 1200,
      outputTokens: 450,
      totalTokens: 1650,
    });
    expect(fxUsage({ usage: { input_tokens: 1200, output_tokens: null } })).toEqual({ inputTokens: 1200 });
    expect(fxUsage({ usage: { input_tokens: null, output_tokens: null } })).toBeUndefined();
    expect(fxUsage({ output: 'no usage field' })).toBeUndefined();
    expect(fxUsage(null)).toBeUndefined();
  });
});

/**
 * Runs the real fx runner (run.mjs) end to end in a local sandbox, against a
 * stand-in `fx` binary that answers `fx ask --json` and `fx session --json` the
 * way fx does. The saved session, which becomes the transcript, carries no
 * consumed-token counts, so usage has to come from the ask result.
 */
describe('fx token usage', () => {
  let workDir: string;
  let fixtureDir: string;
  let sandboxes: LocalSandbox[];

  const ASK_RESULT = JSON.stringify({
    output: 'Done',
    final_output: 'Done',
    exit_code: 0,
    model: 'openai/gpt-5.6-sol',
    resolved_provider: null,
    session_id: 'ses-1',
    steps: 2,
    usage: { input_tokens: 1200, output_tokens: 450 },
    tool_calls: [],
  });
  const SESSION = JSON.stringify({
    kind: 'session_detail',
    id: 'ses-1',
    history: [
      {
        kind: 'assistant',
        user: { text: 'Find the docs', images: [] },
        assistant: 'Done',
        execution: { schema_version: 2, tool_steps: [], files: [] },
      },
    ],
  });

  /** The fx definition with its network installs replaced by local stand-ins. */
  const localFx = (): AgentDefinition => {
    const fakeFx = join(workDir, 'fx');
    writeFileSync(
      fakeFx,
      `#!/bin/sh\nif [ "$1" = "ask" ]; then echo '${ASK_RESULT}'; else echo '${SESSION}'; fi\n`
    );
    const fakeVitest = join(workDir, 'vitest');
    // Reports what EVAL.ts would read from __agent_eval__/results.json.
    writeFileSync(fakeVitest, '#!/bin/sh\ncat __agent_eval__/results.json\n');
    return {
      ...createFxDefinition(),
      install: () => [
        {
          kind: 'shell',
          script: [
            'mkdir -p __agent_eval__/bin node_modules/.bin node_modules/vitest',
            `cp '${fakeFx}' __agent_eval__/bin/fx && chmod +x __agent_eval__/bin/fx`,
            `cp '${fakeVitest}' node_modules/.bin/vitest && chmod +x node_modules/.bin/vitest`,
            `echo '{"name":"vitest"}' > node_modules/vitest/package.json`,
          ].join(' && '),
          errorPrefix: 'stand-in install failed',
          errorBody: 'last10',
        },
      ],
    };
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'agent-eval-fx-usage-'));
    fixtureDir = join(workDir, 'fixture');
    mkdirSync(fixtureDir);
    writeFileSync(join(fixtureDir, 'package.json'), '{"name":"fixture"}');
    writeFileSync(join(fixtureDir, 'EVAL.ts'), "import { test } from 'vitest';\ntest('ok', () => {});\n");
    sandboxes = [];
    createSandbox.mockImplementation(async () => {
      const sandbox = new LocalSandbox();
      sandboxes.push(sandbox);
      return sandbox;
    });
  });

  afterEach(() => {
    for (const sandbox of sandboxes) sandbox.dispose();
    rmSync(workDir, { recursive: true, force: true });
    createSandbox.mockReset();
  });

  it('reports the ask result usage on the run and to EVAL.ts, though the transcript is the saved session', async () => {
    const result = await runWithDefinition(localFx(), fixtureDir, {
      prompt: 'Find the docs',
      timeout: 60_000,
      apiKey: 'local-test-api-key-0123456789',
      webResearch: true,
    });

    const expected = { inputTokens: 1200, outputTokens: 450, totalTokens: 1650 };
    expect(result.transcript).toContain('"session_detail"');
    expect(result.usage).toEqual(expected);
    const context = JSON.parse(result.testResult!.output);
    expect(context.o11y.usage).toEqual(expected);
  });
});
