#!/usr/bin/env node

/**
 * CLI entry point for the eval framework.
 */

import { Command } from 'commander';
import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname, basename, join } from 'path';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { loadConfig, resolveEvalNames } from './lib/config.js';
import { loadAllFixtures } from './lib/fixture.js';
import { runExperiment, StartRateLimiter } from './lib/runner.js';
import { Dashboard, createConsoleProgressHandler } from './lib/dashboard.js';
import type { ProgressEvent, Classification } from './lib/types.js';
import { initProject, getPostInitInstructions } from './lib/init.js';
import { getAgent } from './lib/agents/index.js';
import { resolveAgentApiKey } from './lib/agents/shared.js';
import { getSandboxBackendInfo } from './lib/sandbox.js';
import {
  computeFingerprint,
  computeContentFingerprint,
  computeReuseCompatibilityFingerprint,
  decideRefingerprint,
} from './lib/fingerprint.js';
import { scanReusableResults } from './lib/results.js';
import { isClassifierEnabled, classifyFailure } from './lib/classifier.js';
import { housekeep } from './lib/housekeeping.js';
import { cleanupActiveSandboxes } from './lib/docker-sandbox.js';
import { spawnSync } from 'child_process';
import { minimatch } from 'minimatch';
import pLimit from 'p-limit';

// Load environment variables (.env.local first, then .env as fallback)
dotenvConfig({ path: '.env.local', override: true });
dotenvConfig({ override: true });

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

let shuttingDown = false;
async function shutdownAndExit(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(chalk.yellow(`\nReceived ${signal}, cleaning up Docker sandboxes...`));
  try {
    const stopped = await cleanupActiveSandboxes();
    if (stopped > 0) {
      console.error(chalk.yellow(`Stopped ${stopped} sandbox container(s).`));
    }
  } catch {
    // Best effort
  }
  process.exit(130);
}

process.on('SIGINT', shutdownAndExit);
process.on('SIGTERM', shutdownAndExit);

const program = new Command();
program.enablePositionalOptions();

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
    const { fixtures, errors } = loadAllFixtures(evalsDir, {
      validation: config.validation,
    });

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
    const apiKey = resolveAgentApiKey(agent.getApiKeyEnvVar);
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
        const apiKey = resolveAgentApiKey(agent.getApiKeyEnvVar);
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
          const reuseCompatibilityFingerprint = computeReuseCompatibilityFingerprint(modelConfig);

          const selectedFixtures = fixtures.filter((f) => evalNames.includes(f.name));
          const fingerprints: Record<string, string> = {};
          const contentFingerprints: Record<string, string> = {};
          for (const fixture of selectedFixtures) {
            fingerprints[fixture.name] = computeFingerprint(fixture.path, modelConfig);
            contentFingerprints[fixture.name] = computeContentFingerprint(fixture.path);
          }

          const classifierOn = isClassifierEnabled();

          // Scan for reusable (fresh) results.
          let fixturesToRun = selectedFixtures;
          if (!options.force && !options.smoke) {
            const reusable = scanReusableResults(resultsDir, experimentName, fingerprints, {
              enforceReuseCompatibility: true,
              reuseCompatibilityFingerprint,
            });
            if (reusable.size > 0) {
              fixturesToRun = selectedFixtures.filter((f) => !reusable.has(f.name));
            }
          }

          if (fixturesToRun.length > 0) {
            if (dashboard) {
              dashboard.addExperiment(experimentName, {
                agent: config.agent,
                model,
                totalEvals: fixturesToRun.length,
              });
            } else {
              console.log(chalk.blue(`\nRunning ${experimentName}: ${fixturesToRun.length} eval(s)`));
            }

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
                contentFingerprints,
                smoke: options.smoke,
                onProgress,
                rateLimiter,
              });

              // Classify failures (only if classifier is enabled)
              const failedEvals = results.evals.filter((e) => e.passedRuns === 0);
              const classifications = new Map<string, Classification>();

              if (classifierOn) {
                if (dashboard) {
                  dashboard.setPhase(experimentName, 'classifying');
                }

                if (failedEvals.length > 0 && !options.smoke) {
                  const timestamp = results.startedAt.replace(/:/g, '-');
                  const classifyLimit = pLimit(4);
                  let classifyingDone = 0;
                  const classifyingTotal = failedEvals.length;
                  let hasNonModelFailures = false;
                  const classifierErrors: { evalName: string; error: unknown }[] = [];

                  await Promise.all(
                    failedEvals.map((evalSummary) =>
                      classifyLimit(async () => {
                        const evalResultDir = resolve(resultsDir, experimentName, timestamp, evalSummary.name);
                        let classification: Classification | null = null;
                        try {
                          classification = await classifyFailure(
                            evalResultDir,
                            evalSummary.name,
                            experimentName
                          );
                        } catch (err) {
                          classifierErrors.push({ evalName: evalSummary.name, error: err });
                        }

                        classifyingDone++;
                        if (dashboard) {
                          dashboard.setClassifyingProgress(experimentName, classifyingDone, classifyingTotal);
                        }

                        if (classification) {
                          classifications.set(evalSummary.name, classification);

                          if (!dashboard) {
                            const icon = { model: '  ', infra: '  ', timeout: '  ' }[classification.failureType];
                            console.log(chalk.gray(`  ${icon} ${evalSummary.name}: ${classification.failureType} — ${classification.failureReason}`));
                          }

                          if (classification.failureType !== 'model') {
                            hasNonModelFailures = true;
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
                            }
                          }
                        }
                      })
                    )
                  );

                  if (classifierErrors.length > 0) {
                    // Surface classifier failures loudly. Without classification.json,
                    // the cache reuse logic in scanReusableResults will force these
                    // failures to re-run on every subsequent invocation. The user
                    // needs to know exactly why classification failed (e.g. AI gateway
                    // billing, network) so they can fix the root cause.
                    console.error(
                      chalk.red(
                        `\n  ⚠️  Classifier failed for ${classifierErrors.length}/${classifyingTotal} eval(s):`
                      )
                    );
                    const seen = new Set<string>();
                    for (const { evalName, error } of classifierErrors) {
                      const msg = error instanceof Error ? error.message : String(error);
                      console.error(chalk.red(`     - ${evalName}: ${msg.split('\n')[0]}`));
                      seen.add(msg.split('\n')[0]);
                    }
                    console.error(
                      chalk.gray(
                        `     These failures have no classification.json and will re-run next invocation.`
                      )
                    );
                    if (seen.size === 1 && [...seen][0].toLowerCase().includes('insufficient funds')) {
                      console.error(
                        chalk.gray(
                          `     Top up your AI Gateway credits at https://vercel.com/dashboard → AI to fix.`
                        )
                      );
                    }
                  }

                  if (hasNonModelFailures && !options.ackFailures && !dashboard) {
                    console.log(chalk.yellow(`\n  To keep non-model failures as final results, re-run with --ack-failures`));
                  }
                }
              }

              if (dashboard) {
                dashboard.completeExperiment(experimentName, results, classifications);
              }
            } catch (err) {
              console.error(chalk.red(`  Error running ${experimentName}: ${err instanceof Error ? err.message : err}`));
              allPassed = false;
              if (dashboard) {
                dashboard.setPhase(experimentName, 'done');
              }
            }

            const stats = housekeep(resultsDir, experimentName);
            if (stats.removedDuplicates + stats.removedIncomplete + stats.removedNonModelFailures > 0) {
              console.log(
                chalk.gray(
                  `  Housekeeping: removed ${stats.removedDuplicates} duplicate(s), ${stats.removedIncomplete} incomplete, ${stats.removedNonModelFailures} non-model failure(s)`
                )
              );
            }
          }

          // Determine final pass/fail for this experiment+model
          const finalReusable = scanReusableResults(resultsDir, experimentName, fingerprints, {
            enforceReuseCompatibility: true,
            reuseCompatibilityFingerprint,
          });
          const experimentPassed = selectedFixtures.every((f) => {
            const r = finalReusable.get(f.name);
            return r != null && r.passRate !== '0%';
          });
          if (!experimentPassed) allPassed = false;
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
 * Resolve and validate the standard project layout (experiments/, evals/, results/).
 * Shared by `status`, `run`, and `refingerprint`.
 */
function resolveProjectDirs(): { experimentsDir: string; evalsDir: string; resultsDir: string } {
  const projectDir = process.cwd();
  const experimentsDir = resolve(projectDir, 'experiments');
  const evalsDir = resolve(projectDir, 'evals');
  const resultsDir = resolve(projectDir, 'results');
  if (!existsSync(experimentsDir) || !existsSync(resultsDir)) {
    console.error(chalk.red('experiments/ and results/ directories are required'));
    process.exit(1);
  }
  return { experimentsDir, evalsDir, resultsDir };
}

/** Select experiment config files, optionally filtered by name/glob args. */
function selectExperimentFiles(experimentsDir: string, experimentArgs: string[]): string[] {
  const allFiles = readdirSync(experimentsDir)
    .filter((f) => f.endsWith('.ts') && !f.startsWith('_temp_'))
    .sort();
  return experimentArgs.length > 0
    ? allFiles.filter((f) => {
        const name = f.replace(/\.ts$/, '');
        return experimentArgs.some((arg) => (arg.includes('*') ? minimatch(name, arg) : name === arg));
      })
    : allFiles;
}

/** The newest result summary for an (experiment, eval), or null if never run. */
function findNewestSummary(experimentResultsDir: string, evalName: string): Record<string, unknown> | null {
  if (!existsSync(experimentResultsDir)) return null;
  const timestamps = readdirSync(experimentResultsDir)
    .filter((t) => !t.startsWith('.'))
    .sort()
    .reverse();
  for (const ts of timestamps) {
    const sp = join(experimentResultsDir, ts, evalName, 'summary.json');
    if (existsSync(sp)) {
      try {
        return JSON.parse(readFileSync(sp, 'utf-8'));
      } catch {
        /* skip */
      }
    }
  }
  return null;
}

/**
 * Status handler: the one read-only command to answer "what's the work to be done?"
 * after editing or syncing evals. For each (experiment, eval) it classifies the newest
 * result by EVAL CONTENT (so a benign config-only change isn't reported as work):
 *
 *   - new      → the eval was never run for this experiment
 *   - changed  → the eval's content changed since it was run
 *   - up to date
 *
 * The framework only REPORTS; it has no opinion on which staleness is acceptable —
 * that policy lives in the consumer (e.g. `agent-eval status --json` in CI, filtered
 * against the repo's own accepted-stale list). `--check` is a simple gate that fails
 * on any new/changed eval. Writes nothing.
 */
interface StatusRow { name: string; baseName: string; newEvals: string[]; changedEvals: string[]; cached: number }

async function statusCommand(
  experimentArgs: string[],
  options: { check?: boolean; json?: boolean } = {}
): Promise<{ rows: StatusRow[]; totalRun: number }> {
  const { experimentsDir, evalsDir, resultsDir } = resolveProjectDirs();
  const selectedFiles = selectExperimentFiles(experimentsDir, experimentArgs);
  const { fixtures } = loadAllFixtures(evalsDir);
  const availableNames = fixtures.map((f) => f.name);
  const fixtureByName = new Map(fixtures.map((f) => [f.name, f]));

  const allNew = new Set<string>();
  const allChanged = new Set<string>();
  const rows: StatusRow[] = [];

  for (const file of selectedFiles) {
    let config;
    try {
      config = await loadConfig(resolve(experimentsDir, file));
    } catch (err) {
      if (!options.json) console.warn(chalk.yellow(`Skipping ${file}: ${err instanceof Error ? err.message : err}`));
      continue;
    }
    const baseName = file.replace(/\.ts$/, '');
    const models = Array.isArray(config.model) ? config.model : [config.model];
    let evalNames: string[];
    try {
      evalNames = resolveEvalNames(config.evals, availableNames);
    } catch {
      evalNames = availableNames;
    }

    for (const model of models) {
      const experimentName = models.length > 1 ? `${baseName}/${model}` : baseName;
      const modelConfig = { ...config, model };
      const expResultsDir = join(resultsDir, experimentName);
      const newEvals: string[] = [];
      const changedEvals: string[] = [];
      let cached = 0;

      for (const ev of evalNames) {
        const fx = fixtureByName.get(ev);
        if (!fx) continue;
        const summary = findNewestSummary(expResultsDir, ev);
        if (!summary) {
          newEvals.push(ev);
          allNew.add(ev);
          continue;
        }
        const content = computeContentFingerprint(fx.path);
        const storedContent = summary.contentFingerprint as string | undefined;
        const reuseCompatibilityFingerprint = computeReuseCompatibilityFingerprint(modelConfig as never);
        const reuseCompatible = summary.reuseCompatibilityFingerprint === reuseCompatibilityFingerprint;
        // Content-based: a config-only change isn't work (refingerprint carries it).
        // Legacy results (no content hash) fall back to the combined fingerprint.
        const fresh = reuseCompatible && (storedContent !== undefined
          ? storedContent === content
          : summary.fingerprint === computeFingerprint(fx.path, modelConfig as never));
        if (fresh) cached++;
        else {
          changedEvals.push(ev);
          allChanged.add(ev);
        }
      }
      rows.push({ name: experimentName, baseName, newEvals, changedEvals, cached });
    }
  }

  const totalRun = rows.reduce((s, r) => s + r.newEvals.length + r.changedEvals.length, 0);

  if (options.json) {
    const work = rows
      .filter((r) => r.newEvals.length || r.changedEvals.length)
      .map((r) => ({ experiment: r.name, new: r.newEvals, changed: r.changedEvals }));
    console.log(JSON.stringify({ totalRun, work }, null, 2));
    return { rows, totalRun };
  }

  console.log('');
  if (allNew.size > 0 || allChanged.size > 0) {
    console.log(chalk.bold('Evals needing work:'));
    for (const e of [...allNew].sort()) console.log(`  ${chalk.green('new')}      ${e}`);
    for (const e of [...allChanged].sort()) console.log(`  ${chalk.yellow('changed')}  ${e}`);
    console.log('');
  }

  if (totalRun === 0) {
    console.log(chalk.green('Everything up to date — nothing to run.\n'));
    return { rows, totalRun: 0 };
  }

  const nameWidth = Math.max(...rows.map((r) => r.name.length)) + 2;
  console.log(chalk.bold(`Work to do — ${totalRun} run(s) across ${rows.filter((r) => r.newEvals.length + r.changedEvals.length).length} experiment(s):`));
  for (const r of rows) {
    const n = r.newEvals.length + r.changedEvals.length;
    if (n === 0) continue;
    const extra = r.cached ? chalk.gray(`  (${r.cached} up to date)`) : '';
    console.log(`  ${r.name.padEnd(nameWidth)}${chalk.yellow(`${n} to run`)}${extra}`);
  }
  console.log('');
  console.log(chalk.gray('Run:  agent-eval run <experiment...>   (or run `agent-eval` to pick interactively)'));
  console.log('');

  if (options.check) {
    console.log(chalk.red(`✗ ${totalRun} eval-run(s) outstanding.`));
    process.exitCode = 1;
  }
  return { rows, totalRun };
}

/**
 * Refingerprint handler: carry forward CONFIG-only changes in existing results so
 * benign edits (e.g. a timeout bump) don't trigger reruns — WITHOUT masking real
 * eval changes. For each committed result we compare the eval's current content
 * fingerprint to the one the result was produced with:
 *
 *   - content unchanged → re-stamp the combined fingerprint (carry the config change)
 *   - content changed    → leave it stale (an honest "this eval changed, rerun me")
 *   - legacy result (no stored content fingerprint) → adopt the current content
 *     fingerprint only if the result is already fully current; otherwise leave stale
 *
 * This replaces the old consumer-side `updateFingerprints`, which re-stamped every
 * result unconditionally and so silently hid eval changes.
 */
async function carryForwardConfigChanges(
  experimentsDir: string,
  evalsDir: string,
  resultsDir: string,
  selectedFiles: string[],
  dry = false
): Promise<{ carried: number; stale: number }> {
  let carried = 0;
  let stale = 0;
  for (const file of selectedFiles) {
    let config;
    try {
      config = await loadConfig(resolve(experimentsDir, file));
    } catch {
      continue;
    }
    const baseName = file.replace(/\.ts$/, '');
    const models = Array.isArray(config.model) ? config.model : [config.model];
    for (const model of models) {
      const experimentName = models.length > 1 ? `${baseName}/${model}` : baseName;
      const modelConfig = { ...config, model };
      const expResultsDir = join(resultsDir, experimentName);
      if (!existsSync(expResultsDir)) continue;
      for (const timestamp of readdirSync(expResultsDir)) {
        const tsDir = join(expResultsDir, timestamp);
        if (!statSync(tsDir).isDirectory()) continue;
        for (const evalName of readdirSync(tsDir)) {
          const summaryPath = join(tsDir, evalName, 'summary.json');
          const evalPath = join(evalsDir, evalName);
          if (!existsSync(summaryPath) || !existsSync(evalPath)) continue;
          const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
          const decision = decideRefingerprint(
            {
              fingerprint: summary.fingerprint,
              contentFingerprint: summary.contentFingerprint,
              reuseCompatibilityFingerprint: summary.reuseCompatibilityFingerprint,
            },
            {
              fingerprint: computeFingerprint(evalPath, modelConfig as never),
              contentFingerprint: computeContentFingerprint(evalPath),
              reuseCompatibilityFingerprint: computeReuseCompatibilityFingerprint(modelConfig as never),
            }
          );
          let changed = false;
          if (decision.fingerprint !== undefined) {
            summary.fingerprint = decision.fingerprint;
            changed = true;
          }
          if (decision.contentFingerprint !== undefined) {
            summary.contentFingerprint = decision.contentFingerprint;
            changed = true;
          }
          if (decision.stale) stale++;
          if (changed) {
            carried++;
            if (!dry) writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
          }
        }
      }
    }
  }
  return { carried, stale };
}

async function refingerprintCommand(experimentArgs: string[], options: { dry?: boolean }) {
  const { experimentsDir, evalsDir, resultsDir } = resolveProjectDirs();
  const selectedFiles = selectExperimentFiles(experimentsDir, experimentArgs);
  const { carried, stale } = await carryForwardConfigChanges(experimentsDir, evalsDir, resultsDir, selectedFiles, options.dry);
  const verb = options.dry ? 'would carry forward' : 'carried forward';
  console.log(chalk.green(`Refingerprint: ${verb} ${carried} config-only result(s).`));
  if (stale > 0) {
    console.log(chalk.yellow(`${stale} result(s) have a changed eval and were left stale — run them to refresh.`));
  }
}

/** Run the chosen experiments: carry config-only changes forward, then run their
 * new/changed evals (reuse handles the rest). Selection is explicit — there is no
 * "run everything." */
async function runSelected(
  experimentArgs: string[],
  options: { force?: boolean; smoke?: boolean; ackFailures?: boolean }
): Promise<void> {
  const { experimentsDir, evalsDir, resultsDir } = resolveProjectDirs();
  const files = selectExperimentFiles(experimentsDir, experimentArgs);
  if (files.length === 0) {
    console.error(chalk.red(`No experiments matched: ${experimentArgs.join(', ')}`));
    process.exit(1);
  }
  // Carry config-only changes forward first so a config edit (e.g. pinning a judge)
  // doesn't make every eval look changed.
  await carryForwardConfigChanges(experimentsDir, evalsDir, resultsDir, files);
  await runAllCommand(experimentArgs, options);
}

/** Read one line from the user (interactive multi-select uses this). */
function promptLine(question: string): Promise<string> {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      res(ans.trim());
    });
  });
}

/** Numbered multi-select over experiment names. Returns the picked names. */
async function pickExperiments(choices: string[]): Promise<string[]> {
  console.log(chalk.bold('Pick experiments to run:'));
  choices.forEach((c, i) => console.log(`  ${chalk.cyan(String(i + 1).padStart(2))}  ${c}`));
  const ans = await promptLine(chalk.bold('\nNumbers (e.g. 1,3), "all", or Enter to skip: '));
  if (!ans) return [];
  if (ans.toLowerCase() === 'all') return choices;
  const picked = new Set<string>();
  for (const tok of ans.split(/[\s,]+/)) {
    const n = Number(tok);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) picked.add(choices[n - 1]);
  }
  return [...picked];
}

program
  .command('run')
  .description('Run new/changed evals for the named experiment(s). You must name what to run')
  .argument('<experiments...>', 'Experiment names or glob patterns')
  .option('--force', 'Ignore fingerprints, re-run everything')
  .option('--smoke', 'Run 1 eval per experiment for sanity checking')
  .option('--ack-failures', 'Keep non-model failures (infra/timeout) as final results instead of deleting them')
  .action(runSelected);

program
  .command('status')
  .description('Show new/changed evals and the work to do, per experiment. Read-only')
  .argument('[experiments...]', 'Experiment names or glob patterns (default: all)')
  .option('--check', 'Exit non-zero if any new/changed eval is outstanding (for CI)')
  .option('--json', 'Machine-readable output (for custom CI policy / ignore lists)')
  .action(async (experimentArgs, options) => {
    await statusCommand(experimentArgs, options);
  });

program
  .command('refingerprint')
  .description('(internal) Carry config-only changes forward in cached results; run by sync')
  .argument('[experiments...]', 'Experiment names or glob patterns (default: all)')
  .option('--dry', 'Preview without writing')
  .action(refingerprintCommand);

/**
 * Default command (bare `agent-eval`): show status, then — in a terminal — let the
 * user multi-select which experiments to run. Never auto-runs everything. A config
 * path/name still runs that single experiment (back-compat).
 */
program
  .argument('[config]', 'Experiment name or path to run directly. Omit to show status + pick.')
  .option('--dry', 'Preview a single experiment without executing')
  .option('--smoke', 'Run a single eval to verify setup (API keys, model IDs, sandbox)')
  .option('--force', 'Ignore fingerprints, re-run everything')
  .option('--ack-failures', 'Keep non-model failures (infra/timeout) as final results instead of deleting them')
  .action(async (configInput: string | undefined, options: { dry?: boolean; smoke?: boolean; force?: boolean; ackFailures?: boolean }) => {
    if (configInput) {
      await runExperimentCommand(configInput, options);
      return;
    }
    const plan = await statusCommand([]);
    if (plan.totalRun === 0) return;
    if (!process.stdin.isTTY || !process.stdout.isTTY) return; // non-interactive (CI): status only
    const choices = [...new Set(plan.rows.filter((r) => r.newEvals.length + r.changedEvals.length > 0).map((r) => r.baseName))];
    const selected = await pickExperiments(choices);
    if (selected.length === 0) {
      console.log(chalk.gray('Nothing selected — run `agent-eval run <experiment...>` anytime.\n'));
      return;
    }
    await runSelected(selected, options);
  });

program.parse();
