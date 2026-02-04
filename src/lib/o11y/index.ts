/**
 * Observability module for agent-eval.
 * Provides normalized transcript parsing and analysis across all agents.
 */

// Types
export type {
  NormalizedToolName,
  NormalizedEvent,
  WebFetchInfo,
  FileOperationInfo,
  ShellCommandInfo,
  TranscriptSummary,
  NormalizedTranscript,
} from './types.js';

// Main parsing functions
export { parseTranscript, parseTranscriptSummary } from './parsers/index.js';
export type { ParseableAgent } from './parsers/index.js';

// Individual parsers (for advanced use)
export { parseClaudeCodeTranscript } from './parsers/claude-code.js';
export { parseCodexTranscript } from './parsers/codex.js';
export { parseOpenCodeTranscript } from './parsers/opencode.js';
