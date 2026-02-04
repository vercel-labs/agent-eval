/**
 * Parser for OpenAI Codex CLI transcript format.
 * Codex outputs JSONL to stdout when run with --json flag.
 *
 * Format reference (based on Codex CLI output):
 * - Events have a "type" field indicating the event type
 * - Messages, function calls, and results are separate events
 */

import type { TranscriptEvent, ToolName } from '../types.js';

/**
 * Map Codex tool names to canonical names.
 */
function normalizeToolName(name: string): ToolName {
  const toolMap: Record<string, ToolName> = {
    // File operations
    read_file: 'file_read',
    write_file: 'file_write',
    edit_file: 'file_edit',
    patch_file: 'file_edit',
    create_file: 'file_write',
    delete_file: 'file_write',

    // Shell
    shell: 'shell',
    bash: 'shell',
    execute: 'shell',
    run: 'shell',
    exec: 'shell',
    terminal: 'shell',

    // Web
    fetch: 'web_fetch',
    http_request: 'web_fetch',
    curl: 'web_fetch',
    web_search: 'web_search',
    search: 'web_search',

    // Search/navigation
    glob: 'glob',
    find_files: 'glob',
    list_files: 'glob',
    grep: 'grep',
    search_files: 'grep',
    ripgrep: 'grep',
    ls: 'list_dir',
    list_directory: 'list_dir',
    dir: 'list_dir',
  };

  return toolMap[name.toLowerCase()] || 'unknown';
}

/**
 * Extract file path from tool arguments.
 */
function extractFilePath(args: Record<string, unknown>): string | undefined {
  return (args.path || args.file || args.filename || args.file_path) as string | undefined;
}

/**
 * Extract URL from tool arguments.
 */
function extractUrl(args: Record<string, unknown>): string | undefined {
  return (args.url || args.uri || args.endpoint) as string | undefined;
}

/**
 * Extract command from tool arguments.
 */
function extractCommand(args: Record<string, unknown>): string | undefined {
  if (typeof args.command === 'string') return args.command;
  if (Array.isArray(args.command)) return args.command.join(' ');
  if (typeof args.cmd === 'string') return args.cmd;
  if (Array.isArray(args.args) && typeof args.program === 'string') {
    return `${args.program} ${(args.args as string[]).join(' ')}`;
  }
  return undefined;
}

/**
 * Parse a single JSONL line from Codex transcript.
 */
function parseCodexLine(line: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];

  try {
    const data = JSON.parse(line);

    // Codex uses various event type formats
    const eventType = data.type || data.event || data.kind;

    switch (eventType) {
      case 'message':
      case 'chat':
      case 'response': {
        const role = data.role || (data.from === 'assistant' ? 'assistant' : 'user');
        events.push({
          timestamp: data.timestamp || data.ts,
          type: 'message',
          role: role as 'user' | 'assistant' | 'system',
          content: data.content || data.text || data.message,
          raw: data,
        });
        break;
      }

      case 'function_call':
      case 'tool_call':
      case 'tool_use':
      case 'action': {
        const name = data.function?.name || data.name || data.tool || data.action;
        const args = data.function?.arguments
          ? typeof data.function.arguments === 'string'
            ? JSON.parse(data.function.arguments)
            : data.function.arguments
          : data.arguments || data.input || data.params || {};

        events.push({
          timestamp: data.timestamp || data.ts,
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

      case 'function_result':
      case 'tool_result':
      case 'tool_response':
      case 'action_result': {
        events.push({
          timestamp: data.timestamp || data.ts,
          type: 'tool_result',
          tool: {
            name: 'unknown',
            originalName: data.tool || data.function || 'unknown',
            result: data.result || data.output || data.content,
            success: data.success !== false && !data.error,
          },
          raw: data,
        });
        break;
      }

      case 'thinking':
      case 'reasoning':
      case 'thought': {
        events.push({
          timestamp: data.timestamp || data.ts,
          type: 'thinking',
          content: data.content || data.text || data.thought,
          raw: data,
        });
        break;
      }

      case 'error': {
        events.push({
          timestamp: data.timestamp || data.ts,
          type: 'error',
          content: data.error?.message || data.message || data.content,
          raw: data,
        });
        break;
      }

      // Codex Responses API events
      case 'thread.started':
      case 'thread.completed':
      case 'turn.started':
      case 'turn.completed':
      case 'turn.failed': {
        // These are control flow events, capture as metadata
        events.push({
          timestamp: data.timestamp || data.ts,
          type: eventType === 'turn.failed' ? 'error' : 'message',
          role: 'system',
          content: eventType === 'turn.failed' 
            ? (data.error?.message || `Turn failed`) 
            : eventType,
          raw: data,
        });
        break;
      }

      case 'response.created':
      case 'response.completed':
      case 'response.cancelled':
      case 'response.failed': {
        // Response lifecycle events
        if (eventType === 'response.failed') {
          events.push({
            timestamp: data.timestamp || data.ts,
            type: 'error',
            content: data.error?.message || 'Response failed',
            raw: data,
          });
        }
        break;
      }

      case 'output_text.delta':
      case 'output_text.done': {
        // Text streaming events
        if (data.text || data.delta) {
          events.push({
            timestamp: data.timestamp || data.ts,
            type: 'message',
            role: 'assistant',
            content: data.text || data.delta,
            raw: data,
          });
        }
        break;
      }

      default: {
        // Try to infer from structure
        if (data.role === 'assistant' || data.role === 'user') {
          events.push({
            timestamp: data.timestamp || data.ts,
            type: 'message',
            role: data.role,
            content: data.content || data.text,
            raw: data,
          });
        } else if (data.function || data.tool) {
          // Looks like a tool call or result
          if (data.result !== undefined || data.output !== undefined) {
            events.push({
              timestamp: data.timestamp || data.ts,
              type: 'tool_result',
              tool: {
                name: 'unknown',
                originalName: data.function || data.tool || 'unknown',
                result: data.result || data.output,
                success: !data.error,
              },
              raw: data,
            });
          } else {
            const name = data.function?.name || data.function || data.tool;
            events.push({
              timestamp: data.timestamp || data.ts,
              type: 'tool_call',
              tool: {
                name: normalizeToolName(name),
                originalName: name,
                args: data.arguments || data.input || {},
              },
              raw: data,
            });
          }
        }
      }
    }
  } catch {
    // Skip unparseable lines
  }

  return events;
}

/**
 * Parse Codex JSONL transcript into events.
 */
export function parseCodexTranscript(raw: string): {
  events: TranscriptEvent[];
  errors: string[];
} {
  const events: TranscriptEvent[] = [];
  const errors: string[] = [];

  const lines = raw.split('\n').filter((line) => line.trim());

  for (const line of lines) {
    try {
      const lineEvents = parseCodexLine(line);
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

  return { events, errors };
}
