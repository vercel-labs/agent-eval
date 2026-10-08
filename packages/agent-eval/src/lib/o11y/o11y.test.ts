/**
 * Tests for the o11y (observability) module.
 */

import { describe, it, expect } from 'vitest';
import { parseTranscript, parseTranscriptSummary, parseTranscriptUsage, loadTranscript } from './index.js';
import type { Transcript } from './types.js';
import { parseClaudeCodeTranscript } from './parsers/claude-code.js';
import { parseCodexTranscript } from './parsers/codex.js';
import { parseOpenCodeTranscript } from './parsers/opencode.js';
import { parseFxTranscript } from './parsers/fx.js';
import { parseGeminiTranscript } from './parsers/gemini.js';
import { parseCursorTranscript } from './parsers/cursor.js';

describe('o11y', () => {
  describe('parseTranscript', () => {
    it('returns empty result for empty input', () => {
      const result = parseTranscript('', 'claude-code');
      expect(result.events).toEqual([]);
      expect(result.summary.totalTurns).toBe(0);
      expect(result.summary.totalToolCalls).toBe(0);
      expect(result.parseSuccess).toBe(true);
    });

    it('routes to correct parser based on agent type', () => {
      const claudeTranscript = '{"type":"assistant","content":"Hello"}';

      const claudeResult = parseTranscript(claudeTranscript, 'claude-code');
      expect(claudeResult.agent).toBe('claude-code');

      const codexResult = parseTranscript(claudeTranscript, 'codex');
      expect(codexResult.agent).toBe('codex');

      const opencodeResult = parseTranscript(claudeTranscript, 'vercel-ai-gateway/opencode');
      expect(opencodeResult.agent).toBe('vercel-ai-gateway/opencode');

      const fxResult = parseTranscript(claudeTranscript, 'vercel-ai-gateway/fx');
      expect(fxResult.agent).toBe('vercel-ai-gateway/fx');

      const geminiResult = parseTranscript(claudeTranscript, 'gemini');
      expect(geminiResult.agent).toBe('gemini');

      const cursorResult = parseTranscript(claudeTranscript, 'cursor');
      expect(cursorResult.agent).toBe('cursor');
    });

    it('returns parseSuccess: false for unsupported agents', () => {
      const transcript = '{"type":"assistant","content":"Hello"}';

      const result = parseTranscript(transcript, 'unsupported-agent');

      expect(result.parseSuccess).toBe(false);
      expect(result.parseErrors).toContain(
        'No parser available for agent: unsupported-agent. Supported agents: claude-code, codex, opencode, fx, gemini, cursor'
      );
      expect(result.events).toEqual([]);
      expect(result.summary.totalToolCalls).toBe(0);
    });

    it('does not route custom agent names containing fx to the fx parser', () => {
      const result = parseTranscript('{}', 'vfx-agent');
      expect(result.parseSuccess).toBe(false);
      expect(result.parseErrors?.[0]).toContain('No parser available for agent: vfx-agent');
    });

    it('includes model in result', () => {
      const result = parseTranscript('{}', 'claude-code', 'opus');
      expect(result.model).toBe('opus');
    });
  });

  describe('parseTranscriptSummary', () => {
    it('returns only summary without events', () => {
      const transcript = '{"type":"assistant","content":"Hello"}';
      const summary = parseTranscriptSummary(transcript, 'claude-code');

      expect(summary).toHaveProperty('totalTurns');
      expect(summary).toHaveProperty('toolCalls');
      expect(summary).toHaveProperty('webFetches');
      expect(summary).not.toHaveProperty('events');
    });
  });

  describe('Claude Code parser', () => {
    it('parses user messages', () => {
      const transcript = '{"type":"user","content":"Write a function"}';
      const { events } = parseClaudeCodeTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message');
      expect(events[0].role).toBe('user');
      expect(events[0].content).toBe('Write a function');
    });

    it('parses assistant messages', () => {
      const transcript = '{"type":"assistant","content":"Here is the function"}';
      const { events } = parseClaudeCodeTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message');
      expect(events[0].role).toBe('assistant');
      expect(events[0].content).toBe('Here is the function');
    });

    it('parses tool_use blocks in assistant messages', () => {
      const transcript = JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'text', text: 'Let me read the file' },
          { type: 'tool_use', name: 'Read', input: { path: 'src/index.ts' } },
        ],
      });
      const { events } = parseClaudeCodeTranscript(transcript);

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('message');
      expect(events[1].type).toBe('tool_call');
      expect(events[1].tool?.name).toBe('file_read');
      expect(events[1].tool?.originalName).toBe('Read');
    });

    it('parses tool_result messages', () => {
      const transcript = JSON.stringify({
        type: 'tool_result',
        content: 'file contents here',
        tool_use_id: 'toolu_123',
      });
      const { events } = parseClaudeCodeTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_result');
      expect(events[0].tool?.result).toBe('file contents here');
    });

    it('parses thinking blocks', () => {
      const transcript = JSON.stringify({
        type: 'assistant',
        content: [{ type: 'thinking', thinking: 'Let me think about this...' }],
      });
      const { events } = parseClaudeCodeTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('thinking');
      expect(events[0].content).toBe('Let me think about this...');
    });

    it('normalizes various tool names', () => {
      const tools = [
        { name: 'Read', expected: 'file_read' },
        { name: 'read_file', expected: 'file_read' },
        { name: 'Write', expected: 'file_write' },
        { name: 'Bash', expected: 'shell' },
        { name: 'WebFetch', expected: 'web_fetch' },
        { name: 'Glob', expected: 'glob' },
        { name: 'Grep', expected: 'grep' },
        { name: 'unknown_tool', expected: 'unknown' },
      ];

      for (const { name, expected } of tools) {
        const transcript = JSON.stringify({
          type: 'assistant',
          content: [{ type: 'tool_use', name, input: {} }],
        });
        const { events } = parseClaudeCodeTranscript(transcript);
        expect(events[0].tool?.name).toBe(expected);
      }
    });

    it('extracts file paths from tool args', () => {
      const transcript = JSON.stringify({
        type: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { path: 'src/utils.ts' } }],
      });
      const { events } = parseClaudeCodeTranscript(transcript);

      expect(events[0].tool?.args?._extractedPath).toBe('src/utils.ts');
    });

    it('extracts URLs from web fetch args', () => {
      const transcript = JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'tool_use', name: 'WebFetch', input: { url: 'https://api.example.com/data' } },
        ],
      });
      const { events } = parseClaudeCodeTranscript(transcript);

      expect(events[0].tool?.args?._extractedUrl).toBe('https://api.example.com/data');
    });

    it('extracts commands from shell args', () => {
      const transcript = JSON.stringify({
        type: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm install' } }],
      });
      const { events } = parseClaudeCodeTranscript(transcript);

      expect(events[0].tool?.args?._extractedCommand).toBe('npm install');
    });
  });

  describe('Codex parser', () => {
    it('parses message events', () => {
      const transcript = '{"type":"message","role":"assistant","content":"Hello"}';
      const { events } = parseCodexTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message');
      expect(events[0].role).toBe('assistant');
    });

    it('parses function_call events', () => {
      const transcript = JSON.stringify({
        type: 'function_call',
        function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' },
      });
      const { events } = parseCodexTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call');
      expect(events[0].tool?.name).toBe('file_read');
    });

    it('parses function_result events', () => {
      const transcript = JSON.stringify({
        type: 'function_result',
        result: 'file contents',
        success: true,
      });
      const { events } = parseCodexTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_result');
      expect(events[0].tool?.success).toBe(true);
    });

    it('parses current Codex web search item events', () => {
      const transcript = [
        JSON.stringify({
          type: 'item.started',
          item: { id: 'item_1', type: 'web_search', query: 'Vercel AI Gateway docs' },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'item_1',
            type: 'web_search',
            query: 'Vercel AI Gateway docs',
            status: 'completed',
          },
        }),
      ].join('\n');
      const { events } = parseCodexTranscript(transcript);

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('tool_call');
      expect(events[0].tool?.name).toBe('web_search');
      expect(events[0].tool?.args?.query).toBe('Vercel AI Gateway docs');
      expect(events[1].type).toBe('tool_result');
      expect(events[1].tool?.success).toBe(true);
    });
  });

  describe('OpenCode parser', () => {
    it('parses message events', () => {
      const transcript = '{"kind":"message","message":{"role":"assistant","content":"Hello"}}';
      const { events } = parseOpenCodeTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message');
    });

    it('parses tool_call events', () => {
      const transcript = JSON.stringify({
        kind: 'tool_call',
        tool: 'read',
        input: { path: 'src/index.ts' },
      });
      const { events } = parseOpenCodeTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call');
      expect(events[0].tool?.name).toBe('file_read');
    });
  });

  describe('fx parser', () => {
    it('parses saved messages, terminal commands, and web fetches', () => {
      const transcript = JSON.stringify({
        kind: 'session_detail',
        id: 'session-1',
        created_at_ms: 1787000000000,
        updated_at_ms: 1787000005000,
        history: [
          {
            kind: 'assistant',
            user: { text: 'Research fx', images: [] },
            assistant: 'The official site is https://fx.sh/.',
            execution: {
              schema_version: 2,
              tool_steps: [
                {
                  assistant: null,
                  tool_calls: [
                    {
                      id: 'terminal-1',
                      name: 'terminal',
                      arguments_json: JSON.stringify({
                        request: { action: 'exec', command: 'npm test' },
                      }),
                      provider_result: null,
                    },
                    {
                      id: 'fetch-1',
                      name: 'web_fetch',
                      arguments_json: JSON.stringify({ url: 'https://fx.sh/docs' }),
                      provider_result: null,
                    },
                  ],
                  tool_results: [
                    {
                      tool_call_id: 'terminal-1',
                      tool_name: 'terminal',
                      status: 'success',
                      output: 'exit_code=0\nTests passed',
                      created_at_ms: 1787000001000,
                    },
                    {
                      tool_call_id: 'fetch-1',
                      tool_name: 'web_fetch',
                      status: 'success',
                      output: '<url>https://fx.sh/docs</url>\n<status>200</status>',
                      created_at_ms: 1787000002000,
                    },
                  ],
                },
              ],
              files: [],
            },
          },
        ],
      });

      const parsed = parseTranscript(transcript, 'vercel-ai-gateway/fx');
      expect(parsed.parseSuccess).toBe(true);
      expect(parsed.summary.totalTurns).toBe(1);
      expect(parsed.summary.toolCalls.shell).toBe(1);
      expect(parsed.summary.toolCalls.web_fetch).toBe(1);
      expect(parsed.summary.shellCommands).toEqual([
        { command: 'npm test', exitCode: 0, success: true },
      ]);
      expect(parsed.summary.webFetches).toEqual([
        { url: 'https://fx.sh/docs', success: true },
      ]);
      expect(parsed.events.at(-1)?.content).toBe('The official site is https://fx.sh/.');
    });

    it('uses file evidence when a tool argument has no path', () => {
      const transcript = JSON.stringify({
        kind: 'session_detail',
        history: [
          {
            kind: 'assistant',
            user: { text: 'Read the config', images: [] },
            assistant: 'Done',
            execution: {
              schema_version: 2,
              tool_steps: [
                {
                  assistant: null,
                  tool_calls: [
                    { id: 'read-1', name: 'read_file', arguments_json: '{}' },
                  ],
                  tool_results: [],
                },
              ],
              files: [
                {
                  path: 'src/config.ts',
                  new_path: null,
                  tool_call_id: 'read-1',
                  tool_name: 'read_file',
                  action: 'read',
                  status: 'success',
                },
              ],
            },
          },
        ],
      });

      const parsed = parseTranscript(transcript, 'fx');
      expect(parsed.summary.filesRead).toEqual(['src/config.ts']);
    });

    it('parses the ask JSON fallback when session capture is unavailable', () => {
      const transcript = JSON.stringify({
        output: 'Found https://fx.sh/.',
        exit_code: 0,
        model: 'openai/gpt-5.6-sol',
        session_id: '',
        steps: 1,
        tool_calls: [
          {
            name: 'web_fetch',
            status: 'success',
            web_fetch: { url: 'https://fx.sh/', status: 200 },
          },
        ],
      });

      const { events, errors } = parseFxTranscript(transcript);
      expect(errors).toEqual([]);
      expect(events.some((event) => event.type === 'message' && event.content === 'Found https://fx.sh/.')).toBe(true);
      expect(events.find((event) => event.type === 'tool_call')?.tool?.args?._extractedUrl).toBe('https://fx.sh/');
    });

    it('reports malformed transcript JSON', () => {
      expect(parseFxTranscript('not json').errors[0]).toContain('Failed to parse fx transcript');
    });
  });

  describe('Gemini parser', () => {
    it('parses tool_use events', () => {
      const transcript = JSON.stringify({
        type: 'tool_use',
        timestamp: 1770529147689,
        part: {
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'ls -R' },
            output: 'file1.ts\nfile2.ts',
          },
        },
      });
      const { events } = parseGeminiTranscript(transcript);

      expect(events).toHaveLength(2); // tool_call + tool_result
      expect(events[0].type).toBe('tool_call');
      expect(events[0].tool?.name).toBe('shell');
      expect(events[0].tool?.originalName).toBe('bash');
      expect(events[1].type).toBe('tool_result');
      expect(events[1].tool?.success).toBe(true);
    });

    it('parses text events as assistant messages', () => {
      const transcript = JSON.stringify({
        type: 'text',
        timestamp: 1770529219539,
        part: { type: 'text', text: 'I have completed the task.' },
      });
      const { events } = parseGeminiTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message');
      expect(events[0].role).toBe('assistant');
      expect(events[0].content).toBe('I have completed the task.');
    });

    it('skips step_start and step_finish events', () => {
      const transcript = [
        JSON.stringify({ type: 'step_start', timestamp: 1770529147627 }),
        JSON.stringify({ type: 'step_finish', timestamp: 1770529147699 }),
      ].join('\n');
      const { events } = parseGeminiTranscript(transcript);

      expect(events).toHaveLength(0);
    });

    it('normalizes Gemini tool names', () => {
      const tools = [
        { name: 'read', expected: 'file_read' },
        { name: 'write', expected: 'file_write' },
        { name: 'edit', expected: 'file_edit' },
        { name: 'bash', expected: 'shell' },
        { name: 'glob', expected: 'glob' },
        { name: 'list_directory', expected: 'list_dir' },
        { name: 'unknown_tool', expected: 'unknown' },
      ];

      for (const { name, expected } of tools) {
        const transcript = JSON.stringify({
          type: 'tool_use',
          timestamp: 1770529147689,
          part: { type: 'tool', tool: name, state: { status: 'pending', input: {} } },
        });
        const { events } = parseGeminiTranscript(transcript);
        expect(events[0].tool?.name).toBe(expected);
      }
    });

    it('converts epoch ms timestamps to ISO strings', () => {
      const transcript = JSON.stringify({
        type: 'text',
        timestamp: 1770529219539,
        part: { type: 'text', text: 'Hello' },
      });
      const { events } = parseGeminiTranscript(transcript);

      expect(events[0].timestamp).toBe(new Date(1770529219539).toISOString());
    });

    it('extracts file paths from tool args', () => {
      const transcript = JSON.stringify({
        type: 'tool_use',
        timestamp: 1770529147689,
        part: {
          type: 'tool',
          tool: 'read',
          state: { status: 'pending', input: { path: 'src/index.ts' } },
        },
      });
      const { events } = parseGeminiTranscript(transcript);

      expect(events[0].tool?.args?._extractedPath).toBe('src/index.ts');
    });

    it('extracts commands from shell tool args', () => {
      const transcript = JSON.stringify({
        type: 'tool_use',
        timestamp: 1770529147689,
        part: {
          type: 'tool',
          tool: 'bash',
          state: { status: 'pending', input: { command: 'npm test' } },
        },
      });
      const { events } = parseGeminiTranscript(transcript);

      expect(events[0].tool?.args?._extractedCommand).toBe('npm test');
    });

    // --- Direct-API format tests ---

    it('parses direct-API tool_use events with tool_name/parameters', () => {
      const transcript = JSON.stringify({
        type: 'tool_use',
        timestamp: '2026-02-12T20:21:56.095Z',
        tool_name: 'read_file',
        tool_id: 'read_file-1770927716095-abc',
        parameters: { file_path: 'package.json' },
      });
      const { events } = parseGeminiTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call');
      expect(events[0].tool?.name).toBe('file_read');
      expect(events[0].tool?.originalName).toBe('read_file');
      expect(events[0].tool?.args?._extractedPath).toBe('package.json');
      expect(events[0].timestamp).toBe('2026-02-12T20:21:56.095Z');
    });

    it('parses direct-API tool_result events', () => {
      const transcript = JSON.stringify({
        type: 'tool_result',
        timestamp: '2026-02-12T20:21:57.039Z',
        tool_id: 'read_file-1770927716095-abc',
        status: 'success',
        output: 'file contents',
      });
      const { events } = parseGeminiTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_result');
      expect(events[0].tool?.name).toBe('file_read');
      expect(events[0].tool?.success).toBe(true);
      expect(events[0].tool?.result).toBe('file contents');
    });

    it('parses direct-API error tool_result events', () => {
      const transcript = JSON.stringify({
        type: 'tool_result',
        timestamp: '2026-02-12T20:22:28.806Z',
        tool_id: 'list_directory-1770927747602-abc',
        status: 'error',
        output: 'Error: Failed to list directory.',
        error: { type: 'ls_execution_error', message: 'ENOENT' },
      });
      const { events } = parseGeminiTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].tool?.name).toBe('list_dir');
      expect(events[0].tool?.success).toBe(false);
    });

    it('aggregates contiguous assistant delta messages into one event', () => {
      const transcript = [
        JSON.stringify({
          type: 'message',
          timestamp: '2026-02-12T20:21:55.630Z',
          role: 'assistant',
          content: 'I will',
          delta: true,
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-02-12T20:21:55.875Z',
          role: 'assistant',
          content: ' read the files.',
          delta: true,
        }),
      ].join('\n');
      const { events } = parseGeminiTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message');
      expect(events[0].role).toBe('assistant');
      expect(events[0].content).toBe('I will read the files.');
    });

    it('parses direct-API non-delta messages', () => {
      const transcript = JSON.stringify({
        type: 'message',
        timestamp: '2026-02-12T20:21:50.503Z',
        role: 'user',
        content: 'Migrate this project.',
      });
      const { events } = parseGeminiTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message');
      expect(events[0].role).toBe('user');
    });

    it('normalizes direct-API tool names', () => {
      const tools = [
        { name: 'read_file', expected: 'file_read' },
        { name: 'write_file', expected: 'file_write' },
        { name: 'list_directory', expected: 'list_dir' },
        { name: 'run_shell_command', expected: 'shell' },
      ];

      for (const { name, expected } of tools) {
        const transcript = JSON.stringify({
          type: 'tool_use',
          timestamp: '2026-02-12T20:21:56.095Z',
          tool_name: name,
          tool_id: `${name}-123`,
          parameters: {},
        });
        const { events } = parseGeminiTranscript(transcript);
        expect(events[0].tool?.name).toBe(expected);
      }
    });

    it('extracts shell commands from direct-API run_shell_command', () => {
      const transcript = JSON.stringify({
        type: 'tool_use',
        timestamp: '2026-02-12T20:22:11.570Z',
        tool_name: 'run_shell_command',
        tool_id: 'run_shell_command-123',
        parameters: { command: 'mkdir app' },
      });
      const { events } = parseGeminiTranscript(transcript);

      expect(events[0].tool?.name).toBe('shell');
      expect(events[0].tool?.args?._extractedCommand).toBe('mkdir app');
    });

    it('handles a full direct-API transcript end-to-end', () => {
      const transcript = [
        JSON.stringify({ type: 'init', timestamp: '2026-02-12T20:21:50.502Z', model: 'gemini-3-pro-preview' }),
        JSON.stringify({ type: 'message', timestamp: '2026-02-12T20:21:50.503Z', role: 'user', content: 'Migrate this project.' }),
        JSON.stringify({ type: 'message', timestamp: '2026-02-12T20:21:55.630Z', role: 'assistant', content: 'I will read', delta: true }),
        JSON.stringify({ type: 'tool_use', timestamp: '2026-02-12T20:21:56.095Z', tool_name: 'read_file', tool_id: 'read_file-1', parameters: { file_path: 'pkg.json' } }),
        JSON.stringify({ type: 'tool_result', timestamp: '2026-02-12T20:21:57.039Z', tool_id: 'read_file-1', status: 'success', output: '{}' }),
        JSON.stringify({ type: 'tool_use', timestamp: '2026-02-12T20:22:11.570Z', tool_name: 'run_shell_command', tool_id: 'run_shell_command-2', parameters: { command: 'mkdir app' } }),
        JSON.stringify({ type: 'tool_result', timestamp: '2026-02-12T20:22:12.565Z', tool_id: 'run_shell_command-2', status: 'success', output: '' }),
        JSON.stringify({ type: 'tool_use', timestamp: '2026-02-12T20:22:12.518Z', tool_name: 'write_file', tool_id: 'write_file-3', parameters: { file_path: 'app/layout.tsx', content: 'export default ...' } }),
        JSON.stringify({ type: 'tool_result', timestamp: '2026-02-12T20:22:12.565Z', tool_id: 'write_file-3', status: 'success' }),
      ].join('\n');

      const result = parseTranscript(transcript, 'gemini');

      expect(result.parseSuccess).toBe(true);
      expect(result.summary.totalTurns).toBe(1); // deltas aggregated into one assistant turn
      expect(result.summary.toolCalls.file_read).toBe(1);
      expect(result.summary.toolCalls.shell).toBe(1);
      expect(result.summary.toolCalls.file_write).toBe(1);
      expect(result.summary.totalToolCalls).toBe(3);
      expect(result.summary.filesRead).toContain('pkg.json');
      expect(result.summary.filesModified).toContain('app/layout.tsx');
      expect(result.summary.shellCommands).toHaveLength(1);
      expect(result.summary.shellCommands[0].command).toBe('mkdir app');
    });

    // --- CLI format tests (continued) ---

    it('detects shell command failure via exit code', () => {
      const transcript = JSON.stringify({
        type: 'tool_use',
        timestamp: 1770529147689,
        part: {
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'exit 1' },
            output: '',
            metadata: { exit: 1 },
          },
        },
      });
      const { events } = parseGeminiTranscript(transcript);

      const result = events.find((e) => e.type === 'tool_result');
      expect(result?.tool?.success).toBe(false);
    });
  });

  describe('Cursor parser', () => {
    it('parses tool_call started events', () => {
      const transcript = JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tool_123',
        tool_call: {
          readToolCall: {
            args: { path: 'src/index.ts' },
          },
        },
        timestamp_ms: 1770927682606,
      });
      const { events } = parseCursorTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call');
      expect(events[0].tool?.name).toBe('file_read');
      expect(events[0].tool?.originalName).toBe('readToolCall');
    });

    it('parses tool_call completed events as tool_result', () => {
      const transcript = JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'tool_123',
        tool_call: {
          readToolCall: {
            args: { path: 'src/index.ts' },
            result: { success: { content: 'file contents' } },
          },
        },
        timestamp_ms: 1770927682700,
      });
      const { events } = parseCursorTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_result');
      expect(events[0].tool?.success).toBe(true);
    });

    it('parses assistant messages from content array', () => {
      const transcript = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Let me help you.' }],
        },
        timestamp_ms: 1770927682606,
      });
      const { events } = parseCursorTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message');
      expect(events[0].role).toBe('assistant');
      expect(events[0].content).toBe('Let me help you.');
    });

    it('parses user messages', () => {
      const transcript = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Migrate this project.' }],
        },
      });
      const { events } = parseCursorTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message');
      expect(events[0].role).toBe('user');
      expect(events[0].content).toBe('Migrate this project.');
    });

    it('emits thinking only for completed subtype', () => {
      const transcript = [
        JSON.stringify({
          type: 'thinking',
          subtype: 'delta',
          text: 'partial thought...',
          timestamp_ms: 1770927682138,
        }),
        JSON.stringify({
          type: 'thinking',
          subtype: 'completed',
          text: 'full thought',
          timestamp_ms: 1770927682577,
        }),
      ].join('\n');
      const { events } = parseCursorTranscript(transcript);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('thinking');
    });

    it('skips system and result events', () => {
      const transcript = [
        JSON.stringify({ type: 'system', subtype: 'init', model: 'Composer 1.5' }),
        JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 40784 }),
      ].join('\n');
      const { events } = parseCursorTranscript(transcript);

      expect(events).toHaveLength(0);
    });

    it('normalizes Cursor tool call keys', () => {
      const tools = [
        { key: 'readToolCall', expected: 'file_read' },
        { key: 'editToolCall', expected: 'file_edit' },
        { key: 'deleteToolCall', expected: 'file_write' },
        { key: 'lsToolCall', expected: 'list_dir' },
        { key: 'globToolCall', expected: 'glob' },
        { key: 'shellToolCall', expected: 'shell' },
        { key: 'readLintsToolCall', expected: 'unknown' },
        { key: 'updateTodosToolCall', expected: 'agent_task' },
      ];

      for (const { key, expected } of tools) {
        const transcript = JSON.stringify({
          type: 'tool_call',
          subtype: 'started',
          tool_call: { [key]: { args: {} } },
          timestamp_ms: 1770927682606,
        });
        const { events } = parseCursorTranscript(transcript);
        expect(events[0].tool?.name).toBe(expected);
      }
    });

    it('converts timestamp_ms to ISO strings', () => {
      const transcript = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
        timestamp_ms: 1770927682606,
      });
      const { events } = parseCursorTranscript(transcript);

      expect(events[0].timestamp).toBe(new Date(1770927682606).toISOString());
    });

    it('extracts file paths from tool args', () => {
      const transcript = JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        tool_call: { readToolCall: { args: { path: 'src/utils.ts' } } },
        timestamp_ms: 1770927682606,
      });
      const { events } = parseCursorTranscript(transcript);

      expect(events[0].tool?.args?._extractedPath).toBe('src/utils.ts');
    });

    it('extracts commands from shell tool args', () => {
      const transcript = JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        tool_call: { shellToolCall: { args: { command: 'npm install' } } },
        timestamp_ms: 1770927682606,
      });
      const { events } = parseCursorTranscript(transcript);

      expect(events[0].tool?.args?._extractedCommand).toBe('npm install');
    });

    it('handles multiline transcripts with mixed events', () => {
      const transcript = [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'Do something' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
          timestamp_ms: 1770927682606,
        }),
        JSON.stringify({
          type: 'tool_call',
          subtype: 'started',
          tool_call: { readToolCall: { args: { path: 'a.ts' } } },
          timestamp_ms: 1770927682700,
        }),
        JSON.stringify({
          type: 'tool_call',
          subtype: 'completed',
          tool_call: { readToolCall: { args: { path: 'a.ts' }, result: { success: {} } } },
          timestamp_ms: 1770927682800,
        }),
      ].join('\n');

      const result = parseTranscript(transcript, 'cursor');

      expect(result.parseSuccess).toBe(true);
      expect(result.summary.totalTurns).toBe(1);
      expect(result.summary.toolCalls.file_read).toBe(1);
      expect(result.summary.totalToolCalls).toBe(1);
      expect(result.summary.filesRead).toContain('a.ts');
    });
  });

  describe('Summary generation', () => {
    it('counts tool calls correctly', () => {
      const transcript = [
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'tool_use', name: 'Read', input: { path: 'a.ts' } }],
        }),
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'tool_use', name: 'Read', input: { path: 'b.ts' } }],
        }),
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'tool_use', name: 'Write', input: { path: 'c.ts' } }],
        }),
      ].join('\n');

      const result = parseTranscript(transcript, 'claude-code');

      expect(result.summary.toolCalls.file_read).toBe(2);
      expect(result.summary.toolCalls.file_write).toBe(1);
      expect(result.summary.totalToolCalls).toBe(3);
    });

    it('tracks files read and modified', () => {
      const transcript = [
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'tool_use', name: 'Read', input: { path: 'src/a.ts' } }],
        }),
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'tool_use', name: 'Write', input: { path: 'src/b.ts' } }],
        }),
      ].join('\n');

      const result = parseTranscript(transcript, 'claude-code');

      expect(result.summary.filesRead).toContain('src/a.ts');
      expect(result.summary.filesModified).toContain('src/b.ts');
    });

    it('tracks web fetches', () => {
      const transcript = JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'tool_use', name: 'WebFetch', input: { url: 'https://api.example.com' } },
        ],
      });

      const result = parseTranscript(transcript, 'claude-code');

      expect(result.summary.webFetches).toHaveLength(1);
      expect(result.summary.webFetches[0].url).toBe('https://api.example.com');
    });

    it('tracks shell commands', () => {
      const transcript = JSON.stringify({
        type: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
      });

      const result = parseTranscript(transcript, 'claude-code');

      expect(result.summary.shellCommands).toHaveLength(1);
      expect(result.summary.shellCommands[0].command).toBe('npm test');
    });

    it('counts thinking blocks', () => {
      const transcript = [
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'thinking', thinking: 'First thought' }],
        }),
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'thinking', thinking: 'Second thought' }],
        }),
      ].join('\n');

      const result = parseTranscript(transcript, 'claude-code');

      expect(result.summary.thinkingBlocks).toBe(2);
    });

    it('counts assistant turns', () => {
      const transcript = [
        '{"type":"user","content":"Question 1"}',
        '{"type":"assistant","content":"Answer 1"}',
        '{"type":"user","content":"Question 2"}',
        '{"type":"assistant","content":"Answer 2"}',
      ].join('\n');

      const result = parseTranscript(transcript, 'claude-code');

      expect(result.summary.totalTurns).toBe(2);
    });
  });

  describe('Error handling', () => {
    it('handles malformed JSON lines gracefully', () => {
      const transcript = [
        '{"type":"assistant","content":"Valid"}',
        'not valid json',
        '{"type":"user","content":"Also valid"}',
      ].join('\n');

      const result = parseTranscript(transcript, 'claude-code');

      // Should still parse the valid lines
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.parseSuccess).toBe(true); // Individual line errors don't fail the whole parse
    });

    it('handles empty lines', () => {
      const transcript = [
        '{"type":"assistant","content":"Hello"}',
        '',
        '   ',
        '{"type":"user","content":"Hi"}',
      ].join('\n');

      const result = parseTranscript(transcript, 'claude-code');

      expect(result.events).toHaveLength(2);
    });
  });

  describe('loadTranscript', () => {
    it('parses raw JSONL transcripts when agent is provided', () => {
      const raw = '{"type":"assistant","content":"Hello"}';
      const result = loadTranscript(raw, 'claude-code');

      expect(result.agent).toBe('claude-code');
      expect(result.events).toHaveLength(1);
      expect(result.parseSuccess).toBe(true);
    });

    it('returns parsed transcripts directly', () => {
      const transcript: Transcript = {
        agent: 'claude-code',
        model: 'opus',
        events: [
          { type: 'message', role: 'assistant', content: 'Hello' },
        ],
        summary: {
          totalTurns: 1,
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
            agent_task: 0,
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
      };

      const result = loadTranscript(JSON.stringify(transcript));

      expect(result).toEqual(transcript);
      expect(result.agent).toBe('claude-code');
      expect(result.model).toBe('opus');
    });

    it('throws error for raw transcripts without agent', () => {
      const raw = '{"type":"assistant","content":"Hello"}';
      
      expect(() => loadTranscript(raw)).toThrow('Agent type is required');
    });

    it('does not require agent for parsed transcripts', () => {
      const transcript: Transcript = {
        agent: 'codex',
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
            agent_task: 0,
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
      };

      // Should not throw even without agent
      const result = loadTranscript(JSON.stringify(transcript));
      expect(result.agent).toBe('codex');
    });

    it('distinguishes JSONL from single-line JSON', () => {
      // Multi-line JSONL should be treated as raw
      const jsonl = [
        '{"type":"assistant","content":"Line 1"}',
        '{"type":"user","content":"Line 2"}',
      ].join('\n');

      const result = loadTranscript(jsonl, 'claude-code');

      expect(result.events).toHaveLength(2);
    });
  });
});

/**
 * Token usage fixtures follow each CLI's real output shape: Claude Code session
 * JSONL, `codex exec --json` events and saved session files, `opencode run
 * --format json` events, Gemini CLI `stream-json`, and `fx ask --json`.
 */
describe('token usage', () => {
  const jsonl = (...lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n');

  describe('Claude Code', () => {
    // One assistant message with thinking, text, and a tool call is written as
    // three lines sharing message.id. The first line is an early snapshot whose
    // output count is still growing.
    const assistantLine = (
      id: string,
      content: unknown[],
      usage: Record<string, number | null>,
      extra: Record<string, unknown> = {},
    ) => ({
      type: 'assistant',
      sessionId: 'b4c1',
      requestId: `req_${id}`,
      message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content, usage },
      ...extra,
    });

    const firstUsage = { input_tokens: 4, cache_creation_input_tokens: 2361, cache_read_input_tokens: 12001, output_tokens: 129 };
    const secondUsage = { input_tokens: 6, cache_creation_input_tokens: 412, cache_read_input_tokens: 14362, output_tokens: 87 };

    const transcript = jsonl(
      { type: 'user', message: { role: 'user', content: 'Add a Button component' } },
      assistantLine('msg_01', [{ type: 'thinking', thinking: 'Plan' }], { ...firstUsage, output_tokens: 8 }),
      assistantLine('msg_01', [{ type: 'text', text: 'Creating the file.' }], firstUsage),
      assistantLine('msg_01', [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: 'src/Button.tsx' } }], firstUsage),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } },
      assistantLine('msg_02', [{ type: 'text', text: 'Done.' }], secondUsage),
    );

    it('counts each assistant message once, however many lines repeat it', () => {
      const { summary } = parseTranscript(transcript, 'vercel-ai-gateway/claude-code');

      expect(summary.usage).toEqual({
        inputTokens: 10,
        outputTokens: 216,
        cacheReadTokens: 26363,
        cacheWriteTokens: 2773,
        totalTokens: 29362,
      });
    });

    it('treats null cache counts as no caching', () => {
      const { summary } = parseTranscript(
        jsonl(assistantLine('msg_03', [{ type: 'text', text: 'Hi' }], {
          input_tokens: 12,
          output_tokens: 3,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        })),
        'claude-code',
      );

      expect(summary.usage).toEqual({
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
      });
    });

    it('reports cost only when every message carries the CLI-reported costUSD', () => {
      const withCost = jsonl(
        assistantLine('msg_a', [{ type: 'text', text: 'a' }], firstUsage, { costUSD: 0.0123 }),
        assistantLine('msg_a', [{ type: 'text', text: 'a' }], firstUsage, { costUSD: 0.0123 }),
        assistantLine('msg_b', [{ type: 'text', text: 'b' }], secondUsage, { costUSD: 0.0045 }),
      );
      const partialCost = jsonl(
        assistantLine('msg_a', [{ type: 'text', text: 'a' }], firstUsage, { costUSD: 0.0123 }),
        assistantLine('msg_b', [{ type: 'text', text: 'b' }], secondUsage),
      );

      expect(parseTranscript(withCost, 'claude-code').summary.usage?.costUsd).toBeCloseTo(0.0168, 10);
      expect(parseTranscript(partialCost, 'claude-code').summary.usage?.costUsd).toBeUndefined();
    });

    it('is undefined when no assistant message reports usage', () => {
      const { summary } = parseTranscript(
        jsonl({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } }),
        'claude-code',
      );

      expect(summary.usage).toBeUndefined();
    });
  });

  describe('Codex', () => {
    const execTranscript = (usage: Record<string, number>) =>
      jsonl(
        { type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Planning**' } },
        { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: 'README.md\n', exit_code: 0, status: 'completed' } },
        { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Done.' } },
        { type: 'turn.completed', usage },
      );

    it('reads turn.completed usage and separates cached input from uncached input', () => {
      const { summary } = parseTranscript(
        execTranscript({
          input_tokens: 24763,
          cached_input_tokens: 24448,
          cache_write_input_tokens: 0,
          output_tokens: 122,
          reasoning_output_tokens: 64,
        }),
        'vercel-ai-gateway/codex',
      );

      expect(summary.usage).toEqual({
        inputTokens: 315,
        outputTokens: 122,
        cacheReadTokens: 24448,
        cacheWriteTokens: 0,
        reasoningTokens: 64,
        totalTokens: 24885,
      });
    });

    it('handles older CLIs that report only input, cached, and output tokens', () => {
      const { summary } = parseTranscript(
        execTranscript({ input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 }),
        'codex',
      );

      expect(summary.usage).toEqual({
        inputTokens: 800,
        outputTokens: 50,
        cacheReadTokens: 200,
        totalTokens: 1050,
      });
    });

    it('treats turn.completed usage as a running total for its thread', () => {
      const transcript = jsonl(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } },
        { type: 'turn.completed', usage: { input_tokens: 250, cached_input_tokens: 100, output_tokens: 30 } },
      );

      expect(parseTranscript(transcript, 'codex').summary.usage).toEqual({
        inputTokens: 150,
        outputTokens: 30,
        cacheReadTokens: 100,
        totalTokens: 280,
      });
    });

    it('reads the last token_count total from a saved session file', () => {
      const tokenCount = (total: Record<string, number> | null) => ({
        timestamp: '2026-09-30T10:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: total && { total_token_usage: total, last_token_usage: total, model_context_window: 272000 },
          rate_limits: null,
        },
      });
      const transcript = jsonl(
        { timestamp: '2026-09-30T09:59:00.000Z', type: 'session_meta', payload: { id: 'thread-1', cli_version: '0.144.0' } },
        tokenCount({ input_tokens: 2000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 32, total_tokens: 2100 }),
        tokenCount(null),
        tokenCount({ input_tokens: 5000, cached_input_tokens: 3000, output_tokens: 400, reasoning_output_tokens: 128, total_tokens: 5400 }),
      );

      expect(parseTranscript(transcript, 'codex').summary.usage).toEqual({
        inputTokens: 2000,
        outputTokens: 400,
        cacheReadTokens: 3000,
        reasoningTokens: 128,
        totalTokens: 5400,
      });
    });

    it('is undefined when the run never completed a turn', () => {
      const transcript = jsonl(
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.failed', error: { message: 'stream disconnected' } },
      );

      expect(parseTranscript(transcript, 'codex').summary.usage).toBeUndefined();
    });
  });

  describe('OpenCode', () => {
    const stepFinish = (id: string, tokens: Record<string, unknown>, cost: number) => ({
      type: 'step_finish',
      timestamp: 1770529147699,
      sessionID: 'ses_1',
      part: { id, sessionID: 'ses_1', messageID: 'msg_1', type: 'step-finish', reason: 'tool-calls', cost, tokens },
    });
    const first = stepFinish('prt_1', { total: 13250, input: 1200, output: 50, reasoning: 0, cache: { read: 12000, write: 0 } }, 0.0071);
    const second = stepFinish('prt_2', { total: 13600, input: 300, output: 200, reasoning: 100, cache: { read: 13000, write: 0 } }, 0.0102);

    it('sums step_finish usage and cost once per step', () => {
      const transcript = jsonl(
        { type: 'step_start', timestamp: 1770529140000, sessionID: 'ses_1', part: { id: 'prt_0', type: 'step-start' } },
        { type: 'tool_use', timestamp: 1770529141000, sessionID: 'ses_1', part: { tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a' } } },
        first,
        { type: 'text', timestamp: 1770529148000, sessionID: 'ses_1', part: { text: 'Done' } },
        second,
        second, // the same part emitted twice must not be counted twice
      );

      const usage = parseTranscript(transcript, 'vercel-ai-gateway/opencode').summary.usage;
      expect(usage).toMatchObject({
        inputTokens: 1500,
        outputTokens: 250,
        reasoningTokens: 100,
        cacheReadTokens: 25000,
        cacheWriteTokens: 0,
        totalTokens: 26850,
      });
      expect(usage?.costUsd).toBeCloseTo(0.0173, 10);
    });

    it('leaves totalTokens unset for versions that report no step total', () => {
      const transcript = jsonl(
        stepFinish('prt_1', { input: 1200, output: 50, reasoning: 0, cache: { read: 12000, write: 0 } }, 0),
      );

      expect(parseTranscript(transcript, 'vercel-ai-gateway/opencode').summary.usage).toEqual({
        inputTokens: 1200,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 12000,
        cacheWriteTokens: 0,
        costUsd: 0,
      });
    });

    it('is undefined when no step finished', () => {
      const transcript = jsonl(
        { type: 'text', timestamp: 1770529148000, sessionID: 'ses_1', part: { text: 'Hello' } },
      );

      expect(parseTranscript(transcript, 'vercel-ai-gateway/opencode').summary.usage).toBeUndefined();
    });
  });

  describe('Gemini', () => {
    it('reads the session totals from the result event', () => {
      const transcript = jsonl(
        { type: 'init', timestamp: '2026-09-30T10:00:00.000Z', session_id: 'abc', model: 'gemini-2.5-pro' },
        { type: 'message', timestamp: '2026-09-30T10:00:01.000Z', role: 'assistant', content: 'Done', delta: true },
        {
          type: 'result',
          timestamp: '2026-09-30T10:00:20.000Z',
          status: 'success',
          stats: {
            total_tokens: 15302,
            input_tokens: 14210,
            output_tokens: 412,
            cached: 9800,
            input: 4410,
            duration_ms: 18204,
            tool_calls: 3,
            models: {},
          },
        },
      );

      expect(parseTranscript(transcript, 'gemini').summary.usage).toEqual({
        inputTokens: 4410,
        cacheReadTokens: 9800,
        outputTokens: 412,
        totalTokens: 15302,
      });
    });

    it('keeps the full prompt count when an older CLI does not break out the cache', () => {
      const transcript = jsonl({
        type: 'result',
        status: 'success',
        stats: { total_tokens: 900, input_tokens: 800, output_tokens: 100, duration_ms: 1000, tool_calls: 0 },
      });

      expect(parseTranscript(transcript, 'gemini').summary.usage).toEqual({
        inputTokens: 800,
        outputTokens: 100,
        totalTokens: 900,
      });
    });

    it('is undefined when the stream ended without a result event', () => {
      const transcript = jsonl({ type: 'message', role: 'assistant', content: 'partial', delta: true });

      expect(parseTranscript(transcript, 'gemini').summary.usage).toBeUndefined();
    });
  });

  describe('fx', () => {
    const askResult = (usage: Record<string, number | null>) =>
      JSON.stringify({
        output: 'Found it.',
        final_output: 'Found it.',
        exit_code: 0,
        model: 'openai/gpt-5.6-sol',
        resolved_provider: null,
        session_id: '',
        steps: 2,
        usage,
        tool_calls: [],
      });

    it('reads input and output tokens from fx ask JSON', () => {
      expect(parseTranscript(askResult({ input_tokens: 1200, output_tokens: 450 }), 'vercel-ai-gateway/fx').summary.usage).toEqual({
        inputTokens: 1200,
        outputTokens: 450,
        totalTokens: 1650,
      });
    });

    it('is undefined when fx reports null counts or the transcript is a saved session', () => {
      const session = JSON.stringify({ kind: 'session_detail', history: [] });

      expect(parseTranscript(askResult({ input_tokens: null, output_tokens: null }), 'fx').summary.usage).toBeUndefined();
      expect(parseTranscript(session, 'fx').summary.usage).toBeUndefined();
    });
  });

  it('is undefined for Cursor, whose stream-json output reports no token usage', () => {
    const transcript = jsonl(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] }, session_id: 's' },
      { type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, duration_api_ms: 1234, result: 'Done', session_id: 's' },
    );

    expect(parseTranscript(transcript, 'cursor').summary.usage).toBeUndefined();
  });

  it('parseTranscriptUsage reads only the usage, and nothing for unknown agents', () => {
    const transcript = jsonl({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });

    expect(parseTranscriptUsage(transcript, 'codex')).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      totalTokens: 15,
    });
    expect(parseTranscriptUsage(transcript, 'unsupported-agent')).toBeUndefined();
    expect(parseTranscriptUsage(undefined, 'codex')).toBeUndefined();
  });
});
