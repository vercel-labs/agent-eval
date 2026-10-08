import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { writeFileSync } from 'fs';
import {
  agentResultToEvalRunData,
  createEvalSummary,
  createExperimentResults,
  saveResults,
  formatResultsTable,
  formatRunResult,
  scanReusableResults,
} from './results.js';
import type { AgentRunResult } from './agents/types.js';
import type { EvalRunResult, EvalRunData, ResolvedExperimentConfig } from './types.js';

const TEST_DIR = '/tmp/eval-framework-results-test';

/**
 * A real 1x1 PNG. Byte 0 is 0x89, which is not a valid UTF-8 lead byte, so any
 * UTF-8 decode of this file replaces it with U+FFFD.
 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('results utilities', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('agentResultToEvalRunData', () => {
    it('converts successful agent result', () => {
      const agentResult: AgentRunResult = {
        success: true,
        output: 'Agent output',
        transcript: '{"role":"assistant","content":"Hello"}',
        duration: 45000,
        testResult: { success: true, output: 'test output' },
        scriptsResults: {
          build: { success: true, output: 'build output' },
        },
        sandboxId: 'sandbox-123',
      };

      const runData = agentResultToEvalRunData(agentResult);

      expect(runData.result.status).toBe('passed');
      expect(runData.result.duration).toBe(45);
      expect(runData.transcript).toBe('{"role":"assistant","content":"Hello"}');
      expect(runData.outputContent?.eval).toBe('test output');
      expect(runData.outputContent?.scripts?.build).toBe('build output');
      // No repair ran → field omitted, mirroring observedModel's omit-when-absent shape.
      expect(runData.result.modelRepair).toBeUndefined();
    });

    it('copies modelRepair through like observedModel (shell-tool repair evidence)', () => {
      const agentResult: AgentRunResult = {
        success: true,
        output: 'Agent output',
        duration: 45000,
        observedModel: 'openai/gpt-5.6-sol',
        modelRepair: 'gpt-5.6-sol',
      };

      const runData = agentResultToEvalRunData(agentResult);

      expect(runData.result.observedModel).toBe('openai/gpt-5.6-sol');
      expect(runData.result.modelRepair).toBe('gpt-5.6-sol');
    });

    it('reads token usage from the transcript with the agent\'s parser', () => {
      const transcript = [
        JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 600, output_tokens: 40 } }),
      ].join('\n');

      const runData = agentResultToEvalRunData(
        { success: true, output: '', transcript, duration: 1000 },
        { o11yAgentName: 'codex' }
      );

      expect(runData.result.usage).toEqual({
        inputTokens: 300,
        outputTokens: 40,
        cacheReadTokens: 600,
        totalTokens: 940,
      });
    });

    it('prefers usage the agent reported itself over the transcript', () => {
      const transcript = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 40 } });

      const runData = agentResultToEvalRunData(
        { success: true, output: '', transcript, duration: 1000, usage: { totalTokens: 7, costUsd: 0.01 } },
        { o11yAgentName: 'codex' }
      );

      expect(runData.result.usage).toEqual({ totalTokens: 7, costUsd: 0.01 });
    });

    it('leaves usage unset when nothing reports it', () => {
      const runData = agentResultToEvalRunData(
        { success: true, output: '', transcript: '{"type":"turn.started"}', duration: 1000 },
        { o11yAgentName: 'codex' }
      );

      expect(runData.result.usage).toBeUndefined();
      expect('usage' in runData.result).toBe(false);
    });

    it('carries provenance into the run result and result.json', () => {
      const provenance = {
        agentEvalVersion: '2.5.0',
        agentCliVersion: '2.0.14 (Claude Code)',
        sandboxBackend: 'vercel' as const,
        sandboxImage: 'vercel/sandbox/node:24@sha256:0f3c9a',
        sandboxUser: 'user',
      };
      const runData = agentResultToEvalRunData({ success: true, output: '', duration: 1000, provenance });
      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'opus',
        evals: ['eval-1'],
        runs: 1,
        earlyExit: true,
        scripts: [],
        timeout: 300,
      };

      const outputDir = saveResults(
        createExperimentResults(
          config,
          [createEvalSummary('eval-1', [runData])],
          new Date('2024-01-26T12:00:00Z'),
          new Date('2024-01-26T12:01:00Z')
        ),
        { resultsDir: TEST_DIR, experimentName: 'provenance-test' }
      );

      const resultJson = JSON.parse(readFileSync(join(outputDir, 'eval-1', 'run-1', 'result.json'), 'utf-8'));
      expect(resultJson.provenance).toEqual(provenance);
    });

    it('carries separate-verifier details into the run result', () => {
      const runData = agentResultToEvalRunData({
        success: false,
        output: '',
        duration: 1000,
        sandboxId: 'sbx-agent',
        verifier: 'separate',
        verifierSandboxId: 'sbx-verifier',
        tampering: ['vitest.config.ts'],
      });

      expect(runData.result).toMatchObject({
        verifier: 'separate',
        verifierSandboxId: 'sbx-verifier',
        tampering: ['vitest.config.ts'],
      });
    });

    it('converts failed agent result', () => {
      const agentResult: AgentRunResult = {
        success: false,
        output: 'Agent output',
        duration: 30000,
        error: 'API Error: model not found',
        testResult: { success: false, output: 'test failed' },
        scriptsResults: {},
      };

      const runData = agentResultToEvalRunData(agentResult);

      expect(runData.result.status).toBe('failed');
      expect(runData.result.error).toBe('API Error: model not found');
    });
  });

  describe('createEvalSummary', () => {
    it('creates summary from run data', () => {
      const runData: EvalRunData[] = [
        { result: { status: 'passed', duration: 10 } },
        { result: { status: 'passed', duration: 15 } },
        { result: { status: 'failed', duration: 8, error: 'Test failed' } },
      ];

      const summary = createEvalSummary('my-eval', runData);

      expect(summary.name).toBe('my-eval');
      expect(summary.totalRuns).toBe(3);
      expect(summary.passedRuns).toBe(2);
      expect(summary.passRate).toBeCloseTo(66.67, 1);
      expect(summary.meanDuration).toBeCloseTo(11, 0);
    });
  });

  describe('createExperimentResults', () => {
    it('creates experiment results with timestamps', () => {
      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'opus',
        evals: ['eval-1'],
        runs: 2,
        earlyExit: false,
        scripts: ['build'],
        timeout: 300,
      };

      const evals = [createEvalSummary('eval-1', [{ result: { status: 'passed', duration: 10 } }])];
      const startedAt = new Date('2024-01-26T12:00:00Z');
      const completedAt = new Date('2024-01-26T12:05:00Z');

      const results = createExperimentResults(config, evals, startedAt, completedAt);

      expect(results.startedAt).toBe('2024-01-26T12:00:00.000Z');
      expect(results.completedAt).toBe('2024-01-26T12:05:00.000Z');
      expect(results.config).toBe(config);
      expect(results.evals).toBe(evals);
    });
  });

  describe('saveResults', () => {
    it('saves results to disk with correct structure', () => {
      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'opus',
        evals: ['eval-1'],
        runs: 1,
        earlyExit: true,
        scripts: [],
        timeout: 300,
      };

      const evals = [
        createEvalSummary('eval-1', [
          {
            result: { status: 'passed', duration: 10 },
            transcript: '{"role":"assistant"}',
            outputContent: { eval: 'Test output here', scripts: { build: 'Build output here' } },
          },
          { result: { status: 'failed', duration: 8, error: 'Error' } },
        ]),
      ];

      const results = createExperimentResults(
        config,
        evals,
        new Date('2024-01-26T12:00:00Z'),
        new Date('2024-01-26T12:01:00Z')
      );

      const outputDir = saveResults(results, {
        resultsDir: TEST_DIR,
        experimentName: 'test-experiment',
      });

      // Check eval summary exists
      expect(existsSync(join(outputDir, 'eval-1', 'summary.json'))).toBe(true);

      // Check individual run results exist
      expect(existsSync(join(outputDir, 'eval-1', 'run-1', 'result.json'))).toBe(true);
      expect(existsSync(join(outputDir, 'eval-1', 'run-2', 'result.json'))).toBe(true);

      // Check transcript files exist for run with transcript
      expect(existsSync(join(outputDir, 'eval-1', 'run-1', 'transcript.json'))).toBe(true);
      expect(existsSync(join(outputDir, 'eval-1', 'run-1', 'transcript-raw.jsonl'))).toBe(true);
      // No transcript for run-2
      expect(existsSync(join(outputDir, 'eval-1', 'run-2', 'transcript.json'))).toBe(false);
      expect(existsSync(join(outputDir, 'eval-1', 'run-2', 'transcript-raw.jsonl'))).toBe(false);

      // Check outputs/ directory exists and contains test output + script outputs
      expect(existsSync(join(outputDir, 'eval-1', 'run-1', 'outputs'))).toBe(true);
      expect(existsSync(join(outputDir, 'eval-1', 'run-1', 'outputs', 'eval.txt'))).toBe(true);
      expect(existsSync(join(outputDir, 'eval-1', 'run-1', 'outputs', 'scripts', 'build.txt'))).toBe(true);

      // Verify output file content
      const testsOutput = readFileSync(
        join(outputDir, 'eval-1', 'run-1', 'outputs', 'eval.txt'),
        'utf-8'
      );
      expect(testsOutput).toBe('Test output here');

      const buildOutput = readFileSync(
        join(outputDir, 'eval-1', 'run-1', 'outputs', 'scripts', 'build.txt'),
        'utf-8'
      );
      expect(buildOutput).toBe('Build output here');

      // Verify summary.json format (per design: totalRuns, passedRuns, passRate as string, meanDuration)
      const summaryJson = JSON.parse(
        readFileSync(join(outputDir, 'eval-1', 'summary.json'), 'utf-8')
      );
      expect(summaryJson.totalRuns).toBe(2);
      expect(summaryJson.passedRuns).toBe(1);
      expect(summaryJson.passRate).toBe('50%');
      expect(summaryJson.meanDuration).toBe(9);
      // Should NOT have name or runs array in the file
      expect(summaryJson.name).toBeUndefined();
      expect(summaryJson.runs).toBeUndefined();

      // Verify result.json format with paths
      const resultJson = JSON.parse(
        readFileSync(join(outputDir, 'eval-1', 'run-1', 'result.json'), 'utf-8')
      );
      expect(resultJson.status).toBe('passed');
      expect(resultJson.duration).toBe(10);
      expect(resultJson.modelPolicy).toBeUndefined();
      expect(resultJson.requestedModel).toBeUndefined();
      expect(resultJson.observedModel).toBeUndefined();
      // Should have paths to transcript and outputs
      expect(resultJson.transcriptPath).toBe('./transcript.json');
      expect(resultJson.transcriptRawPath).toBe('./transcript-raw.jsonl');
      expect(resultJson.outputPaths).toEqual({
        eval: './outputs/eval.txt',
        scripts: {
          build: './outputs/scripts/build.txt',
        },
      });
      // Should NOT have raw content
      expect(resultJson.transcript).toBeUndefined();
      expect(resultJson.outputContent).toBeUndefined();

      // Verify transcript-raw.jsonl content (raw agent output)
      const rawTranscriptContent = readFileSync(
        join(outputDir, 'eval-1', 'run-1', 'transcript-raw.jsonl'),
        'utf-8'
      );
      expect(rawTranscriptContent).toBe('{"role":"assistant"}');

      // Verify transcript.json exists and is valid JSON (parsed transcript)
      const parsedTranscriptContent = readFileSync(
        join(outputDir, 'eval-1', 'run-1', 'transcript.json'),
        'utf-8'
      );
      const parsedTranscript = JSON.parse(parsedTranscriptContent);
      expect(parsedTranscript).toHaveProperty('agent');
      expect(parsedTranscript).toHaveProperty('events');
      expect(parsedTranscript).toHaveProperty('summary');
    });

    it('stores opt-in runtime compatibility in summaries', () => {
      const config: ResolvedExperimentConfig = {
        agent: 'vercel-ai-gateway/codex',
        model: 'openai/gpt-5.2-codex',
        evals: ['eval-1'],
        runs: 1,
        earlyExit: true,
        scripts: [],
        timeout: 300,
        webResearch: true,
      };
      const results = createExperimentResults(
        config,
        [createEvalSummary('eval-1', [{ result: { status: 'passed', duration: 1 } }])],
        new Date('2024-01-26T12:00:00Z'),
        new Date('2024-01-26T12:01:00Z')
      );
      const outputDir = saveResults(results, {
        resultsDir: TEST_DIR,
        experimentName: 'compatibility-experiment',
      });
      const summary = JSON.parse(
        readFileSync(join(outputDir, 'eval-1', 'summary.json'), 'utf-8')
      );

      expect(summary.reuseCompatibilityFingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    it('saves observed model metadata for native-default runs', () => {
      const config: ResolvedExperimentConfig = {
        agent: 'vercel-ai-gateway/opencode',
        model: 'native-default',
        modelPolicy: 'native-default',
        evals: ['eval-1'],
        runs: 1,
        earlyExit: true,
        scripts: [],
        timeout: 300,
      };

      const evals = [
        createEvalSummary('eval-1', [
          { result: { status: 'passed', duration: 10, observedModel: 'vercel/openai/gpt-5.5', modelRepair: 'gpt-5.5' } },
        ]),
      ];

      const results = createExperimentResults(
        config,
        evals,
        new Date('2024-01-26T12:00:00Z'),
        new Date('2024-01-26T12:01:00Z')
      );

      const outputDir = saveResults(results, {
        resultsDir: TEST_DIR,
        experimentName: 'native-default-test',
      });

      const resultJson = JSON.parse(
        readFileSync(join(outputDir, 'eval-1', 'run-1', 'result.json'), 'utf-8')
      );
      expect(resultJson.modelPolicy).toBe('native-default');
      expect(resultJson.model).toBe('vercel/openai/gpt-5.5');
      expect(resultJson.requestedModel).toBeUndefined();
      expect(resultJson.observedModel).toBe('vercel/openai/gpt-5.5');
      // Repair evidence must survive into the persisted result.json — it is the
      // removal signal for the codex shell-tool workaround (see codex/run.mjs).
      expect(resultJson.modelRepair).toBe('gpt-5.5');
    });

    it('writes a usage block to summary.json and per-run usage to result.json', () => {
      const config: ResolvedExperimentConfig = {
        agent: 'codex',
        model: 'gpt-5.4',
        evals: ['eval-1'],
        runs: 3,
        earlyExit: false,
        scripts: [],
        timeout: 300,
      };
      const transcript = JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 },
      });
      const results = createExperimentResults(
        config,
        [
          createEvalSummary('eval-1', [
            { result: { status: 'passed', duration: 10, usage: { inputTokens: 600, cacheReadTokens: 400, outputTokens: 100, totalTokens: 1100, costUsd: 0.25 } }, transcript },
            { result: { status: 'failed', duration: 12, usage: { inputTokens: 1800, cacheReadTokens: 0, outputTokens: 100, totalTokens: 1900, costUsd: 0.5 } } },
            // A run that crashed before producing a transcript reports nothing.
            { result: { status: 'failed', duration: 1, error: 'sandbox failed' } },
          ]),
        ],
        new Date('2024-01-26T12:00:00Z'),
        new Date('2024-01-26T12:01:00Z')
      );

      const outputDir = saveResults(results, { resultsDir: TEST_DIR, experimentName: 'usage-test' });

      const summary = JSON.parse(readFileSync(join(outputDir, 'eval-1', 'summary.json'), 'utf-8'));
      expect(summary.usage).toEqual({
        runsWithUsage: 2,
        totalTokens: 3000,
        meanTotalTokens: 1500,
        inputTokens: 2400,
        outputTokens: 200,
        cacheReadTokens: 400,
      });
      // One run reported no cost, so no total cost is claimed.
      expect(summary.usage.costUsd).toBeUndefined();

      const run1 = JSON.parse(readFileSync(join(outputDir, 'eval-1', 'run-1', 'result.json'), 'utf-8'));
      expect(run1.usage).toEqual({ inputTokens: 600, cacheReadTokens: 400, outputTokens: 100, totalTokens: 1100, costUsd: 0.25 });
      // The transcript summary carries the run's usage too.
      expect(run1.o11y.usage).toEqual(run1.usage);
      const run3 = JSON.parse(readFileSync(join(outputDir, 'eval-1', 'run-3', 'result.json'), 'utf-8'));
      expect(run3.usage).toBeUndefined();
    });

    it('uses usage the agent reported outside its transcript in result.json and its o11y summary', () => {
      const config: ResolvedExperimentConfig = {
        agent: 'vercel-ai-gateway/fx',
        model: 'openai/gpt-5.6-sol',
        evals: ['eval-1'],
        runs: 1,
        earlyExit: true,
        scripts: [],
        timeout: 300,
      };
      // A saved fx session: no consumed-token counts in the transcript itself.
      const transcript = JSON.stringify({ kind: 'session_detail', history: [] });
      const usage = { inputTokens: 1200, outputTokens: 450, totalTokens: 1650 };

      const outputDir = saveResults(
        createExperimentResults(
          config,
          [createEvalSummary('eval-1', [{ result: { status: 'passed', duration: 10, usage }, transcript }])],
          new Date('2024-01-26T12:00:00Z'),
          new Date('2024-01-26T12:01:00Z')
        ),
        { resultsDir: TEST_DIR, experimentName: 'reported-usage-test' }
      );

      const resultJson = JSON.parse(readFileSync(join(outputDir, 'eval-1', 'run-1', 'result.json'), 'utf-8'));
      expect(resultJson.usage).toEqual(usage);
      expect(resultJson.o11y.usage).toEqual(usage);
    });

    it('totals cost only when every run reports one, and omits usage when no run reports it', () => {
      const config: ResolvedExperimentConfig = {
        agent: 'vercel-ai-gateway/opencode',
        model: 'anthropic/claude-sonnet-4.5',
        evals: ['with-cost', 'no-usage'],
        runs: 2,
        earlyExit: false,
        scripts: [],
        timeout: 300,
      };
      const results = createExperimentResults(
        config,
        [
          createEvalSummary('with-cost', [
            { result: { status: 'passed', duration: 10, usage: { totalTokens: 1000, costUsd: 0.125 } } },
            { result: { status: 'passed', duration: 10, usage: { totalTokens: 3000, costUsd: 0.25 } } },
          ]),
          createEvalSummary('no-usage', [
            { result: { status: 'passed', duration: 10 } },
            { result: { status: 'failed', duration: 10 } },
          ]),
        ],
        new Date('2024-01-26T12:00:00Z'),
        new Date('2024-01-26T12:01:00Z')
      );

      const outputDir = saveResults(results, { resultsDir: TEST_DIR, experimentName: 'cost-test' });

      const withCost = JSON.parse(readFileSync(join(outputDir, 'with-cost', 'summary.json'), 'utf-8'));
      expect(withCost.usage).toEqual({ runsWithUsage: 2, totalTokens: 4000, meanTotalTokens: 2000, costUsd: 0.375 });
      const noUsage = JSON.parse(readFileSync(join(outputDir, 'no-usage', 'summary.json'), 'utf-8'));
      expect(noUsage).not.toHaveProperty('usage');
      expect(results.evals[1].usage).toBeUndefined();
    });

    it('does not collide when script is named "eval"', () => {
      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'opus',
        evals: ['eval-1'],
        runs: 1,
        earlyExit: true,
        scripts: ['eval'],
        timeout: 300,
      };

      const evals = [
        createEvalSummary('eval-1', [
          {
            result: { status: 'passed', duration: 10 },
            outputContent: {
              eval: 'EVAL.ts test output',
              scripts: { eval: 'npm run eval output' },
            },
          },
        ]),
      ];

      const results = createExperimentResults(
        config,
        evals,
        new Date('2024-01-26T12:00:00Z'),
        new Date('2024-01-26T12:01:00Z')
      );

      const outputDir = saveResults(results, {
        resultsDir: TEST_DIR,
        experimentName: 'collision-test',
      });

      // Both files should exist and have different content
      const evalTestOutput = readFileSync(
        join(outputDir, 'eval-1', 'run-1', 'outputs', 'eval.txt'),
        'utf-8'
      );
      expect(evalTestOutput).toBe('EVAL.ts test output');

      const evalScriptOutput = readFileSync(
        join(outputDir, 'eval-1', 'run-1', 'outputs', 'scripts', 'eval.txt'),
        'utf-8'
      );
      expect(evalScriptOutput).toBe('npm run eval output');
    });

    it("copyFiles 'all' writes binary fixture assets and agent output byte-for-byte", () => {
      const fixturePath = join(TEST_DIR, 'fixture');
      mkdirSync(join(fixturePath, 'public'), { recursive: true });
      writeFileSync(join(fixturePath, 'PROMPT.md'), 'Task');
      writeFileSync(join(fixturePath, 'EVAL.ts'), 'test');
      writeFileSync(join(fixturePath, 'public/favicon.png'), PNG_BYTES);

      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'opus',
        evals: ['eval-1'],
        runs: 1,
        earlyExit: true,
        scripts: [],
        timeout: 300,
        copyFiles: 'all',
      };

      const evals = [
        createEvalSummary('eval-1', [
          {
            result: { status: 'passed', duration: 10 },
            generatedFiles: { 'src/logo.png': PNG_BYTES },
          },
        ]),
      ];

      const results = createExperimentResults(
        config,
        evals,
        new Date('2024-01-26T12:00:00Z'),
        new Date('2024-01-26T12:01:00Z')
      );

      const outputDir = saveResults(results, {
        resultsDir: TEST_DIR,
        experimentName: 'binary-test',
        fixturePaths: { 'eval-1': fixturePath },
      });

      const projectDir = join(outputDir, 'eval-1', 'run-1', 'project');
      // Untouched fixture asset, copied through the 'all' path.
      expect(
        Buffer.compare(readFileSync(join(projectDir, 'public/favicon.png')), PNG_BYTES)
      ).toBe(0);
      // Asset the agent produced, captured out of the sandbox.
      expect(
        Buffer.compare(readFileSync(join(projectDir, 'src/logo.png')), PNG_BYTES)
      ).toBe(0);
    });
  });

  describe('formatResultsTable', () => {
    it('formats results as table', () => {
      const config: ResolvedExperimentConfig = {
        agent: 'claude-code',
        model: 'opus',
        evals: ['eval-1', 'eval-2'],
        runs: 2,
        earlyExit: false,
        scripts: [],
        timeout: 300,
      };

      const evals = [
        createEvalSummary('eval-1', [
          { result: { status: 'passed', duration: 10 } },
          { result: { status: 'passed', duration: 12 } },
        ]),
        createEvalSummary('eval-2', [
          { result: { status: 'passed', duration: 8 } },
          { result: { status: 'failed', duration: 15, error: 'Error' } },
        ]),
      ];

      const results = createExperimentResults(
        config,
        evals,
        new Date('2024-01-26T12:00:00Z'),
        new Date('2024-01-26T12:01:00Z')
      );

      const table = formatResultsTable(results);

      expect(table).toContain('eval-1');
      expect(table).toContain('eval-2');
      expect(table).toContain('2/2 passed');
      expect(table).toContain('1/2 passed');
      expect(table).toContain('Overall');
    });
  });

  describe('formatRunResult', () => {
    it('formats passed result', () => {
      const result: EvalRunResult = { status: 'passed', duration: 45.2 };
      const formatted = formatRunResult('my-eval', 1, 5, result);

      expect(formatted).toContain('my-eval');
      expect(formatted).toContain('1/5');
      expect(formatted).toContain('45.2');
    });

    it('formats failed result with error', () => {
      const result: EvalRunResult = {
        status: 'failed',
        duration: 30.0,
        error: 'Test assertion failed',
      };
      const formatted = formatRunResult('failing-eval', 3, 10, result);

      expect(formatted).toContain('failing-eval');
      expect(formatted).toContain('3/10');
      expect(formatted).toContain('Test assertion failed');
    });
  });

  describe('scanReusableResults', () => {
    it('finds reusable results with matching fingerprint', () => {
      // Create a fake result directory
      const expDir = join(TEST_DIR, 'my-exp', '2024-01-26T12-00-00.000Z', 'eval-1');
      mkdirSync(expDir, { recursive: true });
      writeFileSync(
        join(expDir, 'summary.json'),
        JSON.stringify({ totalRuns: 2, passedRuns: 1, passRate: '50%', meanDuration: 10, fingerprint: 'abc123' })
      );

      const result = scanReusableResults(TEST_DIR, 'my-exp', { 'eval-1': 'abc123' });
      expect(result.size).toBe(1);
      expect(result.get('eval-1')?.fingerprint).toBe('abc123');
    });

    it('skips results with mismatched fingerprint', () => {
      const expDir = join(TEST_DIR, 'my-exp', '2024-01-26T12-00-00.000Z', 'eval-1');
      mkdirSync(expDir, { recursive: true });
      writeFileSync(
        join(expDir, 'summary.json'),
        JSON.stringify({ totalRuns: 2, passedRuns: 1, passRate: '50%', meanDuration: 10, fingerprint: 'old-hash' })
      );

      const result = scanReusableResults(TEST_DIR, 'my-exp', { 'eval-1': 'new-hash' });
      expect(result.size).toBe(0);
    });

    it('skips legacy results across an enforced runtime compatibility boundary', () => {
      const expDir = join(TEST_DIR, 'my-exp', '2024-01-26T12-00-00.000Z', 'eval-1');
      mkdirSync(expDir, { recursive: true });
      writeFileSync(
        join(expDir, 'summary.json'),
        JSON.stringify({ totalRuns: 1, passedRuns: 1, passRate: '100%', fingerprint: 'abc123' })
      );

      const result = scanReusableResults(TEST_DIR, 'my-exp', { 'eval-1': 'abc123' }, {
        enforceReuseCompatibility: true,
        reuseCompatibilityFingerprint: 'runtime-v1',
      });
      expect(result.size).toBe(0);
    });

    it('skips results marked as invalid', () => {
      const expDir = join(TEST_DIR, 'my-exp', '2024-01-26T12-00-00.000Z', 'eval-1');
      mkdirSync(expDir, { recursive: true });
      writeFileSync(
        join(expDir, 'summary.json'),
        JSON.stringify({ totalRuns: 2, passedRuns: 0, passRate: '0%', meanDuration: 10, fingerprint: 'abc123', valid: false })
      );

      const result = scanReusableResults(TEST_DIR, 'my-exp', { 'eval-1': 'abc123' });
      expect(result.size).toBe(0);
    });

    it('skips unclassified results with zero passed runs', () => {
      const expDir = join(TEST_DIR, 'my-exp', '2024-01-26T12-00-00.000Z', 'eval-1');
      mkdirSync(expDir, { recursive: true });
      writeFileSync(
        join(expDir, 'summary.json'),
        JSON.stringify({ totalRuns: 2, passedRuns: 0, passRate: '0%', meanDuration: 10, fingerprint: 'abc123' })
      );

      const result = scanReusableResults(TEST_DIR, 'my-exp', { 'eval-1': 'abc123' });
      expect(result.size).toBe(0);
    });

    it('reuses classified model failures with zero passed runs', () => {
      const expDir = join(TEST_DIR, 'my-exp', '2024-01-26T12-00-00.000Z', 'eval-1');
      mkdirSync(expDir, { recursive: true });
      writeFileSync(
        join(expDir, 'summary.json'),
        JSON.stringify({ totalRuns: 2, passedRuns: 0, passRate: '0%', meanDuration: 10, fingerprint: 'abc123' })
      );
      writeFileSync(
        join(expDir, 'classification.json'),
        JSON.stringify({ failureType: 'model', failureReason: 'Wrong code' })
      );

      const result = scanReusableResults(TEST_DIR, 'my-exp', { 'eval-1': 'abc123' });
      expect(result.size).toBe(1);
    });

    it('reuses acknowledged infra failures with zero passed runs', () => {
      const expDir = join(TEST_DIR, 'my-exp', '2024-01-26T12-00-00.000Z', 'eval-1');
      mkdirSync(expDir, { recursive: true });
      writeFileSync(
        join(expDir, 'summary.json'),
        JSON.stringify({ totalRuns: 2, passedRuns: 0, passRate: '0%', meanDuration: 10, fingerprint: 'abc123' })
      );
      writeFileSync(
        join(expDir, 'classification.json'),
        JSON.stringify({ failureType: 'infra', failureReason: 'API error', acknowledged: true })
      );

      const result = scanReusableResults(TEST_DIR, 'my-exp', { 'eval-1': 'abc123' });
      expect(result.size).toBe(1);
    });

    it('skips results with zero total runs', () => {
      const expDir = join(TEST_DIR, 'my-exp', '2024-01-26T12-00-00.000Z', 'eval-1');
      mkdirSync(expDir, { recursive: true });
      writeFileSync(
        join(expDir, 'summary.json'),
        JSON.stringify({ totalRuns: 0, passedRuns: 0, passRate: '0%', meanDuration: 0, fingerprint: 'abc123' })
      );

      const result = scanReusableResults(TEST_DIR, 'my-exp', { 'eval-1': 'abc123' });
      expect(result.size).toBe(0);
    });

    it('returns empty map for non-existent experiment', () => {
      const result = scanReusableResults(TEST_DIR, 'no-such-exp', { 'eval-1': 'abc123' });
      expect(result.size).toBe(0);
    });

    it('prefers newest timestamp', () => {
      // Create two timestamps with the same eval
      for (const ts of ['2024-01-25T00-00-00.000Z', '2024-01-26T00-00-00.000Z']) {
        const expDir = join(TEST_DIR, 'my-exp', ts, 'eval-1');
        mkdirSync(expDir, { recursive: true });
        writeFileSync(
          join(expDir, 'summary.json'),
          JSON.stringify({ totalRuns: 2, passedRuns: 1, passRate: '50%', meanDuration: 10, fingerprint: 'abc123' })
        );
      }

      const result = scanReusableResults(TEST_DIR, 'my-exp', { 'eval-1': 'abc123' });
      expect(result.size).toBe(1);
      expect(result.get('eval-1')?.timestamp).toBe('2024-01-26T00-00-00.000Z');
    });
  });
});
