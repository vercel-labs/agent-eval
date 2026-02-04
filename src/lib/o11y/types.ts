/**
 * Observability types for cross-agent transcript analysis.
 * Provides a unified schema regardless of which agent produced the transcript.
 */

/**
 * Canonical tool names across agents.
 * Maps agent-specific tool names to standardized names.
 */
export type ToolName =
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'shell'
  | 'web_fetch'
  | 'web_search'
  | 'glob'
  | 'grep'
  | 'list_dir'
  | 'agent_task'
  | 'unknown';

/**
 * An event in the transcript.
 */
export interface TranscriptEvent {
  /** ISO timestamp of the event */
  timestamp?: string;

  /** Event type */
  type: 'message' | 'tool_call' | 'tool_result' | 'thinking' | 'error';

  /** For message events: the role */
  role?: 'user' | 'assistant' | 'system';

  /** Text content (for messages, thinking, errors) */
  content?: string;

  /** For tool_call and tool_result events */
  tool?: {
    /** Canonical tool name */
    name: ToolName;
    /** Original tool name from the agent */
    originalName: string;
    /** Tool arguments */
    args?: Record<string, unknown>;
    /** Tool result (for tool_result events) */
    result?: unknown;
    /** Duration in milliseconds (if available) */
    durationMs?: number;
    /** Whether the tool call succeeded */
    success?: boolean;
  };

  /** Raw event data from the agent (for debugging) */
  raw?: unknown;
}

/**
 * Web fetch information extracted from tool calls.
 */
export interface WebFetchInfo {
  /** The URL that was fetched */
  url: string;
  /** HTTP method (if known) */
  method?: string;
  /** HTTP status code (if available) */
  status?: number;
  /** Whether the fetch succeeded */
  success?: boolean;
}

/**
 * File operation information.
 */
export interface FileOperationInfo {
  /** File path */
  path: string;
  /** Operation type */
  operation: 'read' | 'write' | 'edit';
}

/**
 * Shell command information.
 */
export interface ShellCommandInfo {
  /** The command that was run */
  command: string;
  /** Exit code (if available) */
  exitCode?: number;
  /** Whether the command succeeded */
  success?: boolean;
}

/**
 * Summary statistics derived from the transcript.
 */
export interface TranscriptSummary {
  /** Total number of conversation turns */
  totalTurns: number;

  /** Count of each tool type used */
  toolCalls: Record<ToolName, number>;

  /** Total tool calls */
  totalToolCalls: number;

  /** Web fetches made during the run */
  webFetches: WebFetchInfo[];

  /** Files that were read */
  filesRead: string[];

  /** Files that were written or edited */
  filesModified: string[];

  /** Shell commands executed */
  shellCommands: ShellCommandInfo[];

  /** Errors encountered */
  errors: string[];

  /** Thinking/reasoning blocks (if available) */
  thinkingBlocks: number;
}

/**
 * A parsed transcript with events and summary.
 */
export interface Transcript {
  /** Agent that produced this transcript */
  agent: string;

  /** Model used (if known) */
  model?: string;

  /** All events in order */
  events: TranscriptEvent[];

  /** Derived summary statistics */
  summary: TranscriptSummary;

  /** Whether parsing succeeded fully */
  parseSuccess: boolean;

  /** Any parsing warnings/errors */
  parseErrors?: string[];
}
