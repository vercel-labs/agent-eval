import { describe, expect, it } from 'vitest';
import { REDACTED, redactRunResult, redactSecrets, redactSecretsBuffer } from './redact.js';
import type { AgentRunResult } from './types.js';

// Shaped like the real leak: an OIDC token the framework wrote into opencode.json
// at provider.vercel.options.apiKey, which the agent then read.
const TOKEN = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL29pZGMudmVyY2VsLmNvbSJ9.c2lnbmF0dXJlLWJ5dGVz';

const REDACTED_BUF = Buffer.from(REDACTED, 'utf-8');

describe('redactSecrets', () => {
  it('replaces every occurrence of the secret', () => {
    const text = `apiKey: ${TOKEN}, again: ${TOKEN}`;

    expect(redactSecrets(text, [TOKEN])).toBe(`apiKey: ${REDACTED}, again: ${REDACTED}`);
  });

  it('leaves text alone when the secret is absent', () => {
    expect(redactSecrets('nothing to see', [TOKEN])).toBe('nothing to see');
  });

  it('treats the secret as literal text, not a pattern', () => {
    // A regex-based implementation would read `.` and `+` as metacharacters and
    // either over-match or throw.
    const secret = 'a.b+c[d]e(f)g*h$i^j{k}l|m'.repeat(2);

    expect(redactSecrets(`x ${secret} y`, [secret])).toBe(`x ${REDACTED} y`);
    expect(redactSecrets('x aXbXc y', [secret])).toBe('x aXbXc y');
  });

  it('ignores empty and short secrets rather than shredding the text', () => {
    // An unset apiKey is '', and replacing '' would corrupt every position.
    expect(redactSecrets('keep me intact', ['', undefined, 'short'])).toBe('keep me intact');
  });

  it('redacts a secret that contains another secret whole', () => {
    const inner = 'inner-secret-value-0123';
    const outer = `${inner}-plus-more-suffix`;

    // Longest-first ordering: the outer must not be left as `[REDACTED]-plus-more-suffix`.
    expect(redactSecrets(`v=${outer}`, [inner, outer])).toBe(`v=${REDACTED}`);
  });
});

describe('redactSecretsBuffer', () => {
  // 0x00 and 0xff are not valid UTF-8 on their own. Decoding to a string and
  // re-encoding turns each into U+FFFD (ef bf bd), which is the corruption that
  // byte-fidelity collection exists to prevent.
  const BINARY_PREFIX = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80]);
  const BINARY_SUFFIX = Buffer.from([0xc3, 0x28, 0x00, 0x01, 0xff]);

  it('redacts a secret embedded in binary content and preserves every other byte', () => {
    const input = Buffer.concat([BINARY_PREFIX, Buffer.from(TOKEN, 'utf-8'), BINARY_SUFFIX]);

    const out = redactSecretsBuffer(input, [TOKEN]);

    expect(out).toEqual(Buffer.concat([BINARY_PREFIX, REDACTED_BUF, BINARY_SUFFIX]));
    expect(out.subarray(0, BINARY_PREFIX.length)).toEqual(BINARY_PREFIX);
    expect(out.subarray(out.length - BINARY_SUFFIX.length)).toEqual(BINARY_SUFFIX);
    expect(out.includes(Buffer.from(TOKEN, 'utf-8'))).toBe(false);
  });

  it('does not decode the bytes it passes through', () => {
    // Guard against "simplifying" this back to
    // Buffer.from(redactSecrets(content.toString('utf-8'), secrets)). That
    // variant returns these bytes mangled into U+FFFD, so this asserts the
    // difference rather than trusting the implementation.
    const input = Buffer.concat([BINARY_PREFIX, Buffer.from(TOKEN, 'utf-8')]);
    const viaString = Buffer.from(redactSecrets(input.toString('utf-8'), [TOKEN]), 'utf-8');

    expect(redactSecretsBuffer(input, [TOKEN]).subarray(0, BINARY_PREFIX.length)).toEqual(
      BINARY_PREFIX
    );
    expect(viaString.subarray(0, BINARY_PREFIX.length)).not.toEqual(BINARY_PREFIX);
  });

  it('redacts every occurrence', () => {
    const needle = Buffer.from(TOKEN, 'utf-8');
    const input = Buffer.concat([needle, BINARY_PREFIX, needle, Buffer.from([0x00]), needle]);

    const out = redactSecretsBuffer(input, [TOKEN]);

    expect(out).toEqual(
      Buffer.concat([
        REDACTED_BUF,
        BINARY_PREFIX,
        REDACTED_BUF,
        Buffer.from([0x00]),
        REDACTED_BUF,
      ])
    );
  });

  it('returns the content untouched when the secret is absent or too short', () => {
    const input = Buffer.concat([BINARY_PREFIX, BINARY_SUFFIX]);

    expect(redactSecretsBuffer(input, [TOKEN])).toEqual(input);
    expect(redactSecretsBuffer(input, ['', undefined, 'short'])).toEqual(input);
  });

  it('redacts a secret that contains another secret whole', () => {
    const inner = 'inner-secret-value-0123';
    const outer = `${inner}-plus-more-suffix`;
    const input = Buffer.from(`v=${outer}`, 'utf-8');

    expect(redactSecretsBuffer(input, [inner, outer])).toEqual(
      Buffer.from(`v=${REDACTED}`, 'utf-8')
    );
  });
});

describe('redactRunResult', () => {
  const base: AgentRunResult = {
    success: true,
    output: `wrote apiKey ${TOKEN}`,
    transcript: `{"tool":"read","output":"apiKey: ${TOKEN}"}`,
    error: `auth failed for ${TOKEN}`,
    duration: 1234,
    testResult: { success: true, output: `env had ${TOKEN}` },
    scriptsResults: { build: { success: true, output: `build saw ${TOKEN}` } },
    generatedFiles: { 'copy.json': Buffer.from(`{"apiKey":"${TOKEN}"}`, 'utf-8') },
    deletedFiles: ['old.ts'],
    sandboxId: 'sbx_123',
    observedModel: 'vercel/xai/grok-4.6',
  };

  it('redacts every text-bearing field', () => {
    const result = redactRunResult(base, [TOKEN]);

    expect(result.output).toBe(`wrote apiKey ${REDACTED}`);
    expect(result.transcript).toBe(`{"tool":"read","output":"apiKey: ${REDACTED}"}`);
    expect(result.error).toBe(`auth failed for ${REDACTED}`);
    expect(result.testResult?.output).toBe(`env had ${REDACTED}`);
    expect(result.scriptsResults?.build.output).toBe(`build saw ${REDACTED}`);
    expect(result.generatedFiles?.['copy.json']?.toString('utf-8')).toBe(
      `{"apiKey":"${REDACTED}"}`
    );
  });

  it('leaves the whole result free of the secret', () => {
    expect(JSON.stringify(redactRunResult(base, [TOKEN]))).not.toContain(TOKEN);
  });

  it('passes non-text fields through untouched', () => {
    const result = redactRunResult(base, [TOKEN]);

    expect(result.success).toBe(true);
    expect(result.duration).toBe(1234);
    expect(result.sandboxId).toBe('sbx_123');
    expect(result.observedModel).toBe('vercel/xai/grok-4.6');
    expect(result.deletedFiles).toEqual(['old.ts']);
    expect(result.testResult?.success).toBe(true);
  });

  it('does not mutate the input', () => {
    const input = structuredClone(base);
    // structuredClone downgrades Buffer to a bare Uint8Array, which toEqual then
    // reports as a difference. Restore the prototype so the assertion is about
    // mutation, which is what this test is for.
    input.generatedFiles = { 'copy.json': Buffer.from(base.generatedFiles!['copy.json']) };
    redactRunResult(input, [TOKEN]);

    expect(input).toEqual(base);
  });

  it('preserves optional fields as absent rather than undefined', () => {
    const minimal: AgentRunResult = { success: false, output: TOKEN, duration: 0 };
    const result = redactRunResult(minimal, [TOKEN]);

    expect(result.output).toBe(REDACTED);
    expect('transcript' in result).toBe(false);
    expect('error' in result).toBe(false);
    expect('testResult' in result).toBe(false);
  });

  it('returns the result as-is when there is no usable secret', () => {
    const result = redactRunResult(base, ['', undefined]);

    expect(result).toBe(base);
  });

  it('redacts the judge key as well as the codegen key', () => {
    const judgeToken = 'judge-token-value-abcdefghij';
    const withBoth: AgentRunResult = {
      success: true,
      output: `codegen ${TOKEN} judge ${judgeToken}`,
      duration: 0,
    };

    expect(redactRunResult(withBoth, [TOKEN, judgeToken]).output).toBe(
      `codegen ${REDACTED} judge ${REDACTED}`
    );
  });
});
