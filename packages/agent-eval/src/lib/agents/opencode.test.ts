import { describe, expect, it } from 'vitest';
// Pure transcript/observed-model helpers live in the in-sandbox runner (so the
// tested logic is exactly what the sandbox runs); the pure config generator lives
// in the host-side definition.
import {
  buildOpenCodeCliArgs,
  extractObservedModelFromOpenCodeOutput,
  extractObservedModelFromSessionExport,
  extractSessionIdFromTranscript,
  normalizeObservedModel,
} from './opencode/run.mjs';
import { createOpenCodeDefinition, generateOpenCodeConfig, resolveOpenCodeModel } from './opencode/agent.js';

describe('generateOpenCodeConfig', () => {
  it('grants only the default tool permissions when webResearch is off', () => {
    const config = JSON.parse(generateOpenCodeConfig(undefined, 'test-key'));
    expect(config.permission).toEqual({ write: 'allow', edit: 'allow', bash: 'allow' });
  });

  it('allows websearch and webfetch when webResearch is set', () => {
    const config = JSON.parse(generateOpenCodeConfig(undefined, 'test-key', undefined, true));
    expect(config.permission).toEqual({
      write: 'allow',
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
      websearch: 'allow',
    });
  });

  it('keeps provider configuration unchanged when webResearch is set', () => {
    const withResearch = JSON.parse(generateOpenCodeConfig(undefined, 'test-key', undefined, true));
    const without = JSON.parse(generateOpenCodeConfig(undefined, 'test-key'));
    expect(withResearch.provider).toEqual(without.provider);
  });
});

describe('resolveOpenCodeModel', () => {
  it('prefixes canonical gateway ids with the vercel provider', () => {
    expect(resolveOpenCodeModel('anthropic/claude-sonnet-5')).toBe('vercel/anthropic/claude-sonnet-5');
    expect(resolveOpenCodeModel('openai/gpt-5.5')).toBe('vercel/openai/gpt-5.5');
  });

  it('keeps already-prefixed ids verbatim', () => {
    expect(resolveOpenCodeModel('vercel/anthropic/claude-sonnet-5')).toBe('vercel/anthropic/claude-sonnet-5');
  });

  it('keeps ids targeting an extra provider verbatim', () => {
    const extraProviders = { 'anthropic-preview': { npm: '@ai-sdk/anthropic' } };
    expect(resolveOpenCodeModel('anthropic-preview/claude-x', extraProviders)).toBe('anthropic-preview/claude-x');
    // A gateway id still gets prefixed when extra providers are configured.
    expect(resolveOpenCodeModel('anthropic/claude-sonnet-5', extraProviders)).toBe('vercel/anthropic/claude-sonnet-5');
  });

  it('prefixes bare ids so the gateway rejects them with a model error, not a provider error', () => {
    expect(resolveOpenCodeModel('claude-sonnet-5')).toBe('vercel/claude-sonnet-5');
  });
});

describe('OpenCode definition runnerExtra', () => {
  const definition = createOpenCodeDefinition();

  const baseOptions = { prompt: 'p', apiKey: 'k', timeout: 1000 };

  it('resolves the model override against extraProviders from agentOptions', () => {
    const extra = definition.runnerExtra!({
      ...baseOptions,
      model: 'anthropic/claude-sonnet-5',
    });
    expect(extra).toEqual({ cliModel: 'vercel/anthropic/claude-sonnet-5' });

    const withProvider = definition.runnerExtra!({
      ...baseOptions,
      model: 'anthropic-preview/claude-x',
      agentOptions: { extraProviders: { 'anthropic-preview': {} } },
    });
    expect(withProvider).toEqual({ cliModel: 'anthropic-preview/claude-x' });
  });

  it('is null on native-default runs (no model override)', () => {
    expect(definition.runnerExtra!(baseOptions)).toEqual({ cliModel: null });
  });
});

describe('buildOpenCodeCliArgs', () => {
  it('passes the host-resolved model from extra.cliModel', () => {
    const args = buildOpenCodeCliArgs({
      prompt: 'do the thing',
      model: 'anthropic/claude-sonnet-5',
      extra: { cliModel: 'vercel/anthropic/claude-sonnet-5' },
    });
    expect(args).toEqual(['run', 'do the thing', '--format', 'json', '--model', 'vercel/anthropic/claude-sonnet-5']);
  });

  it('never passes input.model verbatim — extra.cliModel is the only model source', () => {
    // Verbatim pass-through is the mis-route this fixes (opencode would read
    // `anthropic` as its provider id). Without extra there is no --model at all.
    const args = buildOpenCodeCliArgs({ prompt: 'p', model: 'anthropic/claude-sonnet-5' });
    expect(args).toEqual(['run', 'p', '--format', 'json']);
  });

  it('enables log printing instead of --model on native-default runs', () => {
    const args = buildOpenCodeCliArgs({ prompt: 'p', modelPolicy: 'native-default', extra: { cliModel: null } });
    expect(args).toEqual(['run', 'p', '--format', 'json', '--print-logs', '--log-level', 'INFO']);
  });
});

describe('normalizeObservedModel', () => {
  it('un-applies the host vercel/ prefix so observed matches the requested gateway id', () => {
    const input = { model: 'anthropic/claude-sonnet-5', extra: { cliModel: 'vercel/anthropic/claude-sonnet-5' } };
    expect(normalizeObservedModel('vercel/anthropic/claude-sonnet-5', input)).toBe('anthropic/claude-sonnet-5');
    // A gateway substitution still surfaces as a clean gateway id.
    expect(normalizeObservedModel('vercel/anthropic/claude-haiku-4', input)).toBe('anthropic/claude-haiku-4');
  });

  it('passes observations through when the caller already spoke the OpenCode namespace', () => {
    const input = { model: 'vercel/openai/gpt-5.5', extra: { cliModel: 'vercel/openai/gpt-5.5' } };
    expect(normalizeObservedModel('vercel/openai/gpt-5.5', input)).toBe('vercel/openai/gpt-5.5');
  });

  it('passes native-default observations through untouched', () => {
    const input = { modelPolicy: 'native-default', extra: { cliModel: null } };
    expect(normalizeObservedModel('vercel/google/gemini-3-pro-preview', input)).toBe('vercel/google/gemini-3-pro-preview');
    expect(normalizeObservedModel(undefined, input)).toBeUndefined();
  });
});

describe('OpenCode observed model extraction', () => {
  it('extracts the primary build model from printed logs', () => {
    const output = [
      'INFO service=llm providerID=vercel modelID=anthropic/claude-haiku-4.5 small=true agent=title mode=primary stream',
      'INFO service=llm providerID=vercel modelID=openai/gpt-5.5 small=false agent=build mode=primary stream',
    ].join('\n');

    expect(extractObservedModelFromOpenCodeOutput(output)).toBe('vercel/openai/gpt-5.5');
  });

  it('returns undefined when no matching log lines exist (OpenCode >= 1.17.0 format)', () => {
    const output = [
      'timestamp=2026-06-10T05:40:00.000Z level=INFO run=abc123 message=resolved provider=vercel model=openai/gpt-5.5',
      '{"type":"text","timestamp":1781000000000,"sessionID":"ses_123","part":{"type":"text","text":"hi"}}',
    ].join('\n');

    expect(extractObservedModelFromOpenCodeOutput(output)).toBeUndefined();
  });
});

describe('OpenCode session id extraction', () => {
  it('extracts the session id from JSON transcript events', () => {
    const transcript = [
      '{"type":"step_start","timestamp":1781000000000,"sessionID":"ses_abc123","part":{"type":"step-start"}}',
      '{"type":"text","timestamp":1781000001000,"sessionID":"ses_abc123","part":{"type":"text","text":"done"}}',
    ].join('\n');

    expect(extractSessionIdFromTranscript(transcript)).toBe('ses_abc123');
  });

  it('skips malformed lines and returns undefined when no session id is present', () => {
    expect(extractSessionIdFromTranscript('not json\n{"type":"text"}')).toBeUndefined();
    expect(extractSessionIdFromTranscript(undefined)).toBeUndefined();
    expect(extractSessionIdFromTranscript('')).toBeUndefined();
  });
});

describe('OpenCode session export model extraction', () => {
  it('extracts providerID/modelID from the first assistant message', () => {
    const exportOutput = JSON.stringify({
      info: { id: 'ses_abc123', title: 'Test session' },
      messages: [
        { info: { id: 'msg_1', role: 'user' }, parts: [] },
        {
          info: {
            id: 'msg_2',
            role: 'assistant',
            providerID: 'vercel',
            modelID: 'google/gemini-3-pro-preview',
          },
          parts: [],
        },
      ],
    });

    expect(extractObservedModelFromSessionExport(exportOutput)).toBe(
      'vercel/google/gemini-3-pro-preview'
    );
  });

  it('tolerates non-JSON prefix lines before the JSON document', () => {
    const exportOutput = [
      'Exporting session: ses_abc123',
      JSON.stringify({
        messages: [
          { info: { role: 'assistant', providerID: 'vercel', modelID: 'openai/gpt-5.5' }, parts: [] },
        ],
      }),
    ].join('\n');

    expect(extractObservedModelFromSessionExport(exportOutput)).toBe('vercel/openai/gpt-5.5');
  });

  it('returns undefined for malformed or incomplete exports', () => {
    expect(extractObservedModelFromSessionExport('')).toBeUndefined();
    expect(extractObservedModelFromSessionExport('not json')).toBeUndefined();
    expect(extractObservedModelFromSessionExport('{"messages":"nope"}')).toBeUndefined();
    expect(
      extractObservedModelFromSessionExport(
        JSON.stringify({ messages: [{ info: { role: 'assistant', providerID: 'vercel' } }] })
      )
    ).toBeUndefined();
    expect(
      extractObservedModelFromSessionExport(JSON.stringify({ messages: [{ info: { role: 'user' } }] }))
    ).toBeUndefined();
  });
});
