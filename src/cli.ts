#!/usr/bin/env node

/**
 * CLI entry point for the eval framework.
 */

import { Command } from 'commander';
import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname, basename } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { loadConfig, resolveEvalNames } from './lib/config.js';
import { loadAllFixtures } from './lib/fixture.js';
import { runExperiment } from './lib/runner.js';
import { initProject, getPostInitInstructions } from './lib/init.js';
import { getAgent } from './lib/agents/index.js';
import { getSandboxBackendInfo } from './lib/sandbox.js';

// Load environment variables
dotenvConfig();

const program = new Command();

program
  .name('agent-eval')
  .description('Framework for testing AI coding agents in isolated sandboxes')
  .version('0.0.4');

/**
 * Resolve config path shorthand.
 * - "cc" -> "experiments/cc.ts"
 * - "experiments/cc.ts" -> "experiments/cc.ts" (unchanged)
 */
function resolveConfigPath(input: string): string {
  // If it already has a path separator or extension, use as-is
  if (input.includes('/') || input.includes('\\') || input.endsWith('.ts') || input.endsWith('.js')) {
    return input;
  }
  // Otherwise, treat as shorthand: "cc" -> "experiments/cc.ts"
  return `experiments/${input}.ts`;
}

/**
 * Run experiment command handler
 */
async function runExperimentCommand(configInput: string, options: { dry?: boolean }) {
  try {
    const configPath = resolveConfigPath(configInput);
    const absoluteConfigPath = resolve(process.cwd(), configPath);

    if (!existsSync(absoluteConfigPath)) {
      console.error(chalk.red(`Config file not found: ${absoluteConfigPath}`));
      process.exit(1);
    }

    console.log(chalk.blue(`Loading config from ${configPath}...`));
    const config = await loadConfig(absoluteConfigPath);

    // Discover evals - infer from config file location
    // Config at project/experiments/foo.ts -> evals at project/evals/
    const projectDir = dirname(dirname(absoluteConfigPath));
    const evalsDir = resolve(projectDir, 'evals');
    if (!existsSync(evalsDir)) {
      console.error(chalk.red(`Evals directory not found: ${evalsDir}`));
      console.error(chalk.gray(`Expected evals/ to be sibling to experiments/ directory`));
      process.exit(1);
    }

    console.log(chalk.blue(`Discovering evals in ${evalsDir}...`));
    const { fixtures, errors } = loadAllFixtures(evalsDir);

    if (errors.length > 0) {
      console.log(chalk.yellow(`\nWarning: ${errors.length} invalid fixture(s):`));
      for (const error of errors) {
        console.log(chalk.yellow(`  - ${error.fixtureName}: ${error.message}`));
      }
    }

    if (fixtures.length === 0) {
      console.error(chalk.red('No valid eval fixtures found'));
      process.exit(1);
    }

    // Resolve which evals to run
    const availableNames = fixtures.map((f) => f.name);
    const evalNames = resolveEvalNames(config.evals, availableNames);

    if (evalNames.length === 0) {
      console.error(chalk.red('No evals matched the filter'));
      process.exit(1);
    }

    console.log(chalk.green(`\nFound ${fixtures.length} valid fixture(s), will run ${evalNames.length}:`));
    for (const name of evalNames) {
      console.log(chalk.green(`  - ${name}`));
    }

    console.log(chalk.blue(`\nRunning ${evalNames.length} eval(s) x ${config.runs} run(s) = ${evalNames.length * config.runs} total runs`));
    console.log(chalk.blue(`Agent: ${config.agent}, Model: ${config.model}, Timeout: ${config.timeout}s, Early Exit: ${config.earlyExit}`));

    // Show which sandbox backend will be used
    const sandboxInfo = getSandboxBackendInfo({ backend: config.sandbox });
    console.log(chalk.blue(`Sandbox: ${sandboxInfo.description}`));

    if (options.dry) {
      console.log(chalk.yellow('\n[DRY RUN] Would execute evals here'));
      return;
    }

    // Get the agent to check for required API key
    const agent = getAgent(config.agent);
    const apiKeyEnvVar = agent.getApiKeyEnvVar();
    const apiKey = process.env[apiKeyEnvVar];
    if (!apiKey) {
      console.error(chalk.red(`${apiKeyEnvVar} environment variable is required`));
      console.error(chalk.gray(`Get your API key at: https://vercel.com/dashboard -> AI Gateway`));
      process.exit(1);
    }

    // Filter fixtures to only the ones we want to run
    const selectedFixtures = fixtures.filter((f) => evalNames.includes(f.name));

    // Get experiment name from config file
    const experimentName = basename(configPath, '.ts').replace(/\.js$/, '');
    const resultsDir = resolve(process.cwd(), 'results');

    console.log(chalk.blue('\nStarting experiment...'));

    // Run the experiment
    const results = await runExperiment({
      config,
      fixtures: selectedFixtures,
      apiKey,
      resultsDir,
      experimentName,
      onProgress: (msg) => console.log(msg),
    });

    // Exit with appropriate code
    const allPassed = results.evals.every((e) => e.passedRuns === e.totalRuns);
    process.exit(allPassed ? 0 : 1);
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`Error: ${error.message}`));
    } else {
      console.error(chalk.red('An unknown error occurred'));
    }
    process.exit(1);
  }
}

/**
 * init command - Create a new eval project
 */
program
  .command('init')
  .argument('<name>', 'Name of the project to create')
  .description('Create a new eval project with example fixtures')
  .action(async (name: string) => {
    try {
      console.log(chalk.blue(`Creating new eval project: ${name}`));

      const projectDir = initProject({
        name,
        targetDir: process.cwd(),
      });

      console.log(chalk.green('Project created successfully!'));
      console.log(getPostInitInstructions(projectDir, name));
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`));
      } else {
        console.error(chalk.red('An unknown error occurred'));
      }
      process.exit(1);
    }
  });

/**
 * Default command - run experiment (no subcommand needed)
 * Usage: agent-eval cc --dry
 */
program
  .argument('[config]', 'Experiment name (e.g., "cc") or path')
  .option('--dry', 'Preview what would run without executing')
  .action(async (configInput: string | undefined, options: { dry?: boolean }) => {
    if (!configInput) {
      program.help();
      return;
    }
    await runExperimentCommand(configInput, options);
  });

program.parse();
