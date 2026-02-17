#!/usr/bin/env node

/**
 * CLI entry point for the eval framework.
 */

import { Command } from 'commander';
import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname, basename } from 'path';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { loadConfig, resolveEvalNames } from './lib/config.js';
import { loadAllFixtures } from './lib/fixture.js';
import { runExperiment, StartRateLimiter } from './lib/runner.js';
import { Dashboard, createConsoleProgressHandler } from './lib/dashboard.js';
import type { ProgressEvent, Classification } from './lib/types.js';
import { initProject, getPostInitInstructions } from './lib/init.js';
import { getAgent } from './lib/agents/index.js';
import { getSandboxBackendInfo } from './lib/sandbox.js';
import { computeFingerprint } from './lib/fingerprint.js';
import { scanReusableResults } from './lib/results.js';
import { isClassifierEnabled, classifyFailure } from './lib/classifier.js';
import { housekeep } from './lib/housekeeping.js';
import { spawnSync } from 'child_process';
import { minimatch } from 'minimatch';

// Load environment variables (.env.local first, then .env as fallback)
dotenvConfig({ path: '.env.local' });
dotenvConfig();

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

program
  .name('@vercel/agent-eval')
  .description('Framework for testing AI coding agents in isolated sandboxes')
  .version(pkg.version);

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
async function runExperimentCommand(configInput: string, options: { dry?: boolean; smoke?: boolean }) {
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

    // Smoke mode: pick first eval alphabetically, override runs to 1
    const smokeEvalNames = options.smoke ? [evalNames.sort()[0]] : evalNames;
    const smokeRuns = options.smoke ? 1 : config.runs;

    if (options.smoke) {
      console.log(chalk.yellow(`\n[SMOKE TEST] Running 1 eval to verify setup: ${smokeEvalNames[0]}`));
    } else {
      console.log(chalk.green(`\nFound ${fixtures.length} valid fixture(s), will run ${evalNames.length}:`));
      for (const name of evalNames) {
        console.log(chalk.green(`  - ${name}`));
      }
    }

	const models = Array.isArray(config.model) ? config.model : [config.model];

    // Show info for all models
    const totalRunsPerModel = smokeEvalNames.length * smokeRuns;
    const totalRuns = totalRunsPerModel * models.length;

    if (models.length > 1) {
      console.log(chalk.blue(`\nRunning ${smokeEvalNames.length} eval(s) x ${smokeRuns} run(s) x ${models.length} model(s) = ${totalRuns} total runs`));
      console.log(chalk.blue(`Agent: ${config.agent}, Models: ${models.join(', ')}, Timeout: ${config.timeout}s, Early Exit: ${config.earlyExit}`));
    } else {
      console.log(chalk.blue(`\nRunning ${smokeEvalNames.length} eval(s) x ${smokeRuns} run(s) = ${totalRuns} total runs`));
      console.log(chalk.blue(`Agent: ${config.agent}, Model: ${models[0]}, Timeout: ${config.timeout}s, Early Exit: ${config.earlyExit}`));
    }

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
    const apiKey = process.env[apiKeyEnvVar] ?? process.env.VERCEL_OIDC_TOKEN;
    if (!apiKey) {
      console.error(chalk.red(`${apiKeyEnvVar} (or VERCEL_OIDC_TOKEN) environment variable is required`));
      console.error(chalk.gray(`Get your API key at: https://vercel.com/dashboard -> AI Gateway`));
      process.exit(1);
    }

    // Filter fixtures to only the ones we want to run
    const selectedFixtures = fixtures.filter((f) => smokeEvalNames.includes(f.name));

    // Get experiment name from config file
    const baseExperimentName = basename(configPath, '.ts').replace(/\.js$/, '');
    const resultsDir = resolve(process.cwd(), 'results');

    console.log(chalk.blue('\nStarting experiment...'));

    // Run experiments for each model
    let allPassed = true;
    for (const model of models) {
      // Create a config for this specific model (with smoke overrides if applicable)
      const modelConfig = { ...config, model, runs: smokeRuns };

      // Include model in experiment name for organized results
      const experimentName = `${baseExperimentName}/${model}`;

      if (models.length > 1) {
        console.log(chalk.blue(`\n--- Running with model: ${model} ---`));
      }

      // Run the experiment
      const results = await runExperiment({
        config: modelConfig,
        fixtures: selectedFixtures,
        apiKey,
        resultsDir,
        experimentName,
        smoke: options.smoke,
        onProgress: createConsoleProgressHandler({
          experimentName,
          model,
          agent: config.agent,
        }),
      });

      // Check if this experiment passed
      const experimentPassed = results.evals.every((e) => e.passedRuns === e.totalRuns);
      if (!experimentPassed) {
        allPassed = false;
      }
    }

    // Exit with appropriate code
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
 * playground command - Launch the web-based results viewer
 * Spawns @vercel/agent-eval-playground (downloaded on-demand via npx if not installed)
 */
program
  .command('playground')
  .description('Launch the web-based playground for browsing experiment results')
  .option('--port <port>', 'HTTP server port', '3000')
  .option('--results-dir <dir>', 'Path to results directory', './results')
  .option('--evals-dir <dir>', 'Path to evals directory', './evals')
  .option('--watch', 'Enable live mode — watch results directory for changes')
  .action(async (options: { port: string; resultsDir: string; evalsDir: string; watch?: boolean }) => {
    const resultsDir = resolve(process.cwd(), options.resultsDir);
    const evalsDir = resolve(process.cwd(), options.evalsDir);

    console.log(chalk.blue('Starting Agent Eval Playground...'));

    // Build args for the playground CLI
    const playgroundArgs = [
      '--results-dir', resultsDir,
      '--evals-dir', evalsDir,
      '--port', options.port,
    ];
    if (options.watch) {
      playgroundArgs.push('--watch');
    }

    // Try to run the playground package directly, fall back to npx
    const result = spawnSync(
      'npx',
      ['@vercel/agent-eval-playground', ...playgroundArgs],
      { stdio: 'inherit', cwd: process.cwd() }
    );

    process.exit(result.status ?? 1);
  });

/**
 * Run-all handler: discover and run all experiments with fingerprint reuse
 * and classification. Used by both `run-all` subcommand and the default
 * (no-args) invocation.
 */
async function runAllCommand(experimentArgs: string[], options: { dry?: boolean; force?: boolean; smoke?: boolean; ackFailures?: boolean }) {
    try {
      const projectDir = process.cwd();
      const experimentsDir = resolve(projectDir, 'experiments');
      const evalsDir = resolve(projectDir, 'evals');
      const resultsDir = resolve(projectDir, 'results');

      if (!existsSync(experimentsDir)) {
        console.error(chalk.red('experiments/ directory not found'));
        process.exit(1);
      }
      if (!existsSync(evalsDir)) {
        console.error(chalk.red('evals/ directory not found'));
        process.exit(1);
      }

      // Discover experiments
      const allExperimentFiles = readdirSync(experimentsDir)
        .filter((f) => f.endsWith('.ts') && !f.startsWith('_temp_'))
        .sort();

      // Filter by args if provided
      let selectedFiles: string[];
      if (experimentArgs.length > 0) {
        selectedFiles = allExperimentFiles.filter((f) => {
          const name = f.replace(/\.ts$/, '');
          return experimentArgs.some((arg) =>
            arg.includes('*') ? minimatch(name, arg) : name === arg
          );
        });
        if (selectedFiles.length === 0) {
          console.error(chalk.red(`No experiments matched: ${experimentArgs.join(', ')}`));
          console.error(chalk.gray(`Available: ${allExperimentFiles.map((f) => f.replace(/\.ts$/, '')).join(', ')}`));
          process.exit(1);
        }
      } else {
        selectedFiles = allExperimentFiles;
      }

      console.log(chalk.blue(`Discovered ${selectedFiles.length} experiment(s):`));
      for (const f of selectedFiles) {
        console.log(chalk.blue(`  - ${f.replace(/\.ts$/, '')}`));
      }

      // Load all fixtures
      const { fixtures, errors } = loadAllFixtures(evalsDir);
      if (errors.length > 0) {
        console.log(chalk.yellow(`\nWarning: ${errors.length} invalid fixture(s)`));
      }
      if (fixtures.length === 0) {
        console.error(chalk.red('No valid eval fixtures found'));
        process.exit(1);
      }

      // --- Dry run: collect info and print a single summary table ---
      if (options.dry) {
        interface DryRunInfo { name: string; toRun: string[]; cached: number; total: number }
        const dryResults: DryRunInfo[] = [];

        for (const file of selectedFiles) {
          const configPath = resolve(experimentsDir, file);
          const baseExperimentName = file.replace(/\.ts$/, '');

          let config;
          try {
            config = await loadConfig(configPath);
          } catch (err) {
            console.error(chalk.red(`Failed to load ${file}: ${err instanceof Error ? err.message : err}`));
            continue;
          }

          const models = Array.isArray(config.model) ? config.model : [config.model];
          const availableNames = fixtures.map((f) => f.name);
          let evalNames: string[];
          try {
            evalNames = resolveEvalNames(config.evals, availableNames);
          } catch {
            evalNames = availableNames;
          }

          if (options.smoke) {
            evalNames = [evalNames.sort()[0]];
          }

          for (const model of models) {
            const experimentName = models.length > 1
              ? `${baseExperimentName}/${model}`
              : baseExperimentName;

            const modelConfig = { ...config, model, runs: options.smoke ? 1 : config.runs };
            const selectedFixtures = fixtures.filter((f) => evalNames.includes(f.name));
            const fingerprints: Record<string, string> = {};
            for (const fixture of selectedFixtures) {
              fingerprints[fixture.name] = computeFingerprint(fixture.path, modelConfig);
            }

            let fixturesToRun = selectedFixtures;
            if (!options.force && !options.smoke) {
              const reusable = scanReusableResults(resultsDir, experimentName, fingerprints);
              if (reusable.size > 0) {
                fixturesToRun = selectedFixtures.filter((f) => !reusable.has(f.name));
              }
            }

            dryResults.push({
              name: experimentName,
              toRun: fixturesToRun.map((f) => f.name),
              cached: selectedFixtures.length - fixturesToRun.length,
              total: selectedFixtures.length,
            });
          }
        }

        // Print summary
        const totalToRun = dryResults.reduce((sum, d) => sum + d.toRun.length, 0);
        const totalCached = dryResults.reduce((sum, d) => sum + d.cached, 0);
        const nameWidth = Math.max(...dryResults.map((d) => d.name.length)) + 2;

        console.log('');
        if (totalToRun === 0) {
          console.log(chalk.green(`  All ${totalCached} evals cached across ${dryResults.length} experiments. Nothing to run.`));
        } else {
          console.log(chalk.bold(`  ${totalToRun} evals to run, ${totalCached} cached\n`));
          for (const d of dryResults) {
            const label = d.name.padEnd(nameWidth);
            if (d.toRun.length === 0) {
              console.log(chalk.gray(`  ${label} ${d.total} cached`));
            } else {
              console.log(
                chalk.white(`  ${label}`) +
                chalk.blue(` ${d.toRun.length} to run`) +
                (d.cached > 0 ? chalk.gray(`, ${d.cached} cached`) : '')
              );
              for (const name of d.toRun) {
                console.log(chalk.green(`  ${' '.repeat(nameWidth)} → ${name}`));
              }
            }
          }
        }
        console.log('');
        return;
      }

      // --- Live run ---
      const useDashboard = process.stdout.isTTY && selectedFiles.length > 1;
      const dashboard = useDashboard ? new Dashboard() : null;

      if (dashboard) {
        dashboard.start();
      }

      // Warn if classifier is disabled
      if (!isClassifierEnabled()) {
        console.log(
          chalk.yellow(
            '\n⚠️  Classifier disabled: Neither AI_GATEWAY_API_KEY nor VERCEL_OIDC_TOKEN is set.\n' +
            '  The classifier automatically identifies why evals failed (model error, infrastructure issue, or timeout).\n' +
            '  Without it, all failed results are kept as-is and housekeeping will not remove non-model failures.\n' +
            '  Set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN to enable classifier for cleaner result management.\n'
          )
        );
      }

      // Rate-limit sandbox starts across all experiments to avoid 429s (20 starts per 2 seconds)
      const rateLimiter = new StartRateLimiter(20, 2_000);

      let allPassed = true;
      const experimentPromises = selectedFiles.map(async (file) => {
        const configPath = resolve(experimentsDir, file);
        const baseExperimentName = file.replace(/\.ts$/, '');

        let config;
        try {
          config = await loadConfig(configPath);
        } catch (err) {
          console.error(chalk.red(`Failed to load ${file}: ${err instanceof Error ? err.message : err}`));
          return;
        }

        const models = Array.isArray(config.model) ? config.model : [config.model];
        const availableNames = fixtures.map((f) => f.name);
        let evalNames: string[];
        try {
          evalNames = resolveEvalNames(config.evals, availableNames);
        } catch {
          evalNames = availableNames;
        }

        if (options.smoke) {
          evalNames = [evalNames.sort()[0]];
        }

        const agent = getAgent(config.agent);
        const apiKeyEnvVar = agent.getApiKeyEnvVar();
        const apiKey = process.env[apiKeyEnvVar] ?? process.env.VERCEL_OIDC_TOKEN;
        if (!apiKey) {
          console.error(chalk.red(`${apiKeyEnvVar} (or VERCEL_OIDC_TOKEN) not set, skipping ${baseExperimentName}`));
          return;
        }

        for (const model of models) {
          const experimentName = models.length > 1
            ? `${baseExperimentName}/${model}`
            : baseExperimentName;

          const modelConfig = {
            ...config,
            model,
            runs: options.smoke ? 1 : config.runs,
          };

          const selectedFixtures = fixtures.filter((f) => evalNames.includes(f.name));
          const fingerprints: Record<string, string> = {};
          for (const fixture of selectedFixtures) {
            fingerprints[fixture.name] = computeFingerprint(fixture.path, modelConfig);
          }

          let fixturesToRun = selectedFixtures;
          if (!options.force && !options.smoke) {
            const reusable = scanReusableResults(resultsDir, experimentName, fingerprints);
            if (reusable.size > 0) {
              fixturesToRun = selectedFixtures.filter((f) => !reusable.has(f.name));
            }
          }

          if (fixturesToRun.length === 0) {
            continue;
          }

          // Register with dashboard or log to console
          if (dashboard) {
            dashboard.addExperiment(experimentName, {
              agent: config.agent,
              model,
              totalEvals: fixturesToRun.length,
            });
          } else {
            console.log(chalk.blue(`\nRunning ${experimentName}: ${fixturesToRun.length} eval(s)`));
          }

          // Build the progress handler
          const onProgress: (event: ProgressEvent) => void = dashboard
            ? (event) => dashboard.handleEvent(experimentName, event)
            : createConsoleProgressHandler({ experimentName, model, agent: config.agent });

          try {
            const results = await runExperiment({
              config: modelConfig,
              fixtures: fixturesToRun,
              apiKey: apiKey!,
              resultsDir,
              experimentName,
              fingerprints,
              smoke: options.smoke,
              onProgress,
              rateLimiter,
            });

            // Classify failures (only if classifier is enabled)
            const failedEvals = results.evals.filter((e) => e.passedRuns === 0);
            const classifications = new Map<string, Classification>();
            let hasNonModelFailures = false;

            if (isClassifierEnabled()) {
              if (dashboard) {
                dashboard.setPhase(experimentName, 'classifying');
              }

              if (failedEvals.length > 0 && !options.smoke) {
                const timestamp = results.startedAt.replace(/:/g, '-');

                for (const evalSummary of failedEvals) {
                  const evalResultDir = resolve(resultsDir, experimentName, timestamp, evalSummary.name);
                  const classification = await classifyFailure(
                    evalResultDir,
                    evalSummary.name,
                    experimentName
                  );
                  if (classification) {
                    classifications.set(evalSummary.name, classification);

                    if (!dashboard) {
                      const icon = { model: '  ', infra: '  ', timeout: '  ', eval: '  ' }[classification.failureType];
                      console.log(chalk.gray(`  ${icon} ${evalSummary.name}: ${classification.failureType} — ${classification.failureReason}`));
                    }

                    if (classification.failureType !== 'model') {
                      if (options.ackFailures) {
                        classification.acknowledged = true;
                        const classificationPath = resolve(evalResultDir, 'classification.json');
                        writeFileSync(classificationPath, JSON.stringify(classification, null, 2));
                        if (!dashboard) {
                          console.log(chalk.yellow(`  ✓ Acknowledged ${evalSummary.name} (${classification.failureType} failure — kept as final result)`));
                        }
                      } else {
                        rmSync(evalResultDir, { recursive: true });
                        if (!dashboard) {
                          console.log(chalk.gray(`  🗑️  Removed ${evalSummary.name} (${classification.failureType} failure)`));
                        }
                        hasNonModelFailures = true;
                      }
                    }
                  }
                }

                if (hasNonModelFailures && !dashboard) {
                  console.log(chalk.yellow(`\n  To keep non-model failures as final results, re-run with --ack-failures`));
                }
              }
            }

            // Complete the experiment in the dashboard (prints permanent block)
            if (dashboard) {
              dashboard.completeExperiment(experimentName, results, classifications);
            }

            const experimentPassed = results.evals.every((e) => e.passedRuns > 0);
            if (!experimentPassed) allPassed = false;
          } catch (err) {
            console.error(chalk.red(`  Error running ${experimentName}: ${err instanceof Error ? err.message : err}`));
            allPassed = false;
            if (dashboard) {
              dashboard.setPhase(experimentName, 'done');
            }
          }

          // Housekeeping after each experiment
          const stats = housekeep(resultsDir, experimentName);
          if (stats.removedDuplicates + stats.removedIncomplete + stats.removedNonModelFailures > 0) {
            console.log(
              chalk.gray(
                `  Housekeeping: removed ${stats.removedDuplicates} duplicate(s), ${stats.removedIncomplete} incomplete, ${stats.removedNonModelFailures} non-model failure(s)`
              )
            );
          }
        }
      });

      await Promise.all(experimentPromises);

      if (dashboard) {
        dashboard.stop();
      }

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
 * run-all subcommand (explicit)
 */
program
  .command('run-all')
  .description('Discover and run all experiments with fingerprint reuse and classification')
  .argument('[experiments...]', 'Experiment names or glob patterns (default: all)')
  .option('--dry', 'Preview what would run without executing')
  .option('--force', 'Ignore fingerprints, re-run everything')
  .option('--smoke', 'Run 1 eval per experiment for sanity checking')
  .option('--ack-failures', 'Keep non-model failures (infra/timeout) as final results instead of deleting them')
  .action(runAllCommand);

/**
 * Default command - run a single experiment, or run-all if no args given.
 * Usage:
 *   agent-eval           # runs all experiments (same as run-all)
 *   agent-eval cc        # runs single experiment
 *   agent-eval cc --dry  # preview single experiment
 */
program
  .argument('[config]', 'Experiment name (e.g., "cc") or path. Omit to run all experiments.')
  .option('--dry', 'Preview what would run without executing')
  .option('--smoke', 'Run a single eval to verify setup (API keys, model IDs, sandbox)')
  .option('--force', 'Ignore fingerprints, re-run everything (only applies when running all)')
  .option('--ack-failures', 'Keep non-model failures (infra/timeout) as final results instead of deleting them')
  .action(async (configInput: string | undefined, options: { dry?: boolean; smoke?: boolean; force?: boolean; ackFailures?: boolean }) => {
    if (!configInput) {
      await runAllCommand([], options);
      return;
    }
    await runExperimentCommand(configInput, options);
  });

program.parse();
