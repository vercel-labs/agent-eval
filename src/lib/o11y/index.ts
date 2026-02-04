/**
 * Observability module for agent-eval.
 * Provides transcript parsing and analysis across all agents.
 */

// Types
export type {
  ToolName,
  TranscriptEvent,
  WebFetchInfo,
  FileOperationInfo,
  ShellCommandInfo,
  TranscriptSummary,
  Transcript,
} from './types.js';

// Main parsing functions
export { parseTranscript, parseTranscriptSummary, loadTranscript, SUPPORTED_AGENTS } from './parsers/index.js';
export type { ParseableAgent } from './parsers/index.js';

// Individual parsers (for advanced use)
export { parseClaudeCodeTranscript } from './parsers/claude-code.js';
export { parseCodexTranscript } from './parsers/codex.js';
export { parseOpenCodeTranscript } from './parsers/opencode.js';
