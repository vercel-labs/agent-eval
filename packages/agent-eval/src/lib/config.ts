/**
 * Experiment configuration validation and defaults.
 */

import { z } from 'zod';
import { minimatch } from 'minimatch';
import type {
  ExperimentConfig,
  ResolvedExperimentConfig,
  EvalFilter,
} from './types.js';
import { NATIVE_DEFAULT_MODEL } from './types.js';
import { assertRunBundledSkillsControl } from './agents/index.js';

/**
 * Default configuration values.
 */
export const CONFIG_DEFAULTS = {
  evals: '*' as const,
  runs: 1,
  earlyExit: true,
  scripts: [] as string[],
  validation: 'vitest' as const,
  timeout: 600, // 10 minutes
  sandbox: 'auto' as const,
  copyFiles: 'none' as const,
};

/**
 * Zod schema for validating experiment configuration.
 */
const experimentConfigSchema = z.object({
  // Agent modules may register custom implementations while the experiment
  // config is being imported. Registry membership is checked in resolveConfig.
  agent: z.string().min(1),
  model: z.union([z.string(), z.array(z.string())]).optional(),
  evals: z
    .union([z.string(), z.array(z.string()), z.function().args(z.string()).returns(z.boolean())])
    .optional(),
  runs: z.number().int().positive().optional(),
  earlyExit: z.boolean().optional(),
  scripts: z.array(z.string()).optional(),
  validation: z.enum(['vitest', 'none']).optional(),
  timeout: z.number().positive().optional(),
  setup: z.function().optional(),
  sandbox: z.enum(['vercel', 'docker', 'auto']).optional(),
  editPrompt: z.function().args(z.string()).returns(z.string()).optional(),
  copyFiles: z.enum(['none', 'changed', 'all']).optional(),
  agentOptions: z.record(z.unknown()).optional(),
  // Must be in the schema: z.object strips unknown keys, so omitting it here
  // would make validateConfig silently drop the option.
  webResearch: z.boolean().optional(),
  disableBundledSkills: z.boolean().optional(),
  brands: z.array(z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    displayName: z.string().optional(),
    domain: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    isYourBrand: z.boolean().optional(),
  })).optional(),
  onRunComplete: z.function().optional(),
  // Pin the agentic LLM judge. `agent` defaults to the codegen agent; `model` is
  // required (pinning the judge model is the point).
  judge: z
    .object({
      agent: z
        .enum([
          'vercel-ai-gateway/claude-code',
          'claude-code',
          'vercel-ai-gateway/codex',
          'codex',
          'vercel-ai-gateway/opencode',
          'gemini',
          'cursor',
        ])
        .optional(),
      model: z.string(),
    })
    .optional(),
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
  assertRunBundledSkillsControl(
    config.agent,
    config.disableBundledSkills,
    config.judge?.agent,
  );

  const modelPolicy = config.model === undefined ? 'native-default' : 'agent-default';
  const defaultModel = config.model ?? NATIVE_DEFAULT_MODEL;

  return {
    agent: config.agent,
    model: defaultModel,
    modelPolicy,
    evals: config.evals ?? '*',
    runs: config.runs ?? CONFIG_DEFAULTS.runs,
    earlyExit: config.earlyExit ?? CONFIG_DEFAULTS.earlyExit,
    scripts: config.scripts ?? CONFIG_DEFAULTS.scripts,
    validation: config.validation ?? CONFIG_DEFAULTS.validation,
    timeout: config.timeout ?? CONFIG_DEFAULTS.timeout,
    setup: config.setup,
    sandbox: config.sandbox ?? CONFIG_DEFAULTS.sandbox,
    editPrompt: config.editPrompt,
    copyFiles: config.copyFiles ?? CONFIG_DEFAULTS.copyFiles,
    agentOptions: config.agentOptions,
    webResearch: config.webResearch,
    disableBundledSkills: config.disableBundledSkills,
    brands: config.brands,
    onRunComplete: config.onRunComplete,
    judge: config.judge,
  };
}

/**
 * Loads an experiment configuration from a file path.
 * Supports TypeScript and JavaScript files with default exports.
 */
export async function loadConfig(configPath: string): Promise<ResolvedExperimentConfig> {
  try {
    let rawConfig: unknown;

    // Use jiti for TypeScript files
    if (configPath.endsWith('.ts')) {
      const { createJiti } = await import('jiti');
      const jiti = createJiti(import.meta.url, {
        interopDefault: true,
        moduleCache: false,
      });
      rawConfig = await jiti.import(configPath);
    } else {
      // Dynamic import for JavaScript files
      const module = await import(configPath);
      rawConfig = module.default;
    }

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
 * Check if a name matches a glob-style pattern.
 * Supports:
 * - "*" matches everything
 * - "vercel-cli/*" matches all under vercel-cli/
 * - "* /deploy" matches any deploy in any folder
 * - "vercel-cli/deploy" exact match
 * 
 * Uses minimatch for robust glob matching.
 */
function matchesPattern(name: string, pattern: string): boolean {
  return minimatch(name, pattern);
}

/**
 * Resolves the evals filter to a list of eval names.
 * Supports glob patterns like "vercel-cli/*" for nested directories.
 */
export function resolveEvalNames(
  filter: string | string[] | EvalFilter,
  availableEvals: string[]
): string[] {
  // Single eval name or pattern
  if (typeof filter === 'string') {
    if (filter === '*') {
      return availableEvals;
    }

    // Check if it's a glob pattern
    if (filter.includes('*')) {
      const matched = availableEvals.filter((name) => matchesPattern(name, filter));
      if (matched.length === 0) {
        throw new Error(`No evals matched pattern "${filter}". Available evals: ${availableEvals.join(', ')}`);
      }
      return matched;
    }

    // Exact match
    if (!availableEvals.includes(filter)) {
      throw new Error(`Eval "${filter}" not found. Available evals: ${availableEvals.join(', ')}`);
    }
    return [filter];
  }

  // Array of eval names or patterns
  if (Array.isArray(filter)) {
    const result: string[] = [];
    const seen = new Set<string>();

    for (const item of filter) {
      // Handle glob patterns in arrays
      if (item.includes('*')) {
        const matched = availableEvals.filter((name) => matchesPattern(name, item));
        if (matched.length === 0) {
          throw new Error(`No evals matched pattern "${item}". Available evals: ${availableEvals.join(', ')}`);
        }
        for (const name of matched) {
          if (!seen.has(name)) {
            result.push(name);
            seen.add(name);
          }
        }
      } else {
        // Exact match
        if (!availableEvals.includes(item)) {
          throw new Error(`Eval "${item}" not found. Available evals: ${availableEvals.join(', ')}`);
        }
        if (!seen.has(item)) {
          result.push(item);
          seen.add(item);
        }
      }
    }

    return result;
  }

  // Filter function
  return availableEvals.filter(filter);
}
