/**
 * Parser for Gemini CLI transcript format.
 * Gemini CLI outputs JSONL events with the same structure as OpenCode
 * (step_start, tool_use, text, step_finish) since they share a framework.
 *
 * Format reference (based on Gemini CLI --output-format stream-json):
 * - Events have a "type" field: step_start, tool_use, text, step_finish
 * - Tool calls use part.tool (name) and part.state (input/output/status)
 * - Timestamps are epoch milliseconds
 */

import type { TranscriptEvent, ToolName } from '../types.js';

/**
 * Map Gemini tool names to canonical names.
 */
function normalizeToolName(name: string): ToolName {
  const toolMap: Record<string, ToolName> = {
    // Gemini CLI tools (observed in real transcripts)
    read: 'file_read',
    write: 'file_write',
    edit: 'file_edit',
    bash: 'shell',
    glob: 'glob',

    // Possible alternative names
    read_file: 'file_read',
    write_file: 'file_write',
    list_directory: 'list_dir',
    run_shell_command: 'shell',
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
 */
function parseGeminiLine(line: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];

  try {
    const data = JSON.parse(line);
    const eventType = data.type;
    const part = data.part as Record<string, unknown> | undefined;
    const state = part?.state as Record<string, unknown> | undefined;

    switch (eventType) {
      case 'tool_use': {
        if (part && part.tool) {
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
        }
        break;
      }

      case 'text': {
        const text = (part?.text as string) || undefined;
        if (text && text.trim()) {
          events.push({
            timestamp: toISO(data.timestamp),
            type: 'message',
            role: 'assistant',
            content: text,
            raw: data,
          });
        }
        break;
      }

      // step_start / step_finish are metadata — skip
      case 'step_start':
      case 'step_finish':
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
