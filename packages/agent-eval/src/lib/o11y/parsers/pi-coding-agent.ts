/**
 * Parser for the PI coding agent transcript format (`pi --mode json`).
 *
 * The transcript is JSONL of PI session events. Everything we need rides on
 * `message_end`, whose `message` is one of:
 *   - role 'user'       → the prompt
 *   - role 'assistant'  → content blocks: text | thinking | toolCall
 *   - role 'toolResult' → the result of one toolCall (isError, content blocks)
 *
 * The runner already strips the streaming duplicates (`message_update`,
 * `turn_end`, `agent_end`, …), but they are ignored here too, so a raw
 * unfiltered stream parses to the same events without double counting.
 */

import type { TranscriptEvent, ToolName } from '../types.js';

/**
 * Map PI tool names to canonical names.
 */
function normalizeToolName(name: string): ToolName {
  const toolMap: Record<string, ToolName> = {
    read: 'file_read',
    write: 'file_write',
    edit: 'file_edit',
    bash: 'shell',
    grep: 'grep',
    find: 'glob',
    ls: 'list_dir',
  };

  return toolMap[name.toLowerCase()] || 'unknown';
}

/**
 * Convert PI's epoch-millisecond timestamps to ISO strings.
 */
function toISO(ts: unknown): string | undefined {
  if (typeof ts === 'number') return new Date(ts).toISOString();
  if (typeof ts === 'string') return ts;
  return undefined;
}

/**
 * Join the text blocks of a PI content value (a string or an array of blocks).
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

/**
 * PI's bash tool reports a non-zero exit as a trailing "Command exited with code N"
 * line in the result text, and nothing at all on success — so the suffix only
 * means something on a failed result (a successful command may print that text).
 */
function extractExitCode(text: string, success: boolean): number | undefined {
  if (success) return 0;
  const match = text.match(/Command exited with code (\d+)\s*$/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Move each tool result directly after the call it answers.
 *
 * PI emits one assistant message carrying ALL its tool calls, then the results
 * (`call A, call B, result A, result B`). The shared summary — like the other
 * parsers' output — expects a result to follow its own call, so pair them by
 * PI's toolCallId. Results with no matching call keep their position.
 */
function pairToolResults(events: TranscriptEvent[]): TranscriptEvent[] {
  const ordered: TranscriptEvent[] = [];
  const openCalls = new Map<string, TranscriptEvent>();

  for (const event of events) {
    if (event.type === 'tool_call') {
      const id = (event.raw as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string') openCalls.set(id, event);
    } else if (event.type === 'tool_result') {
      const id = (event.raw as { message?: { toolCallId?: unknown } } | undefined)?.message?.toolCallId;
      const call = typeof id === 'string' ? openCalls.get(id) : undefined;
      if (call) {
        openCalls.delete(id as string);
        ordered.splice(ordered.indexOf(call) + 1, 0, event);
        continue;
      }
    }
    ordered.push(event);
  }

  return ordered;
}

/**
 * Parse a single JSONL line from a PI transcript.
 */
function parsePiLine(line: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];

  try {
    const data = JSON.parse(line);

    if (data.type === 'auto_retry_end' && data.success === false) {
      events.push({
        type: 'error',
        content: (data.finalError as string) || 'PI exhausted its retries',
        raw: data,
      });
      return events;
    }

    if (data.type !== 'message_end' || !data.message) {
      // session, agent/turn lifecycle, tool_execution_*, compaction, streaming
      // deltas — nothing the message_end events don't already carry.
      return events;
    }

    const message = data.message as Record<string, unknown>;
    const timestamp = toISO(message.timestamp);

    if (message.role === 'user') {
      const text = extractText(message.content);
      if (text.trim()) {
        events.push({ timestamp, type: 'message', role: 'user', content: text, raw: data });
      }
      return events;
    }

    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          events.push({ timestamp, type: 'thinking', content: block.thinking, raw: block });
        } else if (block?.type === 'toolCall') {
          const name = (block.name as string) || 'unknown';
          events.push({
            timestamp,
            type: 'tool_call',
            tool: {
              name: normalizeToolName(name),
              originalName: name,
              args: (block.arguments as Record<string, unknown>) || {},
            },
            raw: block,
          });
        }
      }

      // One message event per assistant message (= one turn), even when it only
      // carries tool calls.
      events.push({
        timestamp,
        type: 'message',
        role: 'assistant',
        content: extractText(blocks),
        raw: data,
      });

      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        events.push({
          timestamp,
          type: 'error',
          content: (message.errorMessage as string) || `PI stopped with reason "${message.stopReason}"`,
          raw: data,
        });
      }
      return events;
    }

    if (message.role === 'toolResult') {
      const name = (message.toolName as string) || 'unknown';
      const toolName = normalizeToolName(name);
      const text = extractText(message.content);
      const success = message.isError !== true;
      events.push({
        timestamp,
        type: 'tool_result',
        tool: {
          name: toolName,
          originalName: name,
          result: toolName === 'shell' ? { output: text, exitCode: extractExitCode(text, success) } : text,
          success,
        },
        raw: data,
      });
      return events;
    }
  } catch {
    // Skip unparseable lines
  }

  return events;
}

/**
 * Parse PI JSONL transcript into normalized events.
 */
export function parsePiCodingAgentTranscript(raw: string): {
  events: TranscriptEvent[];
  errors: string[];
} {
  const parsed: TranscriptEvent[] = [];
  const errors: string[] = [];

  const lines = raw.split('\n').filter((line) => line.trim());

  for (const line of lines) {
    try {
      parsed.push(...parsePiLine(line));
    } catch (e) {
      errors.push(`Failed to parse line: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const events = pairToolResults(parsed);

  // Post-process: extract metadata into tool args
  for (const event of events) {
    if (event.type === 'tool_call' && event.tool) {
      const args = event.tool.args || {};

      if (['file_read', 'file_write', 'file_edit'].includes(event.tool.name)) {
        if (typeof args.path === 'string') {
          event.tool.args = { ...args, _extractedPath: args.path };
        }
      }

      if (event.tool.name === 'shell' && typeof args.command === 'string') {
        event.tool.args = { ...args, _extractedCommand: args.command };
      }
    }
  }

  return { events, errors };
}
