import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
// Pure transcript/observed-model helpers live in the in-sandbox runner (so the
// tested logic is exactly what the sandbox runs); the pure config generator lives
// in the host-side definition.
import {
  buildPiCliArgs,
  extractAgentErrorFromEvents,
  extractObservedModelFromEvents,
  isRedundantPiEvent,
  parsePiEventLine,
  runAgent,
  serializeTranscript,
} from './pi-coding-agent/run.mjs';
import {
  createPiCodingAgentDefinition,
  generatePiModelsConfig,
} from './pi-coding-agent/agent.js';
import { getAgent } from './index.js';
import type { AgentRunOptions } from './types.js';

function runOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return { prompt: 'do it', timeout: 60000, apiKey: 'test-key-0123456789', ...overrides };
}

function assistantEnd(message: Record<string, unknown>) {
  return {
    type: 'message_end',
    message: { role: 'assistant', content: [], provider: 'vercel-ai-gateway', model: 'anthropic/claude-sonnet-4.5', stopReason: 'stop', ...message },
  };
}

describe('PI agent registration', () => {
  it('registers a single gateway-only agent', () => {
    const agent = getAgent('vercel-ai-gateway/pi-coding-agent');
    expect(agent.displayName).toBe('PI Coding Agent (Vercel AI Gateway)');
    expect(agent.getApiKeyEnvVar()).toBe('AI_GATEWAY_API_KEY');
    expect(() => getAgent('pi-coding-agent')).toThrow();
  });
});

describe('generatePiModelsConfig', () => {
  it('returns undefined without extra providers', () => {
    expect(generatePiModelsConfig(undefined)).toBeUndefined();
    expect(generatePiModelsConfig({})).toBeUndefined();
  });

  it('passes extra providers through verbatim under providers', () => {
    const extraProviders = {
      'vercel-ai-gateway': { models: [{ id: 'vendor/unreleased-model' }] },
    };
    expect(JSON.parse(generatePiModelsConfig(extraProviders)!)).toEqual({ providers: extraProviders });
  });
});

describe('createPiCodingAgentDefinition', () => {
  const definition = createPiCodingAgentDefinition();

  it('uses the PI transcript parser', () => {
    expect(definition.o11yAgentName).toBe('vercel-ai-gateway/pi-coding-agent');
  });

  it('installs project deps, then the PI CLI', () => {
    expect(definition.install(runOptions()).map((step) => step.args)).toEqual([
      ['install'],
      ['install', '-g', '@earendil-works/pi-coding-agent'],
    ]);
  });

  it('installs a pinned cliPackage when given', () => {
    const steps = definition.install(runOptions({ agentOptions: { cliPackage: '@earendil-works/pi-coding-agent@0.99.1' } }));
    expect(steps[1].args).toEqual(['install', '-g', '@earendil-works/pi-coding-agent@0.99.1']);
  });

  it('writes no config by default', () => {
    expect(definition.configFiles(runOptions())).toEqual([]);
  });

  it('writes extra providers to PI models.json without the credential', () => {
    const options = runOptions({
      agentOptions: { extraProviders: { 'vercel-ai-gateway': { models: [{ id: 'vendor/unreleased-model' }] } } },
    });
    const [file] = definition.configFiles(options);

    expect(file.viaShell).toContain('~/.pi/agent/models.json');
    expect(file.viaShell).toContain('"vendor/unreleased-model"');
    expect(file.viaShell).not.toContain(options.apiKey);
  });

  it('threads thinking to the runner through extra (the judge ships no agentOptions)', () => {
    expect(definition.runnerExtra!(runOptions({ agentOptions: { thinking: 'high' } }))).toEqual({ thinking: 'high' });
    expect(definition.runnerExtra!(runOptions())).toEqual({ thinking: null });
  });

  it('exports the gateway key', () => {
    const env = definition.authEnv(runOptions());
    expect(env.AI_GATEWAY_API_KEY).toBe('test-key-0123456789');
    expect(env.PI_SKIP_VERSION_CHECK).toBe('1');
  });
});

describe('buildPiCliArgs', () => {
  it('pins the gateway provider when a model is set', () => {
    expect(buildPiCliArgs({ model: 'anthropic/claude-sonnet-4.5' })).toEqual([
      '--mode', 'json', '--no-session', '--provider', 'vercel-ai-gateway', '--model', 'anthropic/claude-sonnet-4.5',
    ]);
  });

  it('omits --provider on a native-default run (PI rejects it without --model)', () => {
    expect(buildPiCliArgs({})).toEqual(['--mode', 'json', '--no-session']);
  });

  it('adds the host-threaded thinking level', () => {
    expect(buildPiCliArgs({ model: 'anthropic/claude-sonnet-4.5', extra: { thinking: 'high' } })).toEqual([
      '--mode', 'json', '--no-session',
      '--provider', 'vercel-ai-gateway',
      '--model', 'anthropic/claude-sonnet-4.5',
      '--thinking', 'high',
    ]);
    expect(buildPiCliArgs({ extra: { thinking: null } })).not.toContain('--thinking');
  });
});

describe('PI event helpers', () => {
  it('parses event lines and ignores everything else', () => {
    expect(parsePiEventLine('{"type":"agent_start"}')).toEqual({ type: 'agent_start' });
    expect(parsePiEventLine('Warning: something')).toBeUndefined();
    expect(parsePiEventLine('{"no":"type"}')).toBeUndefined();
    expect(parsePiEventLine('{broken}')).toBeUndefined();
  });

  it('drops streaming duplicates but keeps messages and tool executions', () => {
    for (const type of ['message_start', 'message_update', 'tool_execution_update', 'turn_end', 'agent_end']) {
      expect(isRedundantPiEvent({ type })).toBe(true);
    }
    for (const type of ['session', 'message_end', 'tool_execution_start', 'tool_execution_end', 'auto_retry_end']) {
      expect(isRedundantPiEvent({ type })).toBe(false);
    }
  });

  it('serializes kept events as JSONL', () => {
    expect(serializeTranscript([])).toBeUndefined();
    expect(serializeTranscript([{ type: 'agent_start' }, { type: 'turn_start' }])).toBe(
      '{"type":"agent_start"}\n{"type":"turn_start"}'
    );
  });

  it('observes the model of the last assistant message', () => {
    expect(extractObservedModelFromEvents([])).toBeUndefined();
    expect(
      extractObservedModelFromEvents([assistantEnd({ model: 'first' }), assistantEnd({ model: 'anthropic/claude-sonnet-4.5' })])
    ).toBe('anthropic/claude-sonnet-4.5');
  });

  it('detects an in-band provider failure (PI still exits 0)', () => {
    expect(extractAgentErrorFromEvents([assistantEnd({})])).toBeUndefined();
    expect(extractAgentErrorFromEvents([assistantEnd({ stopReason: 'error', errorMessage: '401 invalid x-api-key' })])).toBe(
      '401 invalid x-api-key'
    );
    expect(extractAgentErrorFromEvents([assistantEnd({ stopReason: 'aborted' })])).toBe('PI stopped with reason "aborted"');
  });

  it('does not treat a recovered mid-run error as a failure', () => {
    expect(
      extractAgentErrorFromEvents([assistantEnd({ stopReason: 'error', errorMessage: 'overloaded' }), assistantEnd({})])
    ).toBeUndefined();
  });
});

// Lightweight runner path: a fake `pi` executable on PATH that records how it was
// invoked and replays a canned `--mode json` stream.
describe('runAgent (fake pi CLI)', () => {
  const originalPath = process.env.PATH;
  let binDir: string;
  let workDir: string;

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'fake-pi-bin-'));
    workDir = mkdtempSync(join(tmpdir(), 'fake-pi-cwd-'));
    const fakePi = `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync('invocation.json', JSON.stringify({ argv: process.argv.slice(2), prompt, cwd: process.cwd() }));
const emit = (event) => console.log(JSON.stringify(event));
const assistant = (extra) => ({ role: 'assistant', content: [], provider: 'vercel-ai-gateway', model: 'anthropic/claude-sonnet-4.5', stopReason: 'stop', ...extra });
if (prompt.includes('EXIT_NONZERO')) {
  console.error('Error: Unknown provider "nope".');
  process.exit(1);
}
emit({ type: 'session', version: 3, id: 'abc' });
console.log('not json');
if (prompt.includes('PROVIDER_ERROR')) {
  emit({ type: 'message_end', message: assistant({ stopReason: 'error', errorMessage: '401 invalid x-api-key' }) });
  process.exit(0);
}
const message = assistant({ content: [{ type: 'text', text: 'Done.' }] });
emit({ type: 'message_update', message });
emit({ type: 'message_end', message });
emit({ type: 'agent_end', messages: [message] });
`;
    writeFileSync(join(binDir, 'pi'), fakePi);
    chmodSync(join(binDir, 'pi'), 0o755);
    process.env.PATH = `${binDir}${delimiter}${originalPath}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  function input(prompt: string) {
    return { prompt, model: 'anthropic/claude-sonnet-4.5', cwd: workDir, resultPath: join(workDir, 'result.json') };
  }

  it('runs pi in the workspace with the prompt on stdin and captures a filtered transcript', async () => {
    const result = await runAgent(input('@weird -prompt'));

    const invocation = JSON.parse(readFileSync(join(workDir, 'invocation.json'), 'utf8'));
    expect(invocation.prompt).toBe('@weird -prompt');
    expect(invocation.argv).toEqual(['--mode', 'json', '--no-session', '--provider', 'vercel-ai-gateway', '--model', 'anthropic/claude-sonnet-4.5']);
    expect(invocation.cwd).toContain('fake-pi-cwd-');

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.agentExitCode).toBe(0);
    expect(result.observedModel).toBe('anthropic/claude-sonnet-4.5');
    expect(result.transcript!.split('\n').map((line: string) => JSON.parse(line).type)).toEqual(['session', 'message_end']);
    expect(result.output).toContain('not json');
  });

  it('fails the run on an in-band provider error even though pi exits 0', async () => {
    const result = await runAgent(input('PROVIDER_ERROR'));

    expect(result.ok).toBe(false);
    expect(result.agentExitCode).toBe(0);
    expect(result.error).toBe('401 invalid x-api-key');
    expect(result.transcript).toContain('401 invalid x-api-key');
  });

  it('fails the run with stderr when pi exits non-zero', async () => {
    const result = await runAgent(input('EXIT_NONZERO'));

    expect(result.ok).toBe(false);
    expect(result.agentExitCode).toBe(1);
    expect(result.error).toBe('Error: Unknown provider "nope".');
    expect(result.transcript).toBeNull();
  });

  it('reports a missing pi binary as a failed run instead of throwing', async () => {
    process.env.PATH = '';
    try {
      const result = await runAgent(input('x'));
      expect(result.ok).toBe(false);
      expect(result.agentExitCode).toBe(-1);
      expect(result.error).toContain('Failed to run pi');
    } finally {
      process.env.PATH = `${binDir}${delimiter}${originalPath}`;
    }
  });
});
