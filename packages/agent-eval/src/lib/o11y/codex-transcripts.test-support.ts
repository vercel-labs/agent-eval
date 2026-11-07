/**
 * Test support: one `codex exec` run, written out in both transcript formats
 * the Codex runner can hand back.
 *
 *   - `codexExecJsonl` is what `codex exec --json` prints on stdout, the
 *     runner's preferred transcript.
 *   - `codexSessionJsonl` is the saved session file under `~/.codex/sessions`
 *     for the same run, the runner's fallback transcript.
 *
 * Both are synthetic and sanitized, not captured: ids, paths, output, and
 * encrypted reasoning are placeholders. Every record follows the serde
 * definitions in openai/codex at rust-v0.148.0 and rust-v0.163.0
 * (exec/src/exec_events.rs and event_processor_with_jsonl_output.rs for
 * stdout; protocol/src/{protocol,items,models}.rs and rollout/src/policy.rs
 * for the session file), and the session's record order and key sets match
 * sessions written by Codex 0.153 to 0.163.
 *
 * Since 0.148, `codex exec` writes its session in paginated history mode, so
 * each completed item is saved twice: as an `event_msg` `item_completed`
 * TurnItem, the same item stdout prints as `item.completed`, and as the raw
 * `response_item` the model saw. `codexLegacySessionJsonl` is a session from
 * 0.147 or earlier (legacy history mode, per rollout/src/policy.rs at
 * rust-v0.144.0), which has the `response_item` copies only.
 */

export const CODEX_THREAD_ID = '019a0c55-5a3e-7d42-9b1f-3c2e8a7d6f10';
export const CODEX_PROMPT = 'Make the failing test pass.';
export const CODEX_FINAL_MESSAGE = '`npm test` fails: `sum(1, 2)` returns -1 because `sum` subtracts.';

const CWD = '/vercel/sandbox';
const TURN_ID = 'turn-1';
const REASONING = '**Inspecting the test setup**';

/** The three commands of the run: argv as Codex ran it, and what stdout prints for it. */
const COMMANDS = [
  {
    id: 'call_ls',
    argv: ['/bin/bash', '-lc', 'ls'],
    printed: '/bin/bash -lc ls',
    parsed: [{ type: 'list_files', cmd: 'ls', path: null }],
    output: 'package.json\nsrc\n',
    exitCode: 0,
  },
  {
    id: 'call_sed',
    argv: ['/bin/bash', '-lc', "sed -n '1,20p' src/sum.test.js"],
    printed: `/bin/bash -lc "sed -n '1,20p' src/sum.test.js"`,
    parsed: [{ type: 'read', cmd: "sed -n '1,20p' src/sum.test.js", name: 'sum.test.js', path: 'src/sum.test.js' }],
    output: "import { sum } from './sum.js';\ntest('adds', () => expect(sum(1, 2)).toBe(3));\n",
    exitCode: 0,
  },
  {
    id: 'call_test',
    argv: ['/bin/bash', '-lc', 'npm test'],
    printed: "/bin/bash -lc 'npm test'",
    parsed: [{ type: 'unknown', cmd: 'npm test' }],
    output: '> test\n> node --test\n\n1 failing\n',
    exitCode: 1,
  },
] as const;

/** `codex exec --json` stdout reports usage without total_tokens; the session's totals include it. */
const USAGE = {
  input_tokens: 24763,
  cached_input_tokens: 24448,
  cache_write_input_tokens: 0,
  output_tokens: 122,
  reasoning_output_tokens: 64,
};
const TOTAL_USAGE = { ...USAGE, total_tokens: USAGE.input_tokens + USAGE.output_tokens };

export const jsonl = (...records: unknown[]): string => records.map((record) => JSON.stringify(record)).join('\n');

/** stdout of `codex exec --json` for the run. */
export function codexExecJsonl(threadId = CODEX_THREAD_ID): string {
  const commandItem = (n: number, command: (typeof COMMANDS)[number], done: boolean) => ({
    id: `item_${n}`,
    type: 'command_execution',
    command: command.printed,
    aggregated_output: done ? command.output : '',
    exit_code: done ? command.exitCode : null,
    status: done ? (command.exitCode === 0 ? 'completed' : 'failed') : 'in_progress',
  });
  return jsonl(
    { type: 'thread.started', thread_id: threadId },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: REASONING } },
    ...COMMANDS.flatMap((command, i) => [
      { type: 'item.started', item: commandItem(i + 1, command, false) },
      { type: 'item.completed', item: commandItem(i + 1, command, true) },
    ]),
    // The second reasoning item has an empty summary, so stdout skips it.
    { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: CODEX_FINAL_MESSAGE } },
    { type: 'turn.completed', usage: USAGE },
  );
}

const at = (second: number) => `2026-10-19T12:00:${String(second).padStart(2, '0')}.000Z`;
const record = (second: number, type: string, payload: Record<string, unknown>) => ({ timestamp: at(second), type, payload });
const message = (role: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: 'message',
  role,
  content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  ...extra,
});
const tokenCount = (second: number, total: Record<string, number>) =>
  record(second, 'event_msg', {
    type: 'token_count',
    info: { total_token_usage: total, last_token_usage: total, model_context_window: 272000 },
    rate_limits: null,
  });
const sessionMeta = (threadId: string, cliVersion: string, extra: Record<string, unknown> = {}) =>
  record(0, 'session_meta', {
    id: threadId,
    timestamp: at(0),
    cwd: CWD,
    originator: 'codex_exec',
    cli_version: cliVersion,
    source: 'exec',
    model_provider: 'vercel',
    ...extra,
  });
/** What Codex sends the model ahead of the prompt: instructions, then the environment. */
const turnPreamble = (second: number) => [
  record(second, 'response_item', message('developer', '<permissions instructions>sanitized</permissions instructions>')),
  record(second, 'response_item', message('user', `<environment_context>\n  <cwd>${CWD}</cwd>\n  <shell>bash</shell>\n</environment_context>`)),
  record(second, 'turn_context', {
    turn_id: TURN_ID,
    cwd: CWD,
    model: 'gpt-5.2-codex',
    effort: 'medium',
    summary: 'auto',
    approval_policy: 'never',
    sandbox_policy: { type: 'danger-full-access' },
  }),
  record(second, 'response_item', message('user', CODEX_PROMPT)),
];
const execCommandCall = (second: number, command: (typeof COMMANDS)[number]) =>
  record(second, 'response_item', {
    type: 'function_call',
    name: 'exec_command',
    arguments: JSON.stringify({ cmd: command.argv[2], max_output_tokens: 10000 }),
    call_id: command.id,
  });
const execCommandOutput = (second: number, command: (typeof COMMANDS)[number]) =>
  record(second, 'response_item', {
    type: 'function_call_output',
    call_id: command.id,
    output: `Chunk ID: 4f1c2a\nWall time: 0.0210 seconds\nProcess exited with code ${command.exitCode}\nOriginal token count: 12\nOutput:\n${command.output}`,
  });

/** The saved session file (`~/.codex/sessions/.../rollout-*.jsonl`) for the run, as Codex 0.148+ writes it. */
export function codexSessionJsonl(threadId = CODEX_THREAD_ID): string {
  let second = 0;
  const completed = (item: Record<string, unknown>) =>
    record(++second, 'event_msg', {
      type: 'item_completed',
      thread_id: threadId,
      turn_id: TURN_ID,
      item,
      started_at_ms: Date.parse(at(second)) - 20,
      completed_at_ms: Date.parse(at(second)),
    });
  return jsonl(
    sessionMeta(threadId, '0.163.0', { history_mode: 'paginated' }),
    record(0, 'event_msg', { type: 'task_started', turn_id: TURN_ID, model_context_window: 272000 }),
    ...turnPreamble(0),
    completed({ type: 'UserMessage', id: 'user_1', content: [{ type: 'text', text: CODEX_PROMPT, text_elements: [] }] }),
    completed({ type: 'Reasoning', id: 'rs_1', summary_text: [REASONING], raw_content: [] }),
    record(second, 'response_item', {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: REASONING }],
      encrypted_content: 'gAAAAA-sanitized',
    }),
    ...COMMANDS.flatMap((command) => [
      execCommandCall(second, command),
      completed({
        type: 'CommandExecution',
        id: command.id,
        command: command.argv,
        cwd: CWD,
        parsed_cmd: command.parsed,
        source: 'unified_exec_startup',
        status: command.exitCode === 0 ? 'completed' : 'failed',
        aggregated_output: command.output,
        exit_code: command.exitCode,
        duration: { secs: 0, nanos: 21000000 },
      }),
      execCommandOutput(second, command),
      tokenCount(second, TOTAL_USAGE),
    ]),
    completed({ type: 'Reasoning', id: 'rs_2', summary_text: [], raw_content: [] }),
    record(second, 'response_item', { type: 'reasoning', summary: [], encrypted_content: 'gAAAAA-sanitized' }),
    completed({ type: 'AgentMessage', id: 'msg_1', content: [{ type: 'Text', text: CODEX_FINAL_MESSAGE }], phase: 'final_answer' }),
    record(second, 'response_item', message('assistant', CODEX_FINAL_MESSAGE, { phase: 'final_answer' })),
    record(second, 'token_usage_record', { thread_id: threadId, turn_id: TURN_ID, usage: TOTAL_USAGE, thread_token_usage: TOTAL_USAGE }),
    tokenCount(second, TOTAL_USAGE),
    record(second, 'event_msg', { type: 'task_complete', turn_id: TURN_ID, last_agent_message: CODEX_FINAL_MESSAGE }),
  );
}

/** The same run's session as Codex 0.147 and earlier wrote it (legacy history mode). */
export function codexLegacySessionJsonl(threadId = CODEX_THREAD_ID, error?: string): string {
  const [ls] = COMMANDS;
  return jsonl(
    sessionMeta(threadId, '0.147.0'),
    record(0, 'event_msg', { type: 'task_started', turn_id: TURN_ID, model_context_window: 272000 }),
    ...turnPreamble(0),
    record(1, 'event_msg', { type: 'user_message', message: CODEX_PROMPT, images: [] }),
    record(2, 'response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: REASONING }], encrypted_content: 'gAAAAA-sanitized' }),
    record(2, 'event_msg', { type: 'agent_reasoning', text: REASONING }),
    execCommandCall(3, ls),
    execCommandOutput(3, ls),
    record(4, 'response_item', message('assistant', CODEX_FINAL_MESSAGE, { phase: 'final_answer' })),
    record(4, 'event_msg', { type: 'agent_message', message: CODEX_FINAL_MESSAGE, phase: 'final_answer' }),
    tokenCount(4, TOTAL_USAGE),
    record(4, 'event_msg', {
      type: 'task_complete', turn_id: TURN_ID, last_agent_message: CODEX_FINAL_MESSAGE,
      ...(error ? { error: { message: error, codex_error_info: 'other' } } : {}),
    }),
  );
}
