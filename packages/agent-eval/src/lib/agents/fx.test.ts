import { describe, expect, it } from 'vitest';

import {
  buildFxEnvironment,
  buildFxCliArgs,
  isFxSessionDetail,
  parseFxAskResult,
} from './fx/run.mjs';
import {
  buildFxInstallScript,
  createFxDefinition,
  FX_RELEASE_SHA256,
  FX_VERSION,
} from './fx/agent.js';

describe('fx definition', () => {
  const definition = createFxDefinition();
  const options = { prompt: 'p', apiKey: 'test-key', timeout: 1000, webResearch: true };

  it('registers a Gateway-only research agent with no bundled skills', () => {
    expect(definition.name).toBe('vercel-ai-gateway/fx');
    expect(definition.defaultModel).toBe('zai/glm-5.2');
    expect(definition.bundledSkillsControl).toBe('not-applicable');
    expect(definition.requiresWebResearch).toBe(true);
    expect(definition.supportsCrossAgentJudge).toBe(false);
    expect(definition.getApiKeyEnvVar()).toBe('AI_GATEWAY_API_KEY');
    expect(definition.authEnv(options)).toEqual({ AI_GATEWAY_API_KEY: 'test-key' });
  });

  it('pins the binary release and runtime protocol in the fingerprint', () => {
    expect(definition.fingerprintExtra!({} as never)).toEqual({
      fxVersion: FX_VERSION,
      fxRuntimeProtocol: 'ask-json-session-v1',
    });
  });

  it('installs a checksum-verified binary for both Linux architectures', () => {
    const script = buildFxInstallScript();
    expect(script).toContain(`const version = "${FX_VERSION}"`);
    expect(script).toContain(FX_RELEASE_SHA256.x64);
    expect(script).toContain(FX_RELEASE_SHA256.arm64);
    expect(script).toContain('createHash');
    expect(script).toContain('for await (const chunk of response.body)');
    expect(script).not.toContain('response.arrayBuffer()');
    expect(script).toContain("spawnSync('tar'");

    const install = definition.install(options);
    expect(install).toHaveLength(2);
    expect(install[1]).toMatchObject({
      kind: 'command',
      cmd: 'node',
      errorPrefix: 'fx install failed',
    });
  });
});

describe('fx runner helpers', () => {
  it('builds a noninteractive research invocation', () => {
    expect(buildFxCliArgs({ prompt: 'research this' })).toEqual([
      'ask',
      '--yolo',
      '--json',
      '--no-color',
      '--',
      'research this',
    ]);
  });

  it('sets explicit models without contaminating native-default runs', () => {
    const explicit = buildFxEnvironment({ model: 'openai/gpt-5.6-sol' });
    expect(explicit.FX_MODEL).toBe('openai/gpt-5.6-sol');
    expect(explicit.FX_AUTO_UPGRADE).toBe('0');

    const native = buildFxEnvironment({});
    expect(native.FX_MODEL).toBeUndefined();
    expect(native.FX_AUTO_UPGRADE).toBe('0');
  });

  it('parses the stable ask result and rejects malformed output', () => {
    const result = parseFxAskResult(JSON.stringify({
      output: 'done',
      exit_code: 0,
      model: 'openai/gpt-5.6-sol',
      session_id: 'session-1',
      steps: 1,
      tool_calls: [],
    }));
    expect(result?.output).toBe('done');
    expect(parseFxAskResult('not json')).toBeNull();
    expect(parseFxAskResult('{}')).toBeNull();
  });

  it('recognizes only the supported session detail projection', () => {
    expect(isFxSessionDetail(JSON.stringify({ kind: 'session_detail', history: [] }))).toBe(true);
    expect(isFxSessionDetail(JSON.stringify({ kind: 'session_summary', history: [] }))).toBe(false);
  });
});
