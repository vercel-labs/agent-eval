/**
 * Main parser entry point.
 * Routes to agent-specific parsers and generates summaries.
 */

import type {
  NormalizedEvent,
  NormalizedTranscript,
  TranscriptSummary,
  NormalizedToolName,
  WebFetchInfo,
  ShellCommandInfo,
} from '../types.js';
import { parseClaudeCodeTranscript } from './claude-code.js';
import { parseCodexTranscript } from './codex.js';
import { parseOpenCodeTranscript } from './opencode.js';

/**
 * Supported agent types for parsing.
 */
export type ParseableAgent =
  | 'vercel-ai-gateway/claude-code'
  | 'claude-code'
  | 'vercel-ai-gateway/codex'
  | 'codex'
  | 'vercel-ai-gateway/opencode';

/**
 * Get the parser function for an agent type.
 */
function getParserForAgent(
  agent: string
): (raw: string) => { events: NormalizedEvent[]; errors: string[] } {
  if (agent.includes('claude-code')) {
    return parseClaudeCodeTranscript;
  }
  if (agent.includes('codex')) {
    return parseCodexTranscript;
  }
  if (agent.includes('opencode')) {
    return parseOpenCodeTranscript;
  }
  // Default to Claude Code parser as a fallback
  return parseClaudeCodeTranscript;
}

/**
 * Generate summary statistics from normalized events.
 */
function generateSummary(events: NormalizedEvent[]): TranscriptSummary {
  const toolCalls: Record<NormalizedToolName, number> = {
    file_read: 0,
    file_write: 0,
    file_edit: 0,
    shell: 0,
    web_fetch: 0,
    web_search: 0,
    glob: 0,
    grep: 0,
    list_dir: 0,
    unknown: 0,
  };

  const webFetches: WebFetchInfo[] = [];
  const filesRead: Set<string> = new Set();
  const filesModified: Set<string> = new Set();
  const shellCommands: ShellCommandInfo[] = [];
  const errors: string[] = [];
  let thinkingBlocks = 0;
  let totalTurns = 0;

  for (const event of events) {
    switch (event.type) {
      case 'message':
        if (event.role === 'assistant') {
          totalTurns++;
        }
        break;

      case 'tool_call':
        if (event.tool) {
          toolCalls[event.tool.name]++;

          const args = event.tool.args || {};

          // Track file operations
          if (event.tool.name === 'file_read') {
            const path = (args._extractedPath || args.path || args.file) as string;
            if (path) filesRead.add(path);
          }

          if (event.tool.name === 'file_write' || event.tool.name === 'file_edit') {
            const path = (args._extractedPath || args.path || args.file) as string;
            if (path) filesModified.add(path);
          }

          // Track web fetches
          if (event.tool.name === 'web_fetch') {
            const url = (args._extractedUrl || args.url || args.uri) as string;
            if (url) {
              webFetches.push({
                url,
                method: args.method as string,
              });
            }
          }

          // Track shell commands
          if (event.tool.name === 'shell') {
            const command = (args._extractedCommand || args.command || args.cmd) as string;
            if (command) {
              shellCommands.push({ command });
            }
          }
        }
        break;

      case 'tool_result':
        if (event.tool) {
          // Update web fetch with success status
          if (event.tool.success !== undefined) {
            const lastFetch = webFetches[webFetches.length - 1];
            if (lastFetch && !lastFetch.success) {
              lastFetch.success = event.tool.success;
            }
          }

          // Update shell command with exit code
          const lastCmd = shellCommands[shellCommands.length - 1];
          if (lastCmd && lastCmd.exitCode === undefined) {
            lastCmd.success = event.tool.success;
            // Try to extract exit code from result
            const result = event.tool.result;
            if (typeof result === 'object' && result !== null && 'exitCode' in result) {
              lastCmd.exitCode = (result as { exitCode: number }).exitCode;
            }
          }
        }
        break;

      case 'thinking':
        thinkingBlocks++;
        break;

      case 'error':
        if (event.content) {
          errors.push(event.content);
        }
        break;
    }
  }

  const totalToolCalls = Object.values(toolCalls).reduce((a, b) => a + b, 0);

  return {
    totalTurns,
    toolCalls,
    totalToolCalls,
    webFetches,
    filesRead: Array.from(filesRead),
    filesModified: Array.from(filesModified),
    shellCommands,
    errors,
    thinkingBlocks,
  };
}

/**
 * Parse a raw transcript into a normalized format.
 *
 * @param raw - The raw transcript string (JSONL format)
 * @param agent - The agent type that produced this transcript
 * @param model - Optional model name
 * @returns Normalized transcript with events and summary
 */
export function parseTranscript(
  raw: string,
  agent: string,
  model?: string
): NormalizedTranscript {
  if (!raw || !raw.trim()) {
    return {
      agent,
      model,
      events: [],
      summary: {
        totalTurns: 0,
        toolCalls: {
          file_read: 0,
          file_write: 0,
          file_edit: 0,
          shell: 0,
          web_fetch: 0,
          web_search: 0,
          glob: 0,
          grep: 0,
          list_dir: 0,
          unknown: 0,
        },
        totalToolCalls: 0,
        webFetches: [],
        filesRead: [],
        filesModified: [],
        shellCommands: [],
        errors: [],
        thinkingBlocks: 0,
      },
      parseSuccess: true,
      parseErrors: [],
    };
  }

  const parser = getParserForAgent(agent);
  const { events, errors } = parser(raw);
  const summary = generateSummary(events);

  return {
    agent,
    model,
    events,
    summary,
    parseSuccess: errors.length === 0,
    parseErrors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Parse transcript and return only the summary (lighter weight).
 */
export function parseTranscriptSummary(
  raw: string,
  agent: string
): TranscriptSummary {
  const { summary } = parseTranscript(raw, agent);
  return summary;
}
