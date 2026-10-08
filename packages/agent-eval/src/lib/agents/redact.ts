/**
 * Redaction of run credentials from everything a run hands back to the host.
 *
 * Why this is needed: several agents are configured through a file we write into
 * the sandbox with the live credential in it (opencode's `opencode.json` carries
 * it at `provider.vercel.options.apiKey`; codex's TOML is the same shape). Those
 * files sit in the agent's cwd, so models read them as a matter of course while
 * orienting, and the read lands in the transcript. Consumers commit transcripts,
 * so without this the credential ends up in their repo — which is how it was
 * found: a public repo tripped secret scanning on a transcript.
 *
 * This runs at the host boundary, on the way out of a run, NOT before the judge
 * sees the transcript. That is deliberate. The judge runs inside the sandbox,
 * where the credential is present anyway, and rewriting the transcript before it
 * is judged would change what the judge reads and therefore the score. Redacting
 * on the way out keeps in-sandbox behavior byte-identical and only affects what
 * the host persists.
 *
 * Matching is exact-string, not pattern-based. The framework knows the precise
 * value it injected, so there is nothing to infer and no false positives — a
 * pattern would have to guess, and credential-shaped substrings do occur in
 * transcripts (the agents' own `ses_…` session IDs contain base64url runs that a
 * JWT prefix match flags). The tradeoff is that a credential the framework never
 * saw is not covered: if a run refreshes its own token mid-flight, only the value
 * we started with is redacted.
 *
 * "Exact" includes the forms a JSON encoder gives the value. Transcripts are
 * JSON: a credential containing a quote, a backslash, a newline, or non-ASCII
 * text appears escaped there (`a\"b`, `line1\nline2`, `\u00e9`), and a literal
 * match on the raw value would miss it while anyone could decode it back. See
 * {@link encodedForms}.
 */
import type { AgentRunResult, ScriptResult } from './types.js';

export const REDACTED = '[REDACTED]';

/**
 * Below this length a "secret" is not treated as one. A short or empty value
 * would match incidental text everywhere and shred the transcript, which is a
 * worse failure than not redacting — an unset apiKey is '' and would otherwise
 * replace every empty string in the output.
 */
const MIN_SECRET_LENGTH = 16;

/** Escape one UTF-16 code unit as `\uXXXX`. */
function unicodeEscape(code: number, upper: boolean): string {
  const hex = code.toString(16).padStart(4, '0');
  return `\\u${upper ? hex.toUpperCase() : hex}`;
}

const SHORT_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

/**
 * JSON string escaping with configurable `\uXXXX` coverage: control
 * characters always, plus whatever `escapeAlso` selects.
 */
function escapeJson(text: string, escapeAlso: (code: number) => boolean, upper: boolean): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const code = text.charCodeAt(i);
    if (SHORT_ESCAPES[char]) out += SHORT_ESCAPES[char];
    else if (code < 0x20 || escapeAlso(code)) out += unicodeEscape(code, upper);
    else out += char;
  }
  return out;
}

/**
 * The text a secret can turn into inside JSON output: as written, escaped once
 * by the encoders the agent CLIs and common tools use, and escaped twice (JSON
 * inside a JSON string, such as a tool's JSON output recorded in a JSONL
 * transcript).
 *
 * Encoders agree on quotes, backslashes, and control characters but differ on
 * the rest, so each style is covered: plain (JavaScript, Rust), ASCII-only with
 * `\u` escapes for every non-ASCII character (Python's default), HTML-safe
 * `<`, `>`, `&`, U+2028, and U+2029 (Go's default), and escaped slashes. Hex
 * digits appear in both cases. A secret made only of characters no encoder
 * escapes has a single form: itself.
 */
export function encodedForms(secret: string): string[] {
  const htmlUnsafe = (code: number) => code === 0x3c || code === 0x3e || code === 0x26 || code === 0x2028 || code === 0x2029;
  const nonAscii = (code: number) => code > 0x7f;
  const plain = JSON.stringify(secret).slice(1, -1);
  const once = new Set<string>([plain, plain.replace(/\//g, '\\/')]);
  for (const upper of [false, true]) {
    once.add(escapeJson(secret, nonAscii, upper));
    once.add(escapeJson(secret, htmlUnsafe, upper));
  }
  const forms = new Set<string>([secret, ...once]);
  for (const form of once) forms.add(JSON.stringify(form).slice(1, -1));
  return [...forms];
}

/**
 * Every string to replace for these secrets: each usable secret in all of its
 * encoded forms, deduped and ordered longest-first so overlaps redact whole.
 */
function redactionNeedles(secrets: readonly (string | undefined)[]): string[] {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue;
    for (const form of encodedForms(secret)) needles.add(form);
  }
  return [...needles].sort((a, b) => b.length - a.length);
}

function replaceText(text: string, needles: readonly string[]): string {
  let out = text;
  for (const needle of needles) {
    // split/join rather than RegExp: the secret is arbitrary text and must not be
    // interpreted as a pattern.
    out = out.split(needle).join(REDACTED);
  }
  return out;
}

const REDACTED_BYTES = Buffer.from(REDACTED, 'utf-8');

function replaceBuffer(content: Buffer, needles: readonly string[]): Buffer {
  let out = content;
  for (const text of needles) {
    const needle = Buffer.from(text, 'utf-8');
    let found = out.indexOf(needle);
    if (found === -1) continue;

    const pieces: Buffer[] = [];
    let cursor = 0;
    while (found !== -1) {
      pieces.push(out.subarray(cursor, found), REDACTED_BYTES);
      cursor = found + needle.length;
      found = out.indexOf(needle, cursor);
    }
    pieces.push(out.subarray(cursor));
    out = Buffer.concat(pieces);
  }
  return out;
}

/** Replace every occurrence of each secret, in any of its {@link encodedForms}, with {@link REDACTED}. */
export function redactSecrets(
  text: string,
  secrets: readonly (string | undefined)[]
): string {
  return replaceText(text, redactionNeedles(secrets));
}

/**
 * Buffer-level equivalent of {@link redactSecrets}.
 *
 * `generatedFiles` holds raw bytes so that binary assets survive collection
 * intact. Redaction therefore cannot route through a string: decoding to UTF-8
 * and re-encoding replaces every non-UTF-8 byte with U+FFFD, which would corrupt
 * exactly the files byte-fidelity exists to protect. Passing a Buffer to
 * {@link redactSecrets} is worse still — Buffer has no `split`, so it throws.
 *
 * Each secret form's UTF-8 byte sequence is located and spliced out directly,
 * and every other byte is copied through untouched.
 */
export function redactSecretsBuffer(
  content: Buffer,
  secrets: readonly (string | undefined)[]
): Buffer {
  return replaceBuffer(content, redactionNeedles(secrets));
}

function redactScriptResult(result: ScriptResult, needles: readonly string[]): ScriptResult {
  return { ...result, output: replaceText(result.output, needles) };
}

/**
 * Redact every text-bearing field of a run result. Returns a new object; the
 * input is not mutated.
 *
 * Covers what gets persisted or shown: the agent's stdout/stderr, the transcript,
 * the error message, the test and script outputs, and the contents of generated
 * files (an agent that copies its config into a new file would otherwise smuggle
 * the credential past the transcript check). Non-text fields — durations, ids,
 * model names, deleted-file paths — are passed through untouched.
 */
export function redactRunResult(
  result: AgentRunResult,
  secrets: readonly (string | undefined)[]
): AgentRunResult {
  const needles = redactionNeedles(secrets);
  if (needles.length === 0) return result;

  const redacted: AgentRunResult = {
    ...result,
    output: replaceText(result.output, needles),
  };

  if (result.transcript !== undefined) {
    redacted.transcript = replaceText(result.transcript, needles);
  }
  if (result.error !== undefined) {
    redacted.error = replaceText(result.error, needles);
  }
  if (result.testResult) {
    redacted.testResult = redactScriptResult(result.testResult, needles);
  }
  if (result.scriptsResults) {
    redacted.scriptsResults = Object.fromEntries(
      Object.entries(result.scriptsResults).map(([name, script]) => [
        name,
        redactScriptResult(script, needles),
      ])
    );
  }
  if (result.generatedFiles) {
    redacted.generatedFiles = Object.fromEntries(
      Object.entries(result.generatedFiles).map(([path, content]) => [
        path,
        replaceBuffer(content, needles),
      ])
    );
  }

  return redacted;
}

/**
 * Redact every string (and Buffer) inside an arbitrary value. Used for payloads
 * that leave the run as plain data, such as reporter events, where the value
 * carries user-attached fields (`analysis`, `metadata`) that
 * {@link redactRunResult} never saw.
 *
 * Returns a copy: arrays and plain objects are rebuilt, strings and Buffers are
 * redacted, and everything else (numbers, functions, class instances such as
 * Date) is passed through by reference. The input is not mutated.
 */
export function redactValue<T>(value: T, secrets: readonly (string | undefined)[]): T {
  const needles = redactionNeedles(secrets);
  if (needles.length === 0) return value;

  const copies = new Map<object, unknown>();
  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') return replaceText(current, needles);
    if (Buffer.isBuffer(current)) return replaceBuffer(current, needles);
    if (current === null || typeof current !== 'object') return current;
    if (copies.has(current)) return copies.get(current);

    if (Array.isArray(current)) {
      const copy: unknown[] = [];
      copies.set(current, copy);
      for (const item of current) copy.push(visit(item));
      return copy;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return current;

    const copy: Record<string, unknown> = {};
    copies.set(current, copy);
    for (const [key, item] of Object.entries(current)) copy[key] = visit(item);
    return copy;
  };

  return visit(value) as T;
}
