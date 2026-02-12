/**
 * Parser for Cursor CLI transcript format.
 * Cursor CLI outputs JSONL events when run with --print.
 *
 * Format reference (based on Cursor CLI output):
 * - Events have "type" + optional "subtype" fields
 * - Tool calls: type "tool_call" with subtype "started"|"completed"
 * - Tool type determined by key name in tool_call object (e.g. readToolCall, shellToolCall)
 * - Timestamps in "timestamp_ms" field (epoch milliseconds)
 * - Messages: type "assistant"|"user" with nested message.content array
 * - Thinking: type "thinking" with subtype "delta"|"completed"
 */

import type { TranscriptEvent, ToolName } from '../types.js';

/**
 * Map Cursor tool call key names to canonical tool names.
 */
const CURSOR_TOOL_MAP: Record<string, ToolName> = {
  readToolCall: 'file_read',
  editToolCall: 'file_edit',
  deleteToolCall: 'file_write',
  lsToolCall: 'list_dir',
  globToolCall: 'glob',
  shellToolCall: 'shell',
  readLintsToolCall: 'unknown',
  updateTodosToolCall: 'agent_task',
  writeToolCall: 'file_write',
  grepToolCall: 'grep',
  searchToolCall: 'web_search',
  fetchToolCall: 'web_fetch',
};

/**
 * Convert epoch milliseconds to ISO string.
 */
function toISO(ms: unknown): string | undefined {
  if (typeof ms === 'number') return new Date(ms).toISOString();
  return undefined;
}

/**
 * Detect the tool key and extract args/result from a Cursor tool_call object.
 */
function extractToolInfo(toolCall: Record<string, unknown>): {
  key: string;
  canonicalName: ToolName;
  args: Record<string, unknown>;
  result: unknown;
} | null {
  for (const key of Object.keys(toolCall)) {
    if (key.endsWith('ToolCall')) {
      const inner = toolCall[key] as Record<string, unknown> | undefined;
      if (!inner) continue;
      return {
        key,
        canonicalName: CURSOR_TOOL_MAP[key] || 'unknown',
        args: (inner.args as Record<string, unknown>) || {},
        result: inner.result,
      };
    }
  }
  return null;
}

/**
 * Extract file path from Cursor tool arguments.
 */
function extractFilePath(args: Record<string, unknown>): string | undefined {
  return (args.path || args.filePath || args.file) as string | undefined;
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
 * Extract text content from a Cursor message content array.
 */
function extractMessageText(
  content: Array<{ type: string; text?: string }> | string | undefined
): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('');
}

/**
 * Parse a single JSONL line from a Cursor transcript.
 */
function parseCursorLine(line: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];

  try {
    const data = JSON.parse(line);
    const eventType = data.type as string;
    const subtype = data.subtype as string | undefined;

    switch (eventType) {
      case 'tool_call': {
        const toolCallObj = data.tool_call as Record<string, unknown> | undefined;
        if (!toolCallObj) break;

        const info = extractToolInfo(toolCallObj);
        if (!info) break;

        if (subtype === 'started') {
          events.push({
            timestamp: toISO(data.timestamp_ms),
            type: 'tool_call',
            tool: {
              name: info.canonicalName,
              originalName: info.key,
              args: info.args,
            },
            raw: data,
          });
        } else if (subtype === 'completed') {
          const resultObj = info.result as Record<string, unknown> | undefined;
          const success = resultObj ? 'success' in resultObj : undefined;
          const error = resultObj ? 'error' in resultObj : false;

          events.push({
            timestamp: toISO(data.timestamp_ms),
            type: 'tool_result',
            tool: {
              name: info.canonicalName,
              originalName: info.key,
              result: info.result,
              success: success === true || (success === undefined && !error),
            },
            raw: data,
          });
        }
        break;
      }

      case 'assistant': {
        const msg = data.message as Record<string, unknown> | undefined;
        if (!msg) break;
        const text = extractMessageText(
          msg.content as Array<{ type: string; text?: string }> | string | undefined
        );
        if (text && text.trim()) {
          events.push({
            timestamp: toISO(data.timestamp_ms),
            type: 'message',
            role: 'assistant',
            content: text,
            raw: data,
          });
        }
        break;
      }

      case 'user': {
        const msg = data.message as Record<string, unknown> | undefined;
        if (!msg) break;
        const text = extractMessageText(
          msg.content as Array<{ type: string; text?: string }> | string | undefined
        );
        if (text && text.trim()) {
          events.push({
            timestamp: toISO(data.timestamp_ms),
            type: 'message',
            role: 'user',
            content: text,
            raw: data,
          });
        }
        break;
      }

      case 'thinking': {
        // Only emit for completed thinking, skip deltas
        if (subtype === 'completed') {
          events.push({
            timestamp: toISO(data.timestamp_ms),
            type: 'thinking',
            content: data.text || '',
            raw: data,
          });
        }
        break;
      }

      case 'system':
      case 'result':
        // Metadata events — skip
        break;

      default:
        break;
    }
  } catch {
    // Skip unparseable lines
  }

  return events;
}

/**
 * Parse Cursor JSONL transcript into normalized events.
 */
export function parseCursorTranscript(raw: string): {
  events: TranscriptEvent[];
  errors: string[];
} {
  const events: TranscriptEvent[] = [];
  const errors: string[] = [];

  const lines = raw.split('\n').filter((line) => line.trim());

  for (const line of lines) {
    try {
      const lineEvents = parseCursorLine(line);
      events.push(...lineEvents);
    } catch (e) {
      errors.push(`Failed to parse line: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Post-process: extract metadata into tool args
  for (const event of events) {
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

  return { events, errors };
}
