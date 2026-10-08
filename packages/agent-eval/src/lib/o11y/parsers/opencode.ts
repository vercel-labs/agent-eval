/**
 * Parser for OpenCode CLI transcript format.
 * OpenCode outputs JSON events to stdout when run with --format json.
 *
 * Format reference (based on OpenCode CLI output):
 * - Events have a "kind" field indicating the event type
 * - Messages, tool calls, and results are separate events
 */

import type { TokenUsage, TranscriptEvent, ToolName } from '../types.js';
import { asRecord, compactUsage, parseJsonLine, reportedNumber, sumUsage } from '../usage.js';

/**
 * Map OpenCode tool names to canonical names.
 */
function normalizeToolName(name: string): ToolName {
  const toolMap: Record<string, ToolName> = {
    // File operations
    read: 'file_read',
    read_file: 'file_read',
    file_read: 'file_read',
    write: 'file_write',
    write_file: 'file_write',
    file_write: 'file_write',
    create: 'file_write',
    edit: 'file_edit',
    edit_file: 'file_edit',
    file_edit: 'file_edit',
    patch: 'file_edit',

    // Shell
    bash: 'shell',
    shell: 'shell',
    exec: 'shell',
    execute: 'shell',
    run: 'shell',
    command: 'shell',

    // Web
    fetch: 'web_fetch',
    http: 'web_fetch',
    request: 'web_fetch',
    web_fetch: 'web_fetch',
    search: 'web_search',
    web_search: 'web_search',

    // Search/navigation
    glob: 'glob',
    find: 'glob',
    list: 'glob',
    grep: 'grep',
    rg: 'grep',
    ripgrep: 'grep',
    ls: 'list_dir',
    dir: 'list_dir',
    list_dir: 'list_dir',
  };

  return toolMap[name.toLowerCase()] || 'unknown';
}

/**
 * Extract file path from tool arguments.
 */
function extractFilePath(args: Record<string, unknown>): string | undefined {
  return (args.path || args.filePath || args.file || args.filename || args.target) as string | undefined;
}

/**
 * Extract URL from tool arguments.
 */
function extractUrl(args: Record<string, unknown>): string | undefined {
  return (args.url || args.uri || args.href || args.endpoint) as string | undefined;
}

/**
 * Extract command from tool arguments.
 */
function extractCommand(args: Record<string, unknown>): string | undefined {
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  if (typeof args.script === 'string') return args.script;
  if (Array.isArray(args.args)) {
    const program = args.program || args.bin || args.executable || '';
    return `${program} ${(args.args as string[]).join(' ')}`.trim();
  }
  return undefined;
}

/**
 * Parse a single JSONL line from OpenCode transcript.
 * Handles the real OpenCode format:
 * - type: "tool_use" | "text" | "step_start" | "step_finish"
 * - Tool info in part.tool, part.state.input, part.state.output
 * - Text in part.text
 */
function parseOpenCodeLine(line: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];

  try {
    const data = JSON.parse(line);

    // OpenCode uses "type" for event type
    const eventType = data.type || data.kind || data.event;
    const part = data.part as Record<string, unknown> | undefined;
    const state = part?.state as Record<string, unknown> | undefined;

    switch (eventType) {
      // Real OpenCode format: tool_use with part.tool
      case 'tool_use': {
        if (part && part.tool) {
          const name = part.tool as string;
          const args = (state?.input as Record<string, unknown>) || {};
          const output = state?.output;
          const status = state?.status as string | undefined;

          // Emit tool_call event
          events.push({
            timestamp: data.timestamp ? new Date(data.timestamp).toISOString() : undefined,
            type: 'tool_call',
            tool: {
              name: normalizeToolName(name),
              originalName: name,
              args,
            },
            raw: data,
          });

          // If completed, also emit tool_result
          if (status === 'completed' && output !== undefined) {
            const metadata = state?.metadata as Record<string, unknown> | undefined;
            const exitCode = metadata?.exit as number | undefined;
            // For shell commands, check exit code; for others, check status and error
            const isShellCommand = name === 'bash' || name === 'shell' || name === 'exec';
            const success = isShellCommand
              ? (exitCode === 0 || exitCode === undefined)
              : (status === 'completed' && !state?.error);

            events.push({
              timestamp: data.timestamp ? new Date(data.timestamp).toISOString() : undefined,
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

      // Real OpenCode format: text with part.text
      case 'text': {
        const text = part?.text as string | undefined;
        if (text && text.trim()) {
          events.push({
            timestamp: data.timestamp ? new Date(data.timestamp).toISOString() : undefined,
            type: 'message',
            role: 'assistant',
            content: text,
            raw: data,
          });
        }
        break;
      }

      // Step events carry no conversation content; step_finish token usage is
      // read separately by extractStepFinishUsage.
      case 'step_start':
      case 'step_finish': {
        break;
      }

      // Legacy/fallback formats
      case 'message':
      case 'response':
      case 'assistant':
      case 'user': {
        const role =
          data.role || eventType === 'assistant'
            ? 'assistant'
            : eventType === 'user'
              ? 'user'
              : 'assistant';
        const content = data.message?.content || data.content || data.text;

        if (content) {
          events.push({
            timestamp: data.timestamp || data.time,
            type: 'message',
            role: role as 'user' | 'assistant' | 'system',
            content,
            raw: data,
          });
        }

        // Check for tool calls within the message
        const toolCalls = data.message?.tool_calls || data.tool_calls || [];
        for (const call of toolCalls) {
          const name = call.function?.name || call.name;
          const args = call.function?.arguments
            ? typeof call.function.arguments === 'string'
              ? JSON.parse(call.function.arguments)
              : call.function.arguments
            : call.arguments || call.input || {};

          events.push({
            timestamp: data.timestamp || data.time,
            type: 'tool_call',
            tool: {
              name: normalizeToolName(name),
              originalName: name,
              args,
            },
            raw: call,
          });
        }
        break;
      }

      case 'tool_call':
      case 'function_call':
      case 'action': {
        const name = data.tool || data.function || data.name || data.action;
        const args = data.input || data.arguments || data.params || {};

        events.push({
          timestamp: data.timestamp || data.time,
          type: 'tool_call',
          tool: {
            name: normalizeToolName(name),
            originalName: name,
            args,
          },
          raw: data,
        });
        break;
      }

      case 'tool_result':
      case 'function_result':
      case 'action_result':
      case 'result': {
        events.push({
          timestamp: data.timestamp || data.time,
          type: 'tool_result',
          tool: {
            name: 'unknown',
            originalName: data.tool || data.function || 'unknown',
            result: data.output || data.result || data.content,
            success: data.success !== false && !data.error,
          },
          raw: data,
        });
        break;
      }

      case 'thinking':
      case 'reasoning': {
        events.push({
          timestamp: data.timestamp || data.time,
          type: 'thinking',
          content: data.content || data.text || data.thinking,
          raw: data,
        });
        break;
      }

      case 'error': {
        events.push({
          timestamp: data.timestamp || data.time,
          type: 'error',
          content: data.error?.message || data.message || data.content,
          raw: data,
        });
        break;
      }

      default: {
        // Try to infer from structure
        if (data.message && typeof data.message === 'object') {
          const role = data.message.role || 'assistant';
          events.push({
            timestamp: data.timestamp || data.time,
            type: 'message',
            role: role as 'user' | 'assistant' | 'system',
            content: data.message.content,
            raw: data,
          });
        }
      }
    }
  } catch {
    // Skip unparseable lines
  }

  return events;
}

/**
 * Read token usage from `step_finish` events.
 *
 * OpenCode emits one `step_finish` per model call, with that call's
 * `part.tokens` (`input`, `output`, `reasoning`, `cache.read`, `cache.write`,
 * and, in newer versions, `total`) and `part.cost`. Steps are de-duplicated by
 * part id and summed. A field is reported only when every step reports it, so
 * runs from versions without `tokens.total` have no `totalTokens`: those
 * versions disagree about whether `output` includes reasoning, so the parts
 * can't be summed safely.
 *
 * `part.cost` is OpenCode's own figure, from its model pricing data. OpenCode
 * reports 0 for models it has no pricing for.
 */
export function extractStepFinishUsage(raw: string): TokenUsage | undefined {
  const steps = new Map<string, TokenUsage>();
  let anonymous = 0;

  for (const line of raw.split('\n')) {
    const data = parseJsonLine(line);
    if (data?.type !== 'step_finish') continue;
    const part = asRecord(data.part);
    const tokens = asRecord(part?.tokens);
    if (!part || !tokens) continue;
    const cache = asRecord(tokens.cache);

    const usage = compactUsage({
      inputTokens: reportedNumber(tokens.input),
      outputTokens: reportedNumber(tokens.output),
      reasoningTokens: reportedNumber(tokens.reasoning),
      cacheReadTokens: reportedNumber(cache?.read),
      cacheWriteTokens: reportedNumber(cache?.write),
      totalTokens: reportedNumber(tokens.total),
      costUsd: reportedNumber(part.cost),
    });
    if (!usage) continue;

    const id = typeof part.id === 'string' && part.id ? part.id : `#${anonymous++}`;
    steps.set(id, usage);
  }

  return sumUsage([...steps.values()]);
}

/**
 * Parse OpenCode JSONL transcript into normalized events.
 */
export function parseOpenCodeTranscript(raw: string): {
  events: TranscriptEvent[];
  errors: string[];
  usage?: TokenUsage;
} {
  const events: TranscriptEvent[] = [];
  const errors: string[] = [];

  const lines = raw.split('\n').filter((line) => line.trim());

  for (const line of lines) {
    try {
      const lineEvents = parseOpenCodeLine(line);
      events.push(...lineEvents);
    } catch (e) {
      errors.push(`Failed to parse line: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Post-process to extract additional metadata
  for (const event of events) {
    if (event.type === 'tool_call' && event.tool) {
      const args = event.tool.args || {};

      // Extract file paths for file operations
      if (['file_read', 'file_write', 'file_edit'].includes(event.tool.name)) {
        const path = extractFilePath(args);
        if (path) {
          event.tool.args = { ...args, _extractedPath: path };
        }
      }

      // Extract URLs for web fetches
      if (event.tool.name === 'web_fetch') {
        const url = extractUrl(args);
        if (url) {
          event.tool.args = { ...args, _extractedUrl: url };
        }
      }

      // Extract commands for shell operations
      if (event.tool.name === 'shell') {
        const command = extractCommand(args);
        if (command) {
          event.tool.args = { ...args, _extractedCommand: command };
        }
      }
    }
  }

  const usage = extractStepFinishUsage(raw);
  return usage ? { events, errors, usage } : { events, errors };
}
