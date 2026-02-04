/**
 * Parser for OpenCode CLI transcript format.
 * OpenCode outputs JSON events to stdout when run with --format json.
 *
 * Format reference (based on OpenCode CLI output):
 * - Events have a "kind" field indicating the event type
 * - Messages, tool calls, and results are separate events
 */

import type { NormalizedEvent, NormalizedToolName } from '../types.js';

/**
 * Map OpenCode tool names to normalized names.
 */
function normalizeToolName(name: string): NormalizedToolName {
  const toolMap: Record<string, NormalizedToolName> = {
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
  return (args.path || args.file || args.filename || args.target) as string | undefined;
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
 */
function parseOpenCodeLine(line: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  try {
    const data = JSON.parse(line);

    // OpenCode uses "kind" for event type
    const eventKind = data.kind || data.type || data.event;

    switch (eventKind) {
      case 'message':
      case 'response':
      case 'assistant':
      case 'user': {
        const role =
          data.role || eventKind === 'assistant'
            ? 'assistant'
            : eventKind === 'user'
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
 * Parse OpenCode JSONL transcript into normalized events.
 */
export function parseOpenCodeTranscript(raw: string): {
  events: NormalizedEvent[];
  errors: string[];
} {
  const events: NormalizedEvent[] = [];
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

  return { events, errors };
}
