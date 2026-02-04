/**
 * Parser for Claude Code transcript format.
 * Claude Code stores transcripts as JSONL at ~/.claude/projects/{path}/{session}.jsonl
 *
 * Format reference (based on Claude Code CLI output):
 * - Messages have type: "user" | "assistant"
 * - Tool use appears in assistant messages with tool_use blocks
 * - Tool results appear as separate messages with type: "tool_result"
 */

import type { NormalizedEvent, NormalizedToolName } from '../types.js';

/**
 * Map Claude Code tool names to normalized names.
 */
function normalizeToolName(name: string): NormalizedToolName {
  const toolMap: Record<string, NormalizedToolName> = {
    // File operations
    Read: 'file_read',
    read_file: 'file_read',
    ReadFile: 'file_read',
    Write: 'file_write',
    write_file: 'file_write',
    WriteFile: 'file_write',
    write_to_file: 'file_write',
    Edit: 'file_edit',
    edit_file: 'file_edit',
    EditFile: 'file_edit',
    str_replace_editor: 'file_edit',
    StrReplace: 'file_edit',

    // Shell
    Bash: 'shell',
    bash: 'shell',
    Shell: 'shell',
    shell: 'shell',
    execute_command: 'shell',
    run_command: 'shell',

    // Web
    WebFetch: 'web_fetch',
    web_fetch: 'web_fetch',
    fetch_url: 'web_fetch',
    mcp__fetch__fetch: 'web_fetch',
    WebSearch: 'web_search',
    web_search: 'web_search',

    // Search/navigation
    Glob: 'glob',
    glob: 'glob',
    list_files: 'glob',
    Grep: 'grep',
    grep: 'grep',
    search_files: 'grep',
    LS: 'list_dir',
    list_dir: 'list_dir',
    ListDir: 'list_dir',
  };

  return toolMap[name] || 'unknown';
}

/**
 * Extract file path from tool arguments.
 */
function extractFilePath(args: Record<string, unknown>): string | undefined {
  return (args.path || args.file_path || args.filename || args.file) as string | undefined;
}

/**
 * Extract URL from tool arguments.
 */
function extractUrl(args: Record<string, unknown>): string | undefined {
  return (args.url || args.uri || args.href) as string | undefined;
}

/**
 * Extract command from tool arguments.
 */
function extractCommand(args: Record<string, unknown>): string | undefined {
  if (typeof args.command === 'string') return args.command;
  if (Array.isArray(args.command)) return args.command.join(' ');
  if (typeof args.cmd === 'string') return args.cmd;
  return undefined;
}

/**
 * Parse a single JSONL line from Claude Code transcript.
 */
function parseClaudeCodeLine(line: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  try {
    const data = JSON.parse(line);

    // Handle different Claude Code message formats
    if (data.type === 'user' || data.role === 'user') {
      events.push({
        timestamp: data.timestamp,
        type: 'message',
        role: 'user',
        content: extractContent(data),
        raw: data,
      });
    } else if (data.type === 'assistant' || data.role === 'assistant') {
      // Assistant message - may contain text and/or tool_use blocks
      const content = extractContent(data);
      if (content) {
        events.push({
          timestamp: data.timestamp,
          type: 'message',
          role: 'assistant',
          content,
          raw: data,
        });
      }

      // Extract tool_use blocks
      const toolUses = extractToolUses(data);
      for (const toolUse of toolUses) {
        events.push({
          timestamp: data.timestamp,
          type: 'tool_call',
          tool: {
            name: normalizeToolName(toolUse.name),
            originalName: toolUse.name,
            args: toolUse.input || toolUse.args || {},
          },
          raw: toolUse,
        });
      }

      // Extract thinking blocks
      const thinking = extractThinking(data);
      if (thinking) {
        events.push({
          timestamp: data.timestamp,
          type: 'thinking',
          content: thinking,
          raw: data,
        });
      }
    } else if (data.type === 'tool_result' || data.type === 'tool_response') {
      events.push({
        timestamp: data.timestamp,
        type: 'tool_result',
        tool: {
          name: 'unknown',
          originalName: data.tool_use_id || 'unknown',
          result: data.content || data.output || data.result,
          success: !data.is_error && !data.error,
        },
        raw: data,
      });
    } else if (data.type === 'system' || data.role === 'system') {
      events.push({
        timestamp: data.timestamp,
        type: 'message',
        role: 'system',
        content: extractContent(data),
        raw: data,
      });
    } else if (data.type === 'error' || data.error) {
      events.push({
        timestamp: data.timestamp,
        type: 'error',
        content: data.error?.message || data.message || JSON.stringify(data.error),
        raw: data,
      });
    }
  } catch {
    // Skip unparseable lines
  }

  return events;
}

/**
 * Extract text content from various message formats.
 */
function extractContent(data: Record<string, unknown>): string | undefined {
  if (typeof data.content === 'string') {
    return data.content;
  }
  if (Array.isArray(data.content)) {
    // Content blocks format
    const textBlocks = data.content.filter(
      (block: Record<string, unknown>) => block.type === 'text'
    );
    if (textBlocks.length > 0) {
      return textBlocks.map((b: Record<string, unknown>) => b.text).join('\n');
    }
  }
  if (typeof data.text === 'string') {
    return data.text;
  }
  if (typeof data.message === 'string') {
    return data.message;
  }
  return undefined;
}

/**
 * Extract tool_use blocks from assistant messages.
 */
function extractToolUses(
  data: Record<string, unknown>
): Array<{ name: string; input?: Record<string, unknown>; args?: Record<string, unknown> }> {
  const toolUses: Array<{
    name: string;
    input?: Record<string, unknown>;
    args?: Record<string, unknown>;
  }> = [];

  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === 'tool_use') {
        toolUses.push({
          name: block.name,
          input: block.input,
        });
      }
    }
  }

  // Also check for tool_calls array format
  if (Array.isArray(data.tool_calls)) {
    for (const call of data.tool_calls) {
      toolUses.push({
        name: call.function?.name || call.name,
        args: call.function?.arguments
          ? JSON.parse(call.function.arguments)
          : call.arguments || call.input,
      });
    }
  }

  return toolUses;
}

/**
 * Extract thinking/reasoning content.
 */
function extractThinking(data: Record<string, unknown>): string | undefined {
  if (Array.isArray(data.content)) {
    const thinkingBlocks = data.content.filter(
      (block: Record<string, unknown>) => block.type === 'thinking'
    );
    if (thinkingBlocks.length > 0) {
      return thinkingBlocks.map((b: Record<string, unknown>) => b.thinking || b.text).join('\n');
    }
  }
  return undefined;
}

/**
 * Parse Claude Code JSONL transcript into normalized events.
 */
export function parseClaudeCodeTranscript(raw: string): {
  events: NormalizedEvent[];
  errors: string[];
} {
  const events: NormalizedEvent[] = [];
  const errors: string[] = [];

  const lines = raw.split('\n').filter((line) => line.trim());

  for (const line of lines) {
    try {
      const lineEvents = parseClaudeCodeLine(line);
      events.push(...lineEvents);
    } catch (e) {
      errors.push(`Failed to parse line: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Post-process to link tool_results to their tool_calls
  // and extract additional metadata
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
