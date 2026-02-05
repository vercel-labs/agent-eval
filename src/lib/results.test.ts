import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  agentResultToEvalRunData,
  createEvalSummary,
  createExperimentResults,
  saveResults,
  formatResultsTable,
  formatRunResult,
} from './results.js';
import type { AgentRunResult } from './agents/types.js';
import type { EvalRunResult, EvalRunData, ResolvedExperimentConfig } from './types.js';

const TEST_DIR = '/tmp/eval-framework-results-test';

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

      // Check outputs/ directory exists and contains script output files
      expect(existsSync(join(outputDir, 'eval-1', 'run-1', 'outputs'))).toBe(true);
      expect(existsSync(join(outputDir, 'eval-1', 'run-1', 'outputs', 'eval.txt'))).toBe(true);
      expect(existsSync(join(outputDir, 'eval-1', 'run-1', 'outputs', 'build.txt'))).toBe(true);

      // Verify output file content
      const testsOutput = readFileSync(
        join(outputDir, 'eval-1', 'run-1', 'outputs', 'eval.txt'),
        'utf-8'
      );
      expect(testsOutput).toBe('Test output here');

      const buildOutput = readFileSync(
        join(outputDir, 'eval-1', 'run-1', 'outputs', 'build.txt'),
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
      // Should have paths to transcript and outputs
      expect(resultJson.transcriptPath).toBe('./transcript.json');
      expect(resultJson.transcriptRawPath).toBe('./transcript-raw.jsonl');
      expect(resultJson.outputPaths).toEqual({
        eval: './outputs/eval.txt',
        scripts: {
          build: './outputs/build.txt',
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
});
