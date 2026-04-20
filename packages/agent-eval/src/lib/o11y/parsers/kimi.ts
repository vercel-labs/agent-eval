/**
 * Parser for Kimi CLI transcript format.
 *
 * Kimi CLI emits JSONL when invoked with `--print --output-format stream-json`.
 * Each row is an OpenAI-style chat message:
 *
 *   {"role":"assistant","content":"...","tool_calls":[{"id":"...","type":"function","function":{"name":"WriteFile","arguments":"{...json...}"}}]}
 *   {"role":"tool","content":"...","tool_call_id":"..."}
 *   {"role":"assistant","content":"final message"}
 *
 * `content` may be an empty string when the assistant is only issuing tool calls.
 * `function.arguments` is a JSON string that we parse into an object.
 */

import type { TranscriptEvent, ToolName } from '../types.js';

/**
 * Map Kimi tool names (as exposed by the built-in `default` agent) to canonical
 * observability tool names.
 */
const KIMI_TOOL_MAP: Record<string, ToolName> = {
  ReadFile: 'file_read',
  WriteFile: 'file_write',
  EditFile: 'file_edit',
  ApplyPatch: 'file_edit',
  DeleteFile: 'file_write',
  ListDir: 'list_dir',
  ListDirectory: 'list_dir',
  Glob: 'glob',
  Grep: 'grep',
  Search: 'grep',
  Shell: 'shell',
  Bash: 'shell',
  RunShell: 'shell',
  RunCommand: 'shell',
  WebFetch: 'web_fetch',
  Fetch: 'web_fetch',
  WebSearch: 'web_search',
  Task: 'agent_task',
  TodoWrite: 'agent_task',
  UpdateTodos: 'agent_task',
};

/**
 * Normalize a Kimi tool name to a canonical ToolName. Kimi occasionally prefixes
 * function names with `functions.` — strip that prefix before lookup.
 */
function canonicalToolName(rawName: string): ToolName {
  const stripped = rawName.replace(/^functions\./, '');
  return KIMI_TOOL_MAP[stripped] || 'unknown';
}

/**
 * Safely parse a tool-call `arguments` JSON string. Returns an empty object on
 * failure so downstream summary extraction still works.
 */
function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') {
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function extractFilePath(args: Record<string, unknown>): string | undefined {
  return (args.path || args.filePath || args.file || args.file_path) as string | undefined;
}

function extractCommand(args: Record<string, unknown>): string | undefined {
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  if (typeof args.script === 'string') return args.script;
  return undefined;
}

function extractUrl(args: Record<string, unknown>): string | undefined {
  return (args.url || args.uri) as string | undefined;
}

interface PendingToolCall {
  originalName: string;
  canonicalName: ToolName;
}

function parseKimiLine(
  line: string,
  pending: Map<string, PendingToolCall>
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line);
  } catch {
    return events;
  }

  const role = data.role as string | undefined;

  if (role === 'assistant') {
    const content = data.content;
    if (typeof content === 'string' && content.trim()) {
      events.push({
        type: 'message',
        role: 'assistant',
        content,
        raw: data,
      });
    }

    const toolCalls = data.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        if (!call || typeof call !== 'object') continue;
        const c = call as Record<string, unknown>;
        const id = typeof c.id === 'string' ? c.id : undefined;
        const fn = c.function as Record<string, unknown> | undefined;
        const rawName = typeof fn?.name === 'string' ? fn.name : 'unknown';
        const canonicalName = canonicalToolName(rawName);
        const args = parseToolArgs(fn?.arguments);

        const extracted: Record<string, unknown> = {};
        if (canonicalName === 'file_read' || canonicalName === 'file_write' || canonicalName === 'file_edit') {
          const p = extractFilePath(args);
          if (p) extracted._extractedPath = p;
        }
        if (canonicalName === 'shell') {
          const cmd = extractCommand(args);
          if (cmd) extracted._extractedCommand = cmd;
        }
        if (canonicalName === 'web_fetch') {
          const url = extractUrl(args);
          if (url) extracted._extractedUrl = url;
        }

        events.push({
          type: 'tool_call',
          tool: {
            name: canonicalName,
            originalName: rawName,
            args: { ...args, ...extracted },
          },
          raw: call,
        });

        if (id) pending.set(id, { originalName: rawName, canonicalName });
      }
    }
    return events;
  }

  if (role === 'tool') {
    const id = typeof data.tool_call_id === 'string' ? data.tool_call_id : undefined;
    const pendingCall = id ? pending.get(id) : undefined;
    const content = typeof data.content === 'string' ? data.content : '';
    // Heuristic: Kimi wraps error results in `<system>...</system>` tags that
    // often include the word "error" or "failed". Treat those as failures.
    const lower = content.toLowerCase();
    const success = !(lower.includes('error') || lower.includes('failed'));

    events.push({
      type: 'tool_result',
      tool: {
        name: pendingCall?.canonicalName || 'unknown',
        originalName: pendingCall?.originalName || 'unknown',
        result: content,
        success,
      },
      raw: data,
    });

    if (id) pending.delete(id);
    return events;
  }

  // Ignore user/system rows — they only echo the incoming prompt.
  return events;
}

/**
 * Parse Kimi CLI stream-json output into normalized transcript events.
 */
export function parseKimiTranscript(raw: string): {
  events: TranscriptEvent[];
  errors: string[];
} {
  const events: TranscriptEvent[] = [];
  const errors: string[] = [];
  const pending = new Map<string, PendingToolCall>();

  const lines = raw.split('\n').filter((line) => line.trim());
  for (const line of lines) {
    try {
      events.push(...parseKimiLine(line, pending));
    } catch (e) {
      errors.push(`Failed to parse line: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { events, errors };
}
