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

/** Usable secrets, deduped and ordered longest-first so overlaps redact whole. */
function usableSecrets(secrets: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const s of secrets) {
    if (s && s.length >= MIN_SECRET_LENGTH) seen.add(s);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

/** Replace every occurrence of each secret with {@link REDACTED}. */
export function redactSecrets(
  text: string,
  secrets: readonly (string | undefined)[]
): string {
  let out = text;
  for (const secret of usableSecrets(secrets)) {
    // split/join rather than RegExp: the secret is arbitrary text and must not be
    // interpreted as a pattern.
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

const REDACTED_BYTES = Buffer.from(REDACTED, 'utf-8');

/**
 * Buffer-level equivalent of {@link redactSecrets}.
 *
 * `generatedFiles` holds raw bytes so that binary assets survive collection
 * intact. Redaction therefore cannot route through a string: decoding to UTF-8
 * and re-encoding replaces every non-UTF-8 byte with U+FFFD, which would corrupt
 * exactly the files byte-fidelity exists to protect. Passing a Buffer to
 * {@link redactSecrets} is worse still — Buffer has no `split`, so it throws.
 *
 * Credentials are ASCII, so their UTF-8 byte sequence is located and spliced out
 * directly and every other byte is copied through untouched.
 */
export function redactSecretsBuffer(
  content: Buffer,
  secrets: readonly (string | undefined)[]
): Buffer {
  let out = content;

  for (const secret of usableSecrets(secrets)) {
    const needle = Buffer.from(secret, 'utf-8');
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

function redactScriptResult(
  result: ScriptResult,
  secrets: readonly (string | undefined)[]
): ScriptResult {
  return { ...result, output: redactSecrets(result.output, secrets) };
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
  if (usableSecrets(secrets).length === 0) return result;

  const redacted: AgentRunResult = {
    ...result,
    output: redactSecrets(result.output, secrets),
  };

  if (result.transcript !== undefined) {
    redacted.transcript = redactSecrets(result.transcript, secrets);
  }
  if (result.error !== undefined) {
    redacted.error = redactSecrets(result.error, secrets);
  }
  if (result.testResult) {
    redacted.testResult = redactScriptResult(result.testResult, secrets);
  }
  if (result.scriptsResults) {
    redacted.scriptsResults = Object.fromEntries(
      Object.entries(result.scriptsResults).map(([name, script]) => [
        name,
        redactScriptResult(script, secrets),
      ])
    );
  }
  if (result.generatedFiles) {
    redacted.generatedFiles = Object.fromEntries(
      Object.entries(result.generatedFiles).map(([path, content]) => [
        path,
        redactSecretsBuffer(content, secrets),
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
  const usable = usableSecrets(secrets);
  if (usable.length === 0) return value;

  const copies = new Map<object, unknown>();
  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') return redactSecrets(current, usable);
    if (Buffer.isBuffer(current)) return redactSecretsBuffer(current, usable);
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
