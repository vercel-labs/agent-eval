import { describe, expect, it } from 'vitest';
import { encodedForms, REDACTED, redactRunResult, redactSecrets, redactSecretsBuffer, redactValue } from './redact.js';
import type { AgentRunResult } from './types.js';

// Shaped like the real leak: an OIDC token the framework wrote into opencode.json
// at provider.vercel.options.apiKey, which the agent then read.
const TOKEN = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL29pZGMudmVyY2VsLmNvbSJ9.c2lnbmF0dXJlLWJ5dGVz';

const REDACTED_BUF = Buffer.from(REDACTED, 'utf-8');

/** Leading bytes of a PNG; 0x89 is not valid UTF-8. */
const PNG_PREFIX = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

describe('redactValue', () => {
  it('redacts strings and Buffers at any depth without mutating the input', () => {
    const hook = () => 'kept';
    const startedAt = new Date('2026-10-08T00:00:00Z');
    const input = {
      result: { status: 'passed', metadata: { header: `Bearer ${TOKEN}`, tags: ['ok', TOKEN] } },
      files: { 'config.json': Buffer.from(`{"apiKey":"${TOKEN}"}`) },
      count: 3,
      hook,
      startedAt,
    };

    const output = redactValue(input, [TOKEN]);

    expect(output.result.metadata).toEqual({ header: `Bearer ${REDACTED}`, tags: ['ok', REDACTED] });
    expect(output.files['config.json'].toString('utf-8')).toBe(`{"apiKey":"${REDACTED}"}`);
    expect(output.count).toBe(3);
    expect(output.hook).toBe(hook);
    expect(output.startedAt).toBe(startedAt);
    // The caller's object still holds the original values.
    expect(input.result.metadata.header).toBe(`Bearer ${TOKEN}`);
    expect(input.files['config.json'].toString('utf-8')).toContain(TOKEN);
  });

  it('returns the value untouched when there is no usable secret', () => {
    const input = { text: 'short' };

    expect(redactValue(input, ['', undefined, 'short'])).toBe(input);
  });

  it('copies a shared object once instead of looping on a cycle', () => {
    const shared: Record<string, unknown> = { token: TOKEN };
    shared.self = shared;

    const output = redactValue({ a: shared, b: shared }, [TOKEN]);

    expect(output.a).toBe(output.b);
    expect((output.a as Record<string, unknown>).token).toBe(REDACTED);
    expect((output.a as Record<string, unknown>).self).toBe(output.a);
  });
});

describe('redaction of JSON-escaped credentials', () => {
  // Credentials an agent is handed can contain anything. These are the
  // characters JSON escapes.
  const MULTILINE = 'line-one-of-a-key\nline-two-of-a-key';
  const QUOTED = 'pass"word"with-quotes-0123';
  const BACKSLASHED = 'C:\\Users\\deploy\\token-0123456789';
  const ALL_THREE = 'mixed "quote"\\back\nnewline\ttab-0123';

  /** Every string value inside a JSON document, decoded. */
  const decodedStrings = (json: string): string[] => {
    const out: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') out.push(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(JSON.parse(json));
    return out;
  };

  it.each([
    ['a multiline', MULTILINE],
    ['a quoted', QUOTED],
    ['a backslash-containing', BACKSLASHED],
    ['a mixed', ALL_THREE],
  ])('redacts %s secret printed into a JSONL transcript', (_case, secret) => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `export TOKEN=${secret}` }] } });
    // The escaped form really is what JSON produced, so a literal match misses it.
    expect(line).not.toContain(secret);

    const redacted = redactSecrets(line, [secret]);

    expect(decodedStrings(redacted)).toContain(`export TOKEN=${REDACTED}`);
    expect(decodedStrings(redacted).join('\n')).not.toContain(secret);
  });

  it('redacts a secret escaped twice, as in JSON tool output recorded in a JSONL transcript', () => {
    const toolOutput = JSON.stringify({ env: { DEPLOY_TOKEN: ALL_THREE } });
    const line = JSON.stringify({ type: 'tool_result', content: toolOutput });

    const redacted = redactSecrets(line, [ALL_THREE]);

    const inner = JSON.parse(JSON.parse(redacted).content);
    expect(inner.env.DEPLOY_TOKEN).toBe(REDACTED);
  });

  it('redacts the ASCII-only escapes Python writes by default', () => {
    const secret = 'pässwörd-ÿ-0123456789';
    // json.dumps({"token": secret}) with ensure_ascii=True
    const pythonJson = '{"token": "p\\u00e4ssw\\u00f6rd-\\u00ff-0123456789"}';

    expect(JSON.parse(redactSecrets(pythonJson, [secret])).token).toBe(REDACTED);
  });

  it('redacts the HTML-safe escapes Go writes by default', () => {
    const secret = 'tok<en>&value-0123456789';
    // json.Marshal(map[string]string{"token": secret})
    const goJson = '{"token":"tok\\u003cen\\u003e\\u0026value-0123456789"}';

    expect(JSON.parse(redactSecrets(goJson, [secret])).token).toBe(REDACTED);
  });

  it('redacts escaped forms inside generated files without touching other bytes', () => {
    const file = Buffer.concat([PNG_PREFIX, Buffer.from(JSON.stringify({ token: QUOTED }), 'utf-8')]);

    const redacted = redactSecretsBuffer(file, [QUOTED]);

    expect(redacted.subarray(0, PNG_PREFIX.length).equals(PNG_PREFIX)).toBe(true);
    expect(JSON.parse(redacted.subarray(PNG_PREFIX.length).toString('utf-8')).token).toBe(REDACTED);
  });

  it('redacts escaped forms in run results and reporter-style payloads', () => {
    const transcript = JSON.stringify({ text: MULTILINE });
    const result = redactRunResult({ success: true, output: `raw ${MULTILINE}`, transcript, duration: 1 }, [MULTILINE]);
    const payload = redactValue({ metadata: { note: transcript } }, [MULTILINE]);

    expect(result.output).toBe(`raw ${REDACTED}`);
    expect(JSON.parse(result.transcript!).text).toBe(REDACTED);
    expect(JSON.parse(payload.metadata.note).text).toBe(REDACTED);
  });

  it('gives a secret with nothing to escape exactly one form', () => {
    expect(encodedForms('sk_live_0123456789abcdef')).toEqual(['sk_live_0123456789abcdef']);
  });
});
