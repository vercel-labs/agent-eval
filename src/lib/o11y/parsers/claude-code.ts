/**
 * Parser for Claude Code transcript format.
 * Claude Code stores transcripts as JSONL at ~/.claude/projects/{path}/{session}.jsonl
 *
 * Format reference (based on Claude Code CLI output):
 * - Messages have type: "user" | "assistant"
 * - Tool use appears in assistant messages with tool_use blocks
 * - Tool results appear as separate messages with type: "tool_result"
 */

import type { TranscriptEvent, ToolName } from '../types.js';

/**
 * Map Claude Code tool names to canonical names.
 */
function normalizeToolName(name: string): ToolName {
  const toolMap: Record<string, ToolName> = {
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

    // Agent/subagent tools
    Task: 'agent_task',
    task: 'agent_task',
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
function parseClaudeCodeLine(line: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];

  try {
    const data = JSON.parse(line);

    // Handle different Claude Code message formats
    if (data.type === 'user' || data.role === 'user') {
      // Check if this is a tool_result message (user message containing tool results)
      const contentArray = getContentArray(data);
      const toolResults = contentArray?.filter(
        (block: unknown) => (block as Record<string, unknown>).type === 'tool_result'
      );
      
      if (toolResults && toolResults.length > 0) {
        // Extract tool results from user message
        for (const result of toolResults) {
          const r = result as Record<string, unknown>;
          events.push({
            timestamp: data.timestamp,
            type: 'tool_result',
            tool: {
              name: 'unknown',
              originalName: (r.tool_use_id || 'unknown') as string,
              result: r.content,
              success: !r.is_error && !r.error,
            },
            raw: r,
          });
        }
      } else {
        // Regular user message
        events.push({
          timestamp: data.timestamp,
          type: 'message',
          role: 'user',
          content: extractContent(data),
          raw: data,
        });
      }
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
 * Get the content array from data, handling nested message format.
 * Claude Code wraps messages: { type: "assistant", message: { content: [...] } }
 */
function getContentArray(data: Record<string, unknown>): unknown[] | undefined {
  // Direct content array
  if (Array.isArray(data.content)) {
    return data.content;
  }
  // Nested message format (real Claude Code format)
  const message = data.message as Record<string, unknown> | undefined;
  if (message && Array.isArray(message.content)) {
    return message.content;
  }
  return undefined;
}

/**
 * Get string content from data, handling nested message format.
 */
function getStringContent(data: Record<string, unknown>): string | undefined {
  if (typeof data.content === 'string') {
    return data.content;
  }
  const message = data.message as Record<string, unknown> | undefined;
  if (message && typeof message.content === 'string') {
    return message.content;
  }
  return undefined;
}

/**
 * Extract text content from various message formats.
 */
function extractContent(data: Record<string, unknown>): string | undefined {
  // Check for direct string content
  const stringContent = getStringContent(data);
  if (stringContent) {
    return stringContent;
  }
  
  // Check for content blocks array
  const contentArray = getContentArray(data);
  if (contentArray) {
    const textBlocks = contentArray.filter(
      (block: unknown) => (block as Record<string, unknown>).type === 'text'
    );
    if (textBlocks.length > 0) {
      return textBlocks.map((b: unknown) => (b as Record<string, unknown>).text).join('\n');
    }
  }
  
  if (typeof data.text === 'string') {
    return data.text;
  }
  // Note: don't check data.message as string since message is an object in Claude Code format
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

  // Check content array (handles both direct and nested message format)
  const contentArray = getContentArray(data);
  if (contentArray) {
    for (const block of contentArray) {
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use') {
        toolUses.push({
          name: b.name as string,
          input: b.input as Record<string, unknown> | undefined,
        });
      }
    }
  }

  // Also check for tool_calls array format (OpenAI-style)
  const toolCalls = data.tool_calls || (data.message as Record<string, unknown>)?.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      const c = call as Record<string, unknown>;
      const func = c.function as Record<string, unknown> | undefined;
      toolUses.push({
        name: (func?.name || c.name) as string,
        args: func?.arguments
          ? JSON.parse(func.arguments as string)
          : (c.arguments || c.input) as Record<string, unknown> | undefined,
      });
    }
  }

  return toolUses;
}

/**
 * Extract thinking/reasoning content.
 */
function extractThinking(data: Record<string, unknown>): string | undefined {
  const contentArray = getContentArray(data);
  if (contentArray) {
    const thinkingBlocks = contentArray.filter(
      (block: unknown) => (block as Record<string, unknown>).type === 'thinking'
    );
    if (thinkingBlocks.length > 0) {
      return thinkingBlocks.map((b: unknown) => {
        const block = b as Record<string, unknown>;
        return block.thinking || block.text;
      }).join('\n');
    }
  }
  return undefined;
}

/**
 * Parse Claude Code JSONL transcript into events.
 */
export function parseClaudeCodeTranscript(raw: string): {
  events: TranscriptEvent[];
  errors: string[];
} {
  const events: TranscriptEvent[] = [];
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
