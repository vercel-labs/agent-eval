/**
 * Parser for Gemini CLI transcript format.
 * Supports two output formats:
 *
 * 1. CLI format (--output-format stream-json via OpenCode framework):
 *    - Events: step_start, tool_use (with part.tool/part.state), text, step_finish
 *    - Timestamps: epoch milliseconds
 *
 * 2. Direct-API format (custom agent runner):
 *    - Events: init, message (with delta), tool_use (with tool_name/parameters), tool_result
 *    - Timestamps: ISO strings
 */

import type { TranscriptEvent, ToolName } from '../types.js';

/**
 * Map Gemini tool names to canonical names.
 */
function normalizeToolName(name: string): ToolName {
  const toolMap: Record<string, ToolName> = {
    // CLI format tools
    read: 'file_read',
    write: 'file_write',
    edit: 'file_edit',
    bash: 'shell',
    glob: 'glob',

    // Direct-API format tools
    read_file: 'file_read',
    write_file: 'file_write',
    list_directory: 'list_dir',
    run_shell_command: 'shell',

    // Common aliases
    shell: 'shell',
    grep: 'grep',
    ls: 'list_dir',
    search: 'web_search',
    web_search: 'web_search',
    fetch: 'web_fetch',
    web_fetch: 'web_fetch',
  };

  return toolMap[name.toLowerCase()] || 'unknown';
}

/**
 * Convert a timestamp value to ISO string.
 * Handles epoch milliseconds (number) and ISO strings.
 */
function toISO(ts: unknown): string | undefined {
  if (typeof ts === 'number') return new Date(ts).toISOString();
  if (typeof ts === 'string') return ts;
  return undefined;
}

/**
 * Extract file path from tool arguments.
 */
function extractFilePath(args: Record<string, unknown>): string | undefined {
  return (args.path || args.file_path || args.filePath || args.file || args.filename) as
    | string
    | undefined;
}

/**
 * Extract command from tool arguments.
 */
function extractCommand(args: Record<string, unknown>): string | undefined {
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  return undefined;
}

/**
 * Parse a single JSONL line from a Gemini transcript.
 * Handles both CLI and direct-API formats.
 */
function parseGeminiLine(line: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];

  try {
    const data = JSON.parse(line);
    const eventType = data.type;

    // --- CLI format: tool_use with part.tool / part.state ---
    if (eventType === 'tool_use' && data.part?.tool) {
      const part = data.part as Record<string, unknown>;
      const state = part.state as Record<string, unknown> | undefined;
      const name = part.tool as string;
      const args = (state?.input as Record<string, unknown>) || {};
      const output = state?.output;
      const status = state?.status as string | undefined;

      events.push({
        timestamp: toISO(data.timestamp),
        type: 'tool_call',
        tool: {
          name: normalizeToolName(name),
          originalName: name,
          args,
        },
        raw: data,
      });

      if (status === 'completed' && output !== undefined) {
        const metadata = state?.metadata as Record<string, unknown> | undefined;
        const exitCode = metadata?.exit as number | undefined;
        const isShell = normalizeToolName(name) === 'shell';
        const success = isShell
          ? exitCode === 0 || exitCode === undefined
          : status === 'completed' && !state?.error;

        events.push({
          timestamp: toISO(data.timestamp),
          type: 'tool_result',
          tool: {
            name: normalizeToolName(name),
            originalName: name,
            result: output,
            success,
          },
          raw: state,
        });
      }
      return events;
    }

    // --- Direct-API format: tool_use with tool_name / parameters ---
    if (eventType === 'tool_use' && data.tool_name) {
      const name = data.tool_name as string;
      const args = (data.parameters as Record<string, unknown>) || {};

      events.push({
        timestamp: toISO(data.timestamp),
        type: 'tool_call',
        tool: {
          name: normalizeToolName(name),
          originalName: name,
          args,
        },
        raw: data,
      });
      return events;
    }

    // --- Direct-API format: separate tool_result event ---
    if (eventType === 'tool_result') {
      const toolId = data.tool_id as string | undefined;
      // Infer original tool name from tool_id prefix (e.g. "read_file-1770...")
      const originalName = toolId?.split('-')[0] || 'unknown';
      const status = data.status as string | undefined;
      const hasError = status === 'error' || !!data.error;

      events.push({
        timestamp: toISO(data.timestamp),
        type: 'tool_result',
        tool: {
          name: normalizeToolName(originalName),
          originalName,
          result: data.output,
          success: !hasError,
        },
        raw: data,
      });
      return events;
    }

    // --- CLI format: text with part.text ---
    if (eventType === 'text' && data.part?.text) {
      const text = data.part.text as string;
      if (text.trim()) {
        events.push({
          timestamp: toISO(data.timestamp),
          type: 'message',
          role: 'assistant',
          content: text,
          raw: data,
        });
      }
      return events;
    }

    // --- Direct-API format: message with role/content ---
    if (eventType === 'message') {
      const role = data.role as string | undefined;
      const content = data.content as string | undefined;
      if (role && content) {
        events.push({
          timestamp: toISO(data.timestamp),
          type: 'message',
          role: role as 'user' | 'assistant' | 'system',
          content,
          raw: { ...data, _delta: !!data.delta },
        });
      }
      return events;
    }

    // --- Metadata events — skip ---
    // init, step_start, step_finish
  } catch {
    // Skip unparseable lines
  }

  return events;
}

/**
 * Parse Gemini JSONL transcript into normalized events.
 */
export function parseGeminiTranscript(raw: string): {
  events: TranscriptEvent[];
  errors: string[];
} {
  const events: TranscriptEvent[] = [];
  const errors: string[] = [];

  const lines = raw.split('\n').filter((line) => line.trim());

  for (const line of lines) {
    try {
      const lineEvents = parseGeminiLine(line);
      events.push(...lineEvents);
    } catch (e) {
      errors.push(`Failed to parse line: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Post-process: aggregate contiguous assistant delta messages into single events.
  // This avoids inflating turn counts while still counting actual turns.
  const aggregated: TranscriptEvent[] = [];
  for (const event of events) {
    const isDelta = (event.raw as Record<string, unknown>)?._delta === true;
    if (event.type === 'message' && event.role === 'assistant' && isDelta) {
      const prev = aggregated[aggregated.length - 1];
      if (
        prev?.type === 'message' &&
        prev.role === 'assistant' &&
        (prev.raw as Record<string, unknown>)?._delta === true
      ) {
        // Merge into previous delta message
        prev.content = (prev.content || '') + (event.content || '');
        continue;
      }
    }
    aggregated.push(event);
  }

  // Post-process: extract metadata into tool args
  for (const event of aggregated) {
    if (event.type === 'tool_call' && event.tool) {
      const args = event.tool.args || {};

      if (['file_read', 'file_write', 'file_edit'].includes(event.tool.name)) {
        const path = extractFilePath(args);
        if (path) {
          event.tool.args = { ...args, _extractedPath: path };
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

  return { events: aggregated, errors };
}
