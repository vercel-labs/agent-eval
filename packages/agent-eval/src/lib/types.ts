/**
 * Core types for the eval framework.
 */

/**
 * Supported AI agent types.
 */
export type AgentType =
  | 'vercel-ai-gateway/claude-code'
  | 'claude-code'
  | 'vercel-ai-gateway/codex'
  | 'codex'
  | 'vercel-ai-gateway/opencode'
  | 'gemini'
  | 'cursor';

/**
 * Model identifier - any string accepted.
 * Each agent validates its own models at runtime.
 */
export type ModelTier = string;

/**
 * Function type for filtering evals.
 */
export type EvalFilter = (name: string) => boolean;

/**
 * Sandbox interface for setup functions.
 * Provides methods to interact with the isolated VM.
 */
export interface Sandbox {
  /** Run a command in the sandbox */
  runCommand(
    command: string,
    args?: string[],
    options?: { env?: Record<string, string> }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Read a file from the sandbox */
  readFile(path: string): Promise<string>;
  /** Write files to the sandbox */
  writeFiles(files: Record<string, string>): Promise<void>;
  /** Get the sandbox working directory */
  getWorkingDirectory(): string;
}

/**
 * Setup function that runs before the agent starts.
 * Receives a sandbox instance for pre-configuration.
 */
export type SetupFunction = (sandbox: Sandbox) => Promise<void>;

/**
 * Sandbox backend type.
 */
export type SandboxBackend = 'vercel' | 'docker';

/**
 * Experiment configuration.
 * Defines what to test and how.
 */
export interface ExperimentConfig {
  /** Which AI agent to use */
  agent: AgentType;

  /** Which AI model the agent should use. Can be a single model or array of models to test.
   * If an array is provided, the experiment will run on each model.
   * Default is agent-specific: 'opus' for claude-code, 'openai/gpt-5.2-codex' for codex */
  model?: ModelTier | ModelTier[];

  /** Which evals to run. Can be a string, array, or filter function. @default '*' (all evals) */
  evals?: string | string[] | EvalFilter;

  /** How many times to run each eval. @default 1 */
  runs?: number;

  /** Stop after first successful run? @default true */
  earlyExit?: boolean;

  /** npm scripts that must pass after agent finishes. @default [] */
  scripts?: string[];

  /** Maximum time in seconds for agent to complete. @default 300 (5 minutes) */
  timeout?: number;

  /** Setup function that runs before agent starts. @default undefined */
  setup?: SetupFunction;

  /** Sandbox backend to use. @default 'auto' (Vercel if token present, else Docker) */
  sandbox?: SandboxBackend | 'auto';

  /** Optional function to modify the prompt before running the experiment. @default undefined */
  editPrompt?: (prompt: string) => string;

  /** Whether to copy project files into the result directory.
   * - 'none': No files are copied (default)
   * - 'changed': Only files the agent changed/created
   * - 'all': Original project files + agent changes overlaid on top
   * @default 'none' */
  copyFiles?: 'none' | 'changed' | 'all';
}

/**
 * Resolved experiment config with all defaults applied.
 */
export interface ResolvedExperimentConfig {
  agent: AgentType;
  model: ModelTier | ModelTier[];
  evals: string | string[] | EvalFilter;
  runs: number;
  earlyExit: boolean;
  scripts: string[];
  timeout: number;
  setup?: SetupFunction;
  sandbox: SandboxBackend | 'auto';
  editPrompt?: (prompt: string) => string;
  copyFiles: 'none' | 'changed' | 'all';
}

/**
 * Resolved experiment config with all defaults applied.
 */
export interface RunnableExperimentConfig {
  agent: AgentType;
  model: ModelTier;
  evals: string | string[] | EvalFilter;
  runs: number;
  earlyExit: boolean;
  scripts: string[];
  timeout: number;
  setup?: SetupFunction;
  sandbox: SandboxBackend | 'auto';
  editPrompt?: (prompt: string) => string;
  copyFiles: 'none' | 'changed' | 'all';
}

/**
 * Required files for a valid eval fixture.
 * Note: Either EVAL.ts or EVAL.tsx is required (not both).
 */
export const REQUIRED_EVAL_FILES = ['PROMPT.md', 'EVAL.ts', 'package.json'] as const;

/**
 * Files excluded when listing fixture files (used by getFixtureFiles in fixture.ts).
 * This is for local fixture introspection, NOT for sandbox uploads.
 * For sandbox file filtering, see TEST_FILE_PATTERNS in sandbox.ts.
 */
export const EXCLUDED_FILES = ['PROMPT.md', 'EVAL.ts', 'EVAL.tsx', 'node_modules', '.git'] as const;

/**
 * Represents a discovered eval fixture.
 */
export interface EvalFixture {
  /** Name of the eval (folder name) */
  name: string;
  /** Absolute path to the eval folder */
  path: string;
  /** Contents of PROMPT.md */
  prompt: string;
  /** Whether package.json has "type": "module" */
  isModule: boolean;
}

/**
 * Result of a single eval run.
 */
export interface EvalRunResult {
  /** Pass or fail status */
  status: 'passed' | 'failed';
  /** Error message if failed */
  error?: string;
  /** Duration in seconds */
  duration: number;
  /** Model used for this run */
  model?: string;
  /** Path to parsed transcript file (relative to run directory) */
  transcriptPath?: string;
  /** Path to raw transcript file (relative to run directory) */
  transcriptRawPath?: string;
  /** Paths to output files (relative to run directory) */
  outputPaths?: {
    /** Path to EVAL.ts test output */
    eval?: string;
    /** Paths to npm script outputs (nested to avoid collision) */
    scripts?: Record<string, string>;
  };
}

/**
 * Internal run data including transcript and outputs (content, not paths).
 */
export interface EvalRunData {
  /** The eval result (will have paths added when saving) */
  result: EvalRunResult;
  /** Structured transcript from Claude Code (saved to transcript.jsonl) */
  transcript?: string;
  /** Script/test output content (saved to outputs/) */
  outputContent?: {
    /** EVAL.ts test output */
    eval?: string;
    /** npm script outputs (nested to avoid collision) */
    scripts?: Record<string, string>;
  };
  /** Files generated/modified by the agent (path -> content). Used for copyFiles option. */
  generatedFiles?: Record<string, string>;
  /** Files deleted by the agent. Used for copyFiles option. */
  deletedFiles?: string[];
}

/**
 * Summary of multiple runs for a single eval.
 */
export interface EvalSummary {
  /** Name of the eval */
  name: string;
  /** Total number of runs */
  totalRuns: number;
  /** Number of passed runs */
  passedRuns: number;
  /** Pass rate as a percentage */
  passRate: number;
  /** Mean duration across all runs */
  meanDuration: number;
  /** Individual run data (internal, not all fields saved to summary.json) */
  runs: EvalRunData[];
}

/**
 * Failure classification for a failed eval run.
 */
export type FailureType = 'model' | 'infra' | 'timeout' | 'eval';

/**
 * Classification result for a failed eval.
 */
export interface Classification {
  failureType: FailureType;
  failureReason: string;
  /** When true, the user has acknowledged this non-model failure as a final result via --ack-failures. */
  acknowledged?: boolean;
}

/**
 * Structured progress events emitted by the runner.
 * The CLI decides how to render these (dashboard, console.log, etc.).
 */
export type ProgressEvent =
  | { type: 'experiment:start'; totalAttempts: number; totalEvals: number; totalRuns: number }
  | { type: 'eval:start'; evalName: string; runNumber: number; totalRuns: number }
  | { type: 'eval:complete'; evalName: string; runNumber: number; totalRuns: number; result: EvalRunResult }
  | { type: 'eval:abort'; evalName: string; runNumber: number }
  | { type: 'experiment:earlyExit'; evalName: string; runNumber: number }
  | { type: 'experiment:saved'; outputDir: string }
  | { type: 'experiment:summary'; results: ExperimentResults };

/**
 * Complete experiment results.
 */
export interface ExperimentResults {
  /** Timestamp when experiment started */
  startedAt: string;
  /** Timestamp when experiment completed */
  completedAt: string;
  /** Experiment configuration used */
  config: RunnableExperimentConfig;
  /** Results for each eval */
  evals: EvalSummary[];
}
