/**
 * Tests for the o11y (observability) module.
 */

import { describe, it, expect } from 'vitest';
import { parseTranscript, parseTranscriptSummary, loadTranscript } from './index.js';
import type { Transcript } from './types.js';
import { parseClaudeCodeTranscript } from './parsers/claude-code.js';
import { parseCodexTranscript } from './parsers/codex.js';
import { parseOpenCodeTranscript } from './parsers/opencode.js';

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
    });

    it('returns parseSuccess: false for unsupported agents', () => {
      const transcript = '{"type":"assistant","content":"Hello"}';

      const result = parseTranscript(transcript, 'unsupported-agent');

      expect(result.parseSuccess).toBe(false);
      expect(result.parseErrors).toContain(
        'No parser available for agent: unsupported-agent. Supported agents: claude-code, codex, opencode'
      );
      expect(result.events).toEqual([]);
      expect(result.summary.totalToolCalls).toBe(0);
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
