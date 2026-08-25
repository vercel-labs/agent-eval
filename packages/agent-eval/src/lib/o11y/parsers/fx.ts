/** Parser for the supported `fx session --id <id> --json` projection. */

import type { ToolName, TranscriptEvent } from '../types.js';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseJsonObject(value: unknown): JsonRecord {
  return asRecord(parseJsonValue(value)) ?? {};
}

function timestamp(value: unknown): string | undefined {
  const milliseconds = asNumber(value);
  return milliseconds === undefined ? undefined : new Date(milliseconds).toISOString();
}

function normalizeToolName(name: string): ToolName {
  const names: Record<string, ToolName> = {
    read_file: 'file_read',
    file_info: 'file_read',
    write_file: 'file_write',
    create_folder: 'file_write',
    copy_file: 'file_write',
    edit_file: 'file_edit',
    delete_file: 'file_edit',
    rename_file: 'file_edit',
    terminal: 'shell',
    run_command: 'shell',
    web_fetch: 'web_fetch',
    web_search: 'web_search',
    glob_files: 'glob',
    grep_files: 'grep',
    semantic_search: 'grep',
    list_files: 'list_dir',
    subagent: 'agent_task',
  };
  return names[name.toLowerCase()] ?? 'unknown';
}

function extractFilePath(args: JsonRecord): string | undefined {
  for (const key of ['path', 'file_path', 'old_path', 'source', 'destination']) {
    const value = asString(args[key]);
    if (value) return value;
  }
  return undefined;
}

function normalizeToolArgs(name: ToolName, args: JsonRecord, evidencePath?: string): JsonRecord {
  const normalized = { ...args };
  const request = asRecord(args.request) ?? args;

  if (name === 'shell') {
    const command = asString(request.command);
    if (command) normalized._extractedCommand = command;
  }
  if (name === 'web_fetch') {
    const url = asString(args.url);
    if (url) normalized._extractedUrl = url;
  }
  if (name === 'file_read' || name === 'file_write' || name === 'file_edit') {
    const path = extractFilePath(args) ?? evidencePath;
    if (path) normalized._extractedPath = path;
  }

  return normalized;
}

function extractExitCode(output: string, parsed: unknown): number | undefined {
  const parsedRecord = asRecord(parsed);
  const error = asRecord(parsedRecord?.error);
  const details = asRecord(error?.details);
  const structured = asNumber(details?.exit_code) ?? asNumber(parsedRecord?.exit_code);
  if (structured !== undefined) return structured;

  const match = output.match(/(?:^|\n)exit_code=(-?\d+)/);
  return match ? Number(match[1]) : undefined;
}

function normalizeToolResult(name: ToolName, value: JsonRecord): unknown {
  const output = asString(value.output) ?? '';
  const parsed = parseJsonValue(output);
  if (name !== 'shell') return parsed;

  const exitCode = extractExitCode(output, parsed);
  return exitCode === undefined ? { output } : { output, exitCode };
}

function pushMessage(
  events: TranscriptEvent[],
  role: 'user' | 'assistant' | 'system',
  content: unknown,
): void {
  const text = asString(content);
  if (!text?.trim()) return;
  events.push({ type: 'message', role, content: text });
}

function fileEvidenceByCall(execution: JsonRecord): Map<string, string> {
  const paths = new Map<string, string>();
  const files = Array.isArray(execution.files) ? execution.files : [];
  for (const item of files) {
    const file = asRecord(item);
    const callId = asString(file?.tool_call_id);
    const path = asString(file?.new_path) ?? asString(file?.path);
    if (callId && path && !paths.has(callId)) paths.set(callId, path);
  }
  return paths;
}

function pushExecution(events: TranscriptEvent[], value: unknown): void {
  const execution = asRecord(value);
  if (!execution) return;

  const evidencePaths = fileEvidenceByCall(execution);
  const toolSteps = Array.isArray(execution.tool_steps) ? execution.tool_steps : [];
  for (const item of toolSteps) {
    const step = asRecord(item);
    if (!step) continue;
    pushMessage(events, 'assistant', step.assistant);

    const namesById = new Map<string, { canonical: ToolName; original: string }>();
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    for (const itemCall of calls) {
      const call = asRecord(itemCall);
      const originalName = asString(call?.name);
      if (!call || !originalName) continue;

      const id = asString(call.id);
      const canonical = normalizeToolName(originalName);
      if (id) namesById.set(id, { canonical, original: originalName });
      const args = normalizeToolArgs(
        canonical,
        parseJsonObject(call.arguments_json),
        id ? evidencePaths.get(id) : undefined,
      );
      events.push({
        type: 'tool_call',
        tool: { name: canonical, originalName, args },
        raw: call,
      });
    }

    const results = Array.isArray(step.tool_results) ? step.tool_results : [];
    for (const itemResult of results) {
      const result = asRecord(itemResult);
      if (!result) continue;
      const callId = asString(result.tool_call_id);
      const originalName = asString(result.tool_name) ?? (callId ? namesById.get(callId)?.original : undefined) ?? 'unknown';
      const canonical = normalizeToolName(originalName);
      events.push({
        timestamp: timestamp(result.created_at_ms),
        type: 'tool_result',
        tool: {
          name: canonical,
          originalName,
          result: normalizeToolResult(canonical, result),
          success: result.status === 'success',
        },
        raw: result,
      });
    }
  }
}

function pushSessionTurn(events: TranscriptEvent[], value: unknown): void {
  const turn = asRecord(value);
  if (!turn) return;

  if (turn.kind === 'compacted_summary') {
    pushMessage(events, 'system', turn.summary);
    return;
  }

  const user = asRecord(turn.user);
  pushMessage(events, 'user', user?.text);
  pushExecution(events, turn.execution);
  pushMessage(events, 'assistant', turn.assistant);

  if (turn.kind === 'interrupted') {
    const call = asRecord(turn.tool_call);
    const originalName = asString(call?.name);
    if (call && originalName) {
      const canonical = normalizeToolName(originalName);
      events.push({
        type: 'tool_call',
        tool: {
          name: canonical,
          originalName,
          args: normalizeToolArgs(canonical, parseJsonObject(call.arguments_json)),
        },
        raw: call,
      });
    }
  }
}

function parseSessionDetail(data: JsonRecord): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const history = Array.isArray(data.history) ? data.history : [];
  for (const turn of history) pushSessionTurn(events, turn);
  return events;
}

function parseAskResult(data: JsonRecord): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const calls = Array.isArray(data.tool_calls) ? data.tool_calls : [];
  for (const item of calls) {
    const call = asRecord(item);
    const originalName = asString(call?.name);
    if (!call || !originalName) continue;

    const canonical = normalizeToolName(originalName);
    const commandResult = asRecord(call.command_result);
    const webFetch = asRecord(call.web_fetch);
    const args: JsonRecord = commandResult
      ? { command: commandResult.command, cwd: commandResult.cwd }
      : webFetch
        ? { url: webFetch.url }
        : {};
    events.push({
      type: 'tool_call',
      tool: { name: canonical, originalName, args: normalizeToolArgs(canonical, args) },
      raw: call,
    });

    const result = commandResult
      ? { ...commandResult, exitCode: commandResult.exit_code }
      : call.web_fetch ?? call.web_search;
    events.push({
      type: 'tool_result',
      tool: {
        name: canonical,
        originalName,
        result,
        success: call.status === 'success',
      },
      raw: call,
    });
  }

  pushMessage(events, 'assistant', data.output);
  const error = asString(data.error);
  if (error) events.push({ type: 'error', content: error, raw: data });
  return events;
}

/** Parse fx session detail JSON, with `fx ask --json` as the runner fallback. */
export function parseFxTranscript(raw: string): {
  events: TranscriptEvent[];
  errors: string[];
} {
  if (!raw.trim()) return { events: [], errors: [] };

  let data: JsonRecord | undefined;
  try {
    data = asRecord(JSON.parse(raw));
  } catch (error) {
    return {
      events: [],
      errors: [`Failed to parse fx transcript: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  if (!data) return { events: [], errors: ['Failed to parse fx transcript: expected an object'] };
  if (data.kind === 'session_detail') return { events: parseSessionDetail(data), errors: [] };
  if (typeof data.exit_code === 'number' && Array.isArray(data.tool_calls)) {
    return { events: parseAskResult(data), errors: [] };
  }
  if (data.kind === 'session' && typeof data.error === 'string') {
    return { events: [{ type: 'error', content: data.error, raw: data }], errors: [] };
  }
  return { events: [], errors: ['Failed to parse fx transcript: unknown document shape'] };
}
