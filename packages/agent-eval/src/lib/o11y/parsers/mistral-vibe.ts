/**
 * Parser for Mistral Vibe transcript format.
 *
 * Vibe (>=2.10) emits OpenAI-compatible JSONL when invoked with
 * `vibe --prompt ... --output streaming`. Each row is an `LLMMessage`
 * (see `vibe/core/types.py`) with shape:
 *
 *   {"role":"user","content":"...","message_id":"...","injected":false}
 *   {"role":"assistant","content":"...","reasoning_content":"...","tool_calls":[
 *      {"id":"...","type":"function","function":{"name":"write_file","arguments":"<json-string>"}}
 *   ],"message_id":"..."}
 *   {"role":"tool","content":"...","name":"write_file","tool_call_id":"..."}
 *
 * Notes:
 *  - `function.arguments` is a JSON-encoded STRING.
 *  - `content` may be null/empty when the assistant only emits tool calls.
 *  - `reasoning_content` lives as a sibling field on `role:"assistant"` rows.
 *  - `injected:true` marks harness-inserted rows (skip them).
 *  - `role:"user"` / `role:"system"` rows only echo the prompt and are ignored.
 */

import type { TranscriptEvent, ToolName } from '../types.js';

/**
 * Map Vibe native tool names to canonical tool names.
 *
 * Vibe ships no `glob` or `list_dir` tool — models use `bash` for directory
 * ops. `skill` (Vibe's skill-loading tool) is explicitly mapped to `'unknown'`
 * because the canonical `ToolName` union has no skill equivalent — Claude
 * Code's parser handles its `Skill` tool the same way. Regenerate this map
 * per Vibe minor release.
 */
const VIBE_TOOL_MAP: Record<string, ToolName> = {
  read_file: 'file_read',
  write_file: 'file_write',
  search_replace: 'file_edit',
  bash: 'shell',
  grep: 'grep',
  web_fetch: 'web_fetch',
  web_search: 'web_search',
  todo: 'agent_task',
  task: 'agent_task',
  skill: 'unknown',
};

function canonicalToolName(rawName: string): ToolName {
  // Defensive: strip a `functions.` prefix in case an upstream gateway adds it.
  const stripped = rawName.replace(/^functions\./, '');
  return VIBE_TOOL_MAP[stripped] || 'unknown';
}

/**
 * Parse the JSON-encoded `function.arguments` string into an object.
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

/**
 * Extract file path from Vibe tool arguments.
 * `search_replace` uses `file_path`; `read_file`/`write_file` use `path`.
 */
function extractFilePath(args: Record<string, unknown>): string | undefined {
  return (args.path || args.file_path || args.filePath || args.file) as string | undefined;
}

/**
 * Extract command from shell tool arguments.
 */
function extractCommand(args: Record<string, unknown>): string | undefined {
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  return undefined;
}

/**
 * Extract URL from web_fetch tool arguments.
 */
function extractUrl(args: Record<string, unknown>): string | undefined {
  return (args.url || args.uri) as string | undefined;
}

interface PendingToolCall {
  originalName: string;
  canonicalName: ToolName;
}

/**
 * Parse a single JSONL line from a Vibe transcript.
 */
function parseVibeLine(
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

  // Skip harness-injected rows.
  if (data.injected === true) return events;

  const role = data.role as string | undefined;

  if (role === 'assistant') {
    // Reasoning content emitted as a separate `thinking` event (matches Claude Code/Codex convention).
    const reasoning = data.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.trim()) {
      events.push({
        type: 'thinking',
        content: reasoning,
        raw: data,
      });
    }

    // Assistant message may carry both content and tool_calls. Emit message first, then each tool_call.
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

        events.push({
          type: 'tool_call',
          tool: {
            name: canonicalName,
            originalName: rawName,
            args,
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
    const fallbackName = typeof data.name === 'string' ? data.name : 'unknown';
    const content = typeof data.content === 'string' ? data.content : '';

    // Vibe's role:"tool" rows have no explicit error field. Match common error
    // prefixes after trimming leading whitespace; substring-match would false-positive
    // on legitimate output containing the words "error" or "failed".
    const lower = content.toLowerCase().trimStart();
    const errorPrefixes = ['error:', 'error ', 'failed:', 'failed ', 'traceback', 'exception:', 'fatal:'];
    const success = !errorPrefixes.some((p) => lower.startsWith(p));

    events.push({
      type: 'tool_result',
      tool: {
        name: pendingCall?.canonicalName || canonicalToolName(fallbackName),
        originalName: pendingCall?.originalName || fallbackName,
        result: content,
        success,
      },
      raw: data,
    });

    if (id) pending.delete(id);
    return events;
  }

  // Ignore user/system rows — they only echo the prompt.
  return events;
}

/**
 * Parse Mistral Vibe JSONL transcript into normalized events.
 */
export function parseMistralVibeTranscript(raw: string): {
  events: TranscriptEvent[];
  errors: string[];
} {
  const events: TranscriptEvent[] = [];
  const errors: string[] = [];
  const pending = new Map<string, PendingToolCall>();

  const lines = raw.split('\n').filter((line) => line.trim());

  for (const line of lines) {
    try {
      const lineEvents = parseVibeLine(line, pending);
      events.push(...lineEvents);
    } catch (e) {
      errors.push(`Failed to parse line: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Post-process: extract metadata into tool args for the summary generator.
  for (const event of events) {
    if (event.type === 'tool_call' && event.tool) {
      const args = event.tool.args || {};

      if (['file_read', 'file_write', 'file_edit'].includes(event.tool.name)) {
        const path = extractFilePath(args);
        if (path) {
          event.tool.args = { ...args, _extractedPath: path };
        }
      }

      if (event.tool.name === 'web_fetch') {
        const url = extractUrl(args);
        if (url) {
          event.tool.args = { ...args, _extractedUrl: url };
        }
      }

      if (event.tool.name === 'shell') {
        const command = extractCommand(args);
        if (command) {
          event.tool.args = { ...args, _extractedCommand: command };
        }
      }
    }
  }

  return { events, errors };
}
