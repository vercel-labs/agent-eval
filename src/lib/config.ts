/**
 * Experiment configuration validation and defaults.
 */

import { z } from 'zod';
import type {
  ExperimentConfig,
  ResolvedExperimentConfig,
  EvalFilter,
} from './types.js';
import { getAgent } from './agents/index.js';

/**
 * Default configuration values.
 */
export const CONFIG_DEFAULTS = {
  model: 'opus' as const,
  evals: '*' as const,
  runs: 1,
  earlyExit: true,
  scripts: [] as string[],
  timeout: 300, // 5 minutes
  sandbox: 'auto' as const,
};

/**
 * Zod schema for validating experiment configuration.
 */
const experimentConfigSchema = z.object({
  agent: z.enum([
    'vercel-ai-gateway/claude-code',
    'claude-code',
    'vercel-ai-gateway/codex',
    'codex',
    'vercel-ai-gateway/opencode',
  ]),
  model: z.string().optional(),
  evals: z
    .union([z.string(), z.array(z.string()), z.function().args(z.string()).returns(z.boolean())])
    .optional(),
  runs: z.number().int().positive().optional(),
  earlyExit: z.boolean().optional(),
  scripts: z.array(z.string()).optional(),
  timeout: z.number().positive().optional(),
  setup: z.function().optional(),
  sandbox: z.enum(['vercel', 'docker', 'auto']).optional(),
});

/**
 * Validates an experiment configuration object.
 * Throws a descriptive error if validation fails.
 */
export function validateConfig(config: unknown): ExperimentConfig {
  const result = experimentConfigSchema.safeParse(config);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid experiment configuration:\n${errors}`);
  }

  return result.data as ExperimentConfig;
}

/**
 * Resolves an experiment configuration by applying defaults.
 */
export function resolveConfig(config: ExperimentConfig): ResolvedExperimentConfig {
  // Validate agent exists
  const agent = getAgent(config.agent);
  
  // Get the default model based on the agent type
  const defaultModel = config.model ?? agent.getDefaultModel();

  return {
    agent: config.agent,
    model: defaultModel,
    evals: config.evals ?? '*',
    runs: config.runs ?? CONFIG_DEFAULTS.runs,
    earlyExit: config.earlyExit ?? CONFIG_DEFAULTS.earlyExit,
    scripts: config.scripts ?? CONFIG_DEFAULTS.scripts,
    timeout: config.timeout ?? CONFIG_DEFAULTS.timeout,
    setup: config.setup,
    sandbox: config.sandbox ?? CONFIG_DEFAULTS.sandbox,
  };
}

/**
 * Loads an experiment configuration from a file path.
 * Supports TypeScript and JavaScript files with default exports.
 */
export async function loadConfig(configPath: string): Promise<ResolvedExperimentConfig> {
  try {
    // Dynamic import of the config file
    const module = await import(configPath);
    const rawConfig = module.default;

    if (!rawConfig) {
      throw new Error(`Config file must have a default export`);
    }

    const config = validateConfig(rawConfig);
    return resolveConfig(config);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load config from ${configPath}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Resolves the evals filter to a list of eval names.
 */
export function resolveEvalNames(
  filter: string | string[] | EvalFilter,
  availableEvals: string[]
): string[] {
  // Single eval name
  if (typeof filter === 'string') {
    if (filter === '*') {
      return availableEvals;
    }
    if (!availableEvals.includes(filter)) {
      throw new Error(`Eval "${filter}" not found. Available evals: ${availableEvals.join(', ')}`);
    }
    return [filter];
  }

  // Array of eval names
  if (Array.isArray(filter)) {
    const missing = filter.filter((name) => !availableEvals.includes(name));
    if (missing.length > 0) {
      throw new Error(
        `Evals not found: ${missing.join(', ')}. Available evals: ${availableEvals.join(', ')}`
      );
    }
    return filter;
  }

  // Filter function
  return availableEvals.filter(filter);
}
