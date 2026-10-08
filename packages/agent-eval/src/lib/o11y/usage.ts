/**
 * Shared helpers for reading token usage out of agent transcripts.
 *
 * Each parser owns the knowledge of where its CLI reports usage; these helpers
 * only keep the arithmetic consistent: counts must be finite and non-negative,
 * a sum is reported only when every part of it was reported, and a usage object
 * with nothing in it is undefined rather than a row of zeros.
 */

import type { TokenUsage } from './types.js';

/** The usage fields that hold token counts (everything except cost). */
export const TOKEN_COUNT_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'totalTokens',
] as const satisfies readonly (keyof TokenUsage)[];

/** A reported count: a finite, non-negative number. Anything else is unreported. */
export function reportedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Sum values that must all be reported. One missing value makes the sum
 * undefined, because a partial sum would understate the real figure.
 */
export function sumReported(values: readonly (number | undefined)[]): number | undefined {
  if (values.length === 0) return undefined;
  let total = 0;
  for (const value of values) {
    if (value === undefined) return undefined;
    total += value;
  }
  return total;
}

/** Sum each field of several usage records with {@link sumReported} semantics. */
export function sumUsage(records: readonly TokenUsage[]): TokenUsage | undefined {
  if (records.length === 0) return undefined;
  const summed: TokenUsage = {};
  for (const field of [...TOKEN_COUNT_FIELDS, 'costUsd'] as const) {
    summed[field] = sumReported(records.map((record) => record[field]));
  }
  return compactUsage(summed);
}

/** Drop unreported fields. Returns undefined when no field was reported. */
export function compactUsage(usage: TokenUsage): TokenUsage | undefined {
  const compacted: TokenUsage = {};
  for (const [field, value] of Object.entries(usage) as [keyof TokenUsage, number | undefined][]) {
    if (value !== undefined) compacted[field] = value;
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

/** Parse one JSONL line into an object, or undefined for anything else. */
export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return asRecord(value);
  } catch {
    return undefined;
  }
}

/** Narrow an unknown value to a plain object. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
