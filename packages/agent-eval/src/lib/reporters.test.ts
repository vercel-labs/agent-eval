import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { stripVTControlCharacters } from 'node:util';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runExperiment } from './runner.js';
import { httpReporter, jsonlReporter } from './reporters.js';
import { createConsoleProgressHandler } from './dashboard.js';
import type {
  Classification,
  EvalFixture,
  ProgressEvent,
  Reporter,
  ReporterExperimentEvent,
  ReporterRunEvent,
  ResolvedExperimentConfig,
} from './types.js';
import type { Agent, AgentRunResult } from './agents/types.js';
import * as agentsIndex from './agents/index.js';
import { REDACTED } from './agents/redact.js';

const TEST_DIR = '/tmp/eval-framework-reporters-test';
const API_KEY = 'sk-test-reporter-key-0123456789';

const fixture = (name: string): EvalFixture => ({ name, path: `/fake/${name}`, prompt: `Do ${name}`, isModule: true });

function mockAgent(result: Partial<AgentRunResult> = {}, definition?: Agent['definition']): Agent {
  return {
    name: 'mock-agent',
    displayName: 'Mock Agent',
    getApiKeyEnvVar: () => 'MOCK_API_KEY',
    getDefaultModel: () => 'mock-model',
    run: vi.fn(async () => ({
      success: true,
      output: 'done',
      duration: 6000,
      testResult: { success: true, output: 'ok' },
      ...result,
    })),
    ...(definition ? { definition } : {}),
  } as Agent;
}

const baseConfig: ResolvedExperimentConfig = {
  agent: 'claude-code',
  model: 'opus',
  evals: '*',
  runs: 1,
  earlyExit: false,
  scripts: [],
  timeout: 600,
};

/** A reporter that records every event it receives, in order, into `log`. */
function recordingReporter(name: string, log: Array<{ reporter: string; hook: string; event: unknown }>): Reporter {
  return {
    name,
    onRunComplete: (event) => {
      log.push({ reporter: name, hook: 'run', event });
    },
    onExperimentComplete: (event) => {
      log.push({ reporter: name, hook: 'experiment', event });
    },
  };
}

describe('reporters in runExperiment', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('delivers run events after onRunComplete and the experiment event after results are saved', async () => {
    vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent());
    const log: Array<{ reporter: string; hook: string; event: unknown }> = [];
    let summaryOnDiskDuringExperimentEvent: boolean | undefined;

    const results = await runExperiment({
      config: {
        ...baseConfig,
        runs: 2,
        onRunComplete: ({ runData }) => ({
          ...runData,
          result: { ...runData.result, analysis: { graded: true } },
        }),
        reporters: [recordingReporter('first', log)],
      },
      reporters: [
        {
          name: 'second',
          onRunComplete: (event) => {
            log.push({ reporter: 'second', hook: 'run', event });
          },
          onExperimentComplete: (event) => {
            summaryOnDiskDuringExperimentEvent = existsSync(join(event.outputDir, 'button', 'summary.json'));
            log.push({ reporter: 'second', hook: 'experiment', event });
          },
        },
      ],
      fixtures: [fixture('button')],
      apiKey: API_KEY,
      resultsDir: TEST_DIR,
      experimentName: 'reporting',
      fingerprints: { button: 'fp-button' },
      contentFingerprints: { button: 'cfp-button' },
    });

    // Every run event lands before any experiment event. Runs finish
    // concurrently, so their events may interleave, but within one run config
    // reporters are called before option reporters.
    expect(log.slice(-2).map(({ reporter, hook }) => `${reporter}:${hook}`)).toEqual([
      'first:experiment',
      'second:experiment',
    ]);
    const runEntries = log.slice(0, -2);
    const callsForRun = (runIndex: number) =>
      runEntries
        .filter(({ event }) => (event as ReporterRunEvent).runIndex === runIndex)
        .map(({ reporter, hook }) => `${reporter}:${hook}`);
    expect(callsForRun(0)).toEqual(['first:run', 'second:run']);
    expect(callsForRun(1)).toEqual(['first:run', 'second:run']);

    const runEvents = runEntries.map(({ event }) => event as ReporterRunEvent);
    expect(runEvents[0]).toMatchObject({
      schemaVersion: 1,
      experimentName: 'reporting',
      evalName: 'button',
      agent: 'claude-code',
      model: 'opus',
      fingerprint: 'fp-button',
      contentFingerprint: 'cfp-button',
      // The user's hook ran first, so its analysis is part of the reported result.
      result: { status: 'passed', analysis: { graded: true } },
    });

    expect(summaryOnDiskDuringExperimentEvent).toBe(true);
    const experimentEvent = log.at(-1)!.event as ReporterExperimentEvent;
    expect(experimentEvent).toMatchObject({ schemaVersion: 1, experimentName: 'reporting', reused: [] });
    expect(experimentEvent.results.evals[0]).toMatchObject({ name: 'button', totalRuns: 2, passedRuns: 2 });
    expect(experimentEvent).not.toHaveProperty('classifications');
    expect(results.evals[0].passedRuns).toBe(2);
  });

  it('isolates reporter failures: results are unchanged, other reporters still run, failures are reported', async () => {
    vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent());
    const log: Array<{ reporter: string; hook: string; event: unknown }> = [];
    const progress: ProgressEvent[] = [];

    const results = await runExperiment({
      config: {
        ...baseConfig,
        reporters: [
          {
            name: 'broken',
            onRunComplete: () => {
              throw new Error('ingest endpoint unavailable');
            },
            onExperimentComplete: async () => {
              throw new Error('bucket write denied');
            },
          },
          recordingReporter('healthy', log),
        ],
      },
      fixtures: [fixture('button')],
      apiKey: API_KEY,
      resultsDir: TEST_DIR,
      experimentName: 'isolation',
      onProgress: (event) => progress.push(event),
    });

    expect(results.evals[0]).toMatchObject({ totalRuns: 1, passedRuns: 1, passRate: 100 });
    const outputDir = join(TEST_DIR, 'isolation', results.startedAt.replace(/:/g, '-'));
    const summary = JSON.parse(readFileSync(join(outputDir, 'button', 'summary.json'), 'utf-8'));
    expect(summary.passRate).toBe('100%');

    expect(log.map(({ reporter, hook }) => `${reporter}:${hook}`)).toEqual(['healthy:run', 'healthy:experiment']);
    expect(progress.filter((event) => event.type === 'reporter:error')).toEqual([
      {
        type: 'reporter:error',
        reporter: 'broken',
        hook: 'onRunComplete',
        evalName: 'button',
        runNumber: 1,
        error: 'ingest endpoint unavailable',
      },
      { type: 'reporter:error', reporter: 'broken', hook: 'onExperimentComplete', error: 'bucket write denied' },
    ]);
  });

  it('logs reporter failures when no progress handler is attached', async () => {
    vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent());
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message: string) => {
      warnings.push(message);
    });

    await runExperiment({
      config: { ...baseConfig, reporters: [{ name: 'broken', onExperimentComplete: () => { throw new Error('nope'); } }] },
      fixtures: [fixture('button')],
      apiKey: API_KEY,
      resultsDir: TEST_DIR,
      experimentName: 'logging',
    });

    expect(warnings).toEqual(['\u26a0 Reporter "broken" failed in onExperimentComplete: nope']);
  });

  it('redacts run credentials from payloads, including data the onRunComplete hook attached', async () => {
    // A judge pinned to a different agent authenticates with its own key, so the
    // reporter payload must be scrubbed of that key too.
    const judgeKey = 'gateway-judge-key-abcdef0123456789';
    vi.stubEnv('AI_GATEWAY_API_KEY', judgeKey);
    const codexDefinition = agentsIndex.getAgent('codex').definition;
    vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(
      mockAgent({ output: `token ${API_KEY}` }, codexDefinition)
    );
    const log: Array<{ reporter: string; hook: string; event: unknown }> = [];
    const progress: ProgressEvent[] = [];

    try {
      await runExperiment({
        config: {
          ...baseConfig,
          agent: 'codex',
          model: 'gpt-5.4',
          judge: { agent: 'vercel-ai-gateway/claude-code', model: 'claude-opus-4-8' },
          onRunComplete: ({ runData }) => ({
            ...runData,
            result: {
              ...runData.result,
              metadata: { env: `OPENAI_API_KEY=${API_KEY}`, nested: [{ judge: judgeKey }] },
            },
          }),
          reporters: [
            recordingReporter('recorder', log),
            {
              name: 'echo',
              onRunComplete: () => {
                throw new Error(`rejected credential ${API_KEY}`);
              },
            },
          ],
        },
        fixtures: [fixture('button')],
        apiKey: API_KEY,
        resultsDir: TEST_DIR,
        experimentName: 'redaction',
        onProgress: (event) => progress.push(event),
      });
    } finally {
      vi.unstubAllEnvs();
    }

    const runEvent = log.find(({ hook }) => hook === 'run')!.event as ReporterRunEvent;
    expect(runEvent.result.metadata).toEqual({
      env: `OPENAI_API_KEY=${REDACTED}`,
      nested: [{ judge: REDACTED }],
    });
    const experimentEvent = log.find(({ hook }) => hook === 'experiment')!.event as ReporterExperimentEvent;
    const serialized = JSON.stringify(experimentEvent.results.evals);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(judgeKey);
    expect(progress).toContainEqual(expect.objectContaining({ type: 'reporter:error', error: `rejected credential ${REDACTED}` }));
  });

  it('lists reused evals without emitting run events for them', async () => {
    const agent = mockAgent();
    vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(agent);
    const log: Array<{ reporter: string; hook: string; event: unknown }> = [];

    await runExperiment({
      config: { ...baseConfig, reporters: [recordingReporter('recorder', log)] },
      fixtures: [fixture('changed-eval')],
      reusedEvals: ['cached-a', 'cached-b'],
      apiKey: API_KEY,
      resultsDir: TEST_DIR,
      experimentName: 'reuse',
    });

    const runEvents = log.filter(({ hook }) => hook === 'run').map(({ event }) => (event as ReporterRunEvent).evalName);
    expect(runEvents).toEqual(['changed-eval']);
    const experimentEvent = log.find(({ hook }) => hook === 'experiment')!.event as ReporterExperimentEvent;
    expect(experimentEvent.reused).toEqual(['cached-a', 'cached-b']);
    expect(experimentEvent.results.evals.map((summary) => summary.name)).toEqual(['changed-eval']);
  });

  it('runs the classify step after saving and before reporters, and includes its classifications', async () => {
    vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(
      mockAgent({ success: false, error: 'API Error: 503', testResult: undefined })
    );
    const log: Array<{ reporter: string; hook: string; event: unknown }> = [];
    let savedBeforeClassify: boolean | undefined;

    await runExperiment({
      config: { ...baseConfig, reporters: [recordingReporter('recorder', log)] },
      fixtures: [fixture('flaky')],
      apiKey: API_KEY,
      resultsDir: TEST_DIR,
      experimentName: 'classified',
      classify: async (_results, outputDir) => {
        savedBeforeClassify = existsSync(join(outputDir, 'flaky', 'summary.json'));
        const classification: Classification = { failureType: 'infra', failureReason: 'Provider returned 503' };
        return new Map([['flaky', classification]]);
      },
    });

    expect(savedBeforeClassify).toBe(true);
    const experimentEvent = log.find(({ hook }) => hook === 'experiment')!.event as ReporterExperimentEvent;
    expect(experimentEvent.classifications).toEqual({
      flaky: { failureType: 'infra', failureReason: 'Provider returned 503' },
    });
  });
});

describe('CLI output for reporter failures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists each failed reporter call in the console progress output', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((line: string) => {
      lines.push(line);
    });
    const handler = createConsoleProgressHandler({ experimentName: 'e', model: 'opus', agent: 'claude-code' });

    handler({ type: 'reporter:error', reporter: 'http', hook: 'onRunComplete', evalName: 'button', runNumber: 2, error: 'HTTP 500' });
    handler({ type: 'reporter:error', reporter: 'jsonl', hook: 'onExperimentComplete', error: 'EACCES' });

    expect(lines.map((line) => stripVTControlCharacters(line))).toEqual([
      '\u26a0 Reporter "http" failed in onRunComplete for button run 2: HTTP 500',
      '\u26a0 Reporter "jsonl" failed in onExperimentComplete: EACCES',
    ]);
  });
});

describe('jsonlReporter', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('appends one JSON line per run to the file', async () => {
    vi.spyOn(agentsIndex, 'getAgent').mockReturnValue(mockAgent());
    const path = join(TEST_DIR, 'exports', 'runs.jsonl');
    mkdirSync(join(TEST_DIR, 'exports'), { recursive: true });
    writeFileSync(path, '{"previous":"line"}\n');

    await runExperiment({
      config: { ...baseConfig, runs: 2, reporters: [jsonlReporter({ path })] },
      fixtures: [fixture('alpha'), fixture('beta')],
      apiKey: API_KEY,
      resultsDir: TEST_DIR,
      experimentName: 'jsonl',
    });

    const lines = readFileSync(path, 'utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[0])).toEqual({ previous: 'line' });
    const events = lines.slice(1).map((line) => JSON.parse(line) as ReporterRunEvent);
    expect(events.map((event) => `${event.evalName}#${event.runIndex}`).sort()).toEqual([
      'alpha#0',
      'alpha#1',
      'beta#0',
      'beta#1',
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ schemaVersion: 1, experimentName: 'jsonl', result: { status: 'passed', duration: 6 } });
    }
  });

  it('creates missing parent directories', async () => {
    const path = join(TEST_DIR, 'new', 'nested', 'runs.jsonl');
    const reporter = jsonlReporter({ path });
    const event: ReporterRunEvent = {
      schemaVersion: 1,
      experimentName: 'e',
      evalName: 'x',
      runIndex: 0,
      agent: 'claude-code',
      model: 'opus',
      result: { status: 'failed', duration: 1, error: 'boom' },
    };

    await reporter.onRunComplete!(event);

    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(event);
  });
});

describe('httpReporter', () => {
  let server: Server;
  let url: string;
  let requests: Array<{ headers: IncomingMessage['headers']; body: Record<string, unknown> }>;
  let statuses: number[];

  beforeEach(async () => {
    requests = [];
    statuses = [];
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        requests.push({ headers: req.headers, body: JSON.parse(raw) });
        res.statusCode = statuses.shift() ?? 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const runEvent: ReporterRunEvent = {
    schemaVersion: 1,
    experimentName: 'e',
    evalName: 'x',
    runIndex: 0,
    agent: 'claude-code',
    model: 'opus',
    result: { status: 'passed', duration: 12 },
  };

  it('POSTs run events as JSON with the configured headers, retrying 5xx responses', async () => {
    statuses = [503, 200];
    const reporter = httpReporter({ url, headers: { authorization: 'Bearer ingest-token' }, retryDelayMs: 1 });

    await reporter.onRunComplete!(runEvent);

    expect(requests).toHaveLength(2);
    expect(requests[1].headers.authorization).toBe('Bearer ingest-token');
    expect(requests[1].headers['content-type']).toBe('application/json');
    expect(requests[1].body).toEqual({ type: 'run', ...runEvent });
  });

  it('fails without retrying on a 4xx response other than 429', async () => {
    statuses = [400];
    const reporter = httpReporter({ url, retryDelayMs: 1 });

    await expect(reporter.onRunComplete!(runEvent)).rejects.toThrow(`HTTP 400 from ${url}`);
    expect(requests).toHaveLength(1);
  });

  it('gives up after the configured retries', async () => {
    statuses = [500, 502, 429];
    const reporter = httpReporter({ url, retries: 2, retryDelayMs: 1 });

    await expect(reporter.onRunComplete!(runEvent)).rejects.toThrow(`HTTP 429 from ${url}`);
    expect(requests).toHaveLength(3);
  });

  it('sends experiment events without transcripts, file contents, functions, or reporters', async () => {
    const reporter = httpReporter({ url });
    const config: ResolvedExperimentConfig = {
      ...baseConfig,
      setup: async () => {},
      reporters: [reporter],
    };
    const event: ReporterExperimentEvent = {
      schemaVersion: 1,
      experimentName: 'e',
      outputDir: '/results/e/2026-10-08T10-00-00.000Z',
      reused: ['cached'],
      results: {
        startedAt: '2026-10-08T10:00:00.000Z',
        completedAt: '2026-10-08T10:05:00.000Z',
        config: { ...config, model: 'opus' },
        evals: [
          {
            name: 'x',
            totalRuns: 1,
            passedRuns: 1,
            passRate: 100,
            meanDuration: 12,
            runs: [
              {
                result: { status: 'passed', duration: 12 },
                transcript: '{"type":"assistant"}',
                generatedFiles: { 'src/a.ts': Buffer.from('export {}') },
              },
            ],
          },
        ],
      },
    };

    await reporter.onExperimentComplete!(event);

    expect(requests[0].body).toEqual({
      type: 'experiment',
      schemaVersion: 1,
      experimentName: 'e',
      outputDir: '/results/e/2026-10-08T10-00-00.000Z',
      reused: ['cached'],
      results: {
        startedAt: '2026-10-08T10:00:00.000Z',
        completedAt: '2026-10-08T10:05:00.000Z',
        config: {
          agent: 'claude-code',
          model: 'opus',
          evals: '*',
          runs: 1,
          earlyExit: false,
          scripts: [],
          timeout: 600,
        },
        evals: [
          { name: 'x', totalRuns: 1, passedRuns: 1, passRate: 100, meanDuration: 12, runs: [{ status: 'passed', duration: 12 }] },
        ],
      },
    });
  });
});
