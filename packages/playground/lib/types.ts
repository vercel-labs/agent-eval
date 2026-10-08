/**
 * Playground types — mirrors the core agent-eval types for the UI.
 * Kept separate to avoid importing Node.js code into the browser bundle.
 */

/** Canonical tool names across agents */
export type ToolName =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "shell"
  | "web_fetch"
  | "web_search"
  | "glob"
  | "grep"
  | "list_dir"
  | "agent_task"
  | "unknown";

/** An event in the transcript */
export interface TranscriptEvent {
  timestamp?: string;
  type: "message" | "tool_call" | "tool_result" | "thinking" | "error";
  role?: "user" | "assistant" | "system";
  content?: string;
  tool?: {
    name: ToolName;
    originalName: string;
    args?: Record<string, unknown>;
    result?: unknown;
    durationMs?: number;
    success?: boolean;
  };
}

/** Summary statistics derived from the transcript */
export interface TranscriptSummary {
  totalTurns: number;
  toolCalls: Record<ToolName, number>;
  totalToolCalls: number;
  webFetches: { url: string; method?: string; status?: number; success?: boolean }[];
  filesRead: string[];
  filesModified: string[];
  shellCommands: { command: string; exitCode?: number; success?: boolean }[];
  errors: string[];
  thinkingBlocks: number;
}

/** A parsed transcript */
export interface Transcript {
  agent: string;
  model?: string;
  events: TranscriptEvent[];
  summary: TranscriptSummary;
  parseSuccess: boolean;
  parseErrors?: string[];
}

/** Result of a single eval run */
export interface EvalRunResult {
  status: "passed" | "failed";
  error?: string;
  duration: number;
  model?: string;
  transcriptPath?: string;
  transcriptRawPath?: string;
  outputPaths?: {
    eval?: string;
    scripts?: Record<string, string>;
  };
  o11y?: TranscriptSummary;
  /** Token usage the agent CLI reported, when available */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
}

/** Summary of multiple runs for a single eval */
export interface EvalSummary {
  name: string;
  totalRuns: number;
  passedRuns: number;
  passRate: number;
  meanDuration: number;
}

/** Experiment info returned by the API */
export interface ExperimentInfo {
  name: string;
  timestamps: string[];
  latestTimestamp: string;
}

/** Full experiment detail for a specific timestamp */
export interface ExperimentDetail {
  startedAt: string;
  completedAt: string;
  config: {
    agent: string;
    model: string | string[];
    runs: number;
    earlyExit: boolean;
    timeout: number;
  };
  evals: EvalSummary[];
}

/** Run detail with result and optional o11y */
export interface RunDetail {
  result: EvalRunResult;
}

/** Eval fixture info */
export interface EvalInfo {
  name: string;
  prompt: string;
  files: string[];
}
