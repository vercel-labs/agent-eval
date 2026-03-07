/**
 * Bub transcript parser.
 * Parses Bub tape JSONL files from $BUB_HOME/tapes/<session>.jsonl.
 */

import type { TranscriptEvent, ToolName } from '../types.js';

function toISO(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return new Date(value * 1000).toISOString();
  }
  return undefined;
}

function normalizeToolName(name: string): ToolName {
  const toolMap: Record<string, ToolName> = {
    'fs.read': 'file_read',
    fs_read: 'file_read',
    'fs.write': 'file_write',
    fs_write: 'file_write',
    'fs.edit': 'file_edit',
    fs_edit: 'file_edit',
    bash: 'shell',
    shell: 'shell',
    'web.fetch': 'web_fetch',
    web_fetch: 'web_fetch',
    'web.search': 'web_search',
    web_search: 'web_search',
    glob: 'glob',
    grep: 'grep',
    ls: 'list_dir',
    list_dir: 'list_dir',
    task: 'agent_task',
    update_todos: 'agent_task',
  };

  return toolMap[name] || 'unknown';
}

function parseToolArgs(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function enrichArgs(toolName: ToolName, args: Record<string, unknown>): Record<string, unknown> {
  const enriched = { ...args };

  if (toolName === 'file_read' || toolName === 'file_write' || toolName === 'file_edit') {
    const path = (args.path || args.file || args.filePath) as string | undefined;
    if (path) {
      enriched._extractedPath = path;
    }
  }

  if (toolName === 'web_fetch' || toolName === 'web_search') {
    const url = (args.url || args.uri || args.query) as string | undefined;
    if (url) {
      enriched._extractedUrl = url;
    }
  }

  if (toolName === 'shell') {
    const command = (args.command || args.cmd) as string | undefined;
    if (command) {
      enriched._extractedCommand = command;
    }
  }

  return enriched;
}

function parseLegacyEntry(entry: Record<string, unknown>): TranscriptEvent[] {
  const timestamp = toISO(entry.timestamp);

  if (entry.type === 'message') {
    return [{
      type: 'message',
      role: (entry.role as 'user' | 'assistant' | 'system') || 'assistant',
      content: (entry.content as string) || '',
      timestamp,
      raw: entry,
    }];
  }

  if (entry.type === 'tool_call') {
    const originalName = (entry.tool_name as string) || 'unknown';
    const toolName = normalizeToolName(originalName);
    return [{
      type: 'tool_call',
      timestamp,
      tool: {
        name: toolName,
        originalName,
        args: enrichArgs(toolName, parseToolArgs(entry.args)),
      },
      raw: entry,
    }];
  }

  if (entry.type === 'tool_result') {
    return [{
      type: 'tool_result',
      timestamp,
      tool: {
        name: 'unknown',
        originalName: 'unknown',
        success: entry.success !== false,
        result: entry.result,
      },
      raw: entry,
    }];
  }

  if (entry.type === 'error') {
    return [{
      type: 'error',
      timestamp,
      content: (entry.message || entry.error || 'Unknown error') as string,
      raw: entry,
    }];
  }

  return [];
}

function parseTapeEntry(entry: Record<string, unknown>): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const timestamp = toISO(entry.timestamp);
  const kind = entry.kind;
  const payload = (typeof entry.payload === 'object' && entry.payload !== null)
    ? entry.payload as Record<string, unknown>
    : {};

  if (kind === 'message') {
    const role = payload.role;
    const content = payload.content;
    if (typeof role === 'string' && typeof content === 'string') {
      events.push({
        type: 'message',
        role: role as 'user' | 'assistant' | 'system',
        content,
        timestamp,
        raw: entry,
      });
    }
    return events;
  }

  if (kind === 'tool_call') {
    const calls = Array.isArray(payload.calls) ? payload.calls : [];
    for (const call of calls) {
      const fn = typeof call === 'object' && call !== null
        ? (call as { function?: { name?: unknown; arguments?: unknown } }).function
        : undefined;
      const originalName = typeof fn?.name === 'string' ? fn.name : 'unknown';
      const toolName = normalizeToolName(originalName);
      const args = enrichArgs(toolName, parseToolArgs(fn?.arguments));
      events.push({
        type: 'tool_call',
        timestamp,
        tool: {
          name: toolName,
          originalName,
          args,
        },
        raw: call,
      });
    }
    return events;
  }

  if (kind === 'tool_result') {
    const results = Array.isArray(payload.results) ? payload.results : [payload.results];
    for (const result of results) {
      events.push({
        type: 'tool_result',
        timestamp,
        tool: {
          name: 'unknown',
          originalName: 'unknown',
          success: !(typeof result === 'object' && result !== null && 'error' in result),
          result,
        },
        raw: result,
      });
    }
    return events;
  }

  if (kind === 'event') {
    const eventName = payload.name;
    const data = (typeof payload.data === 'object' && payload.data !== null)
      ? payload.data as Record<string, unknown>
      : {};
    const status = data.status;
    const error = data.error;

    if (typeof status === 'string' && status !== 'ok') {
      events.push({
        type: 'error',
        timestamp,
        content: typeof error === 'string' ? error : `${String(eventName)}: ${status}`,
        raw: entry,
      });
    }
    return events;
  }

  return events;
}

/**
 * Parse Bub tape JSONL into normalized events.
 */
export function parseBubTranscript(raw: string): { events: TranscriptEvent[]; errors: string[] } {
  const events: TranscriptEvent[] = [];
  const errors: string[] = [];

  if (!raw || !raw.trim()) {
    return { events, errors };
  }

  const lines = raw.trim().split('\n');

  for (const [lineIndex, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof entry.type === 'string') {
        events.push(...parseLegacyEntry(entry));
      } else {
        events.push(...parseTapeEntry(entry));
      }
    } catch (parseError) {
      errors.push(`Line ${lineIndex + 1}: Invalid JSON - ${parseError}`);
    }
  }

  return { events, errors };
}
