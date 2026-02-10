/**
 * Failure classification for eval results.
 *
 * Classifies failed eval runs as:
 * - "model" — the model tried but wrote incorrect code
 * - "infra" — infrastructure broke (API errors, rate limits, crashes)
 * - "timeout" — the run hit its time limit
 *
 * Uses AI classification via the Vercel AI Gateway. Requires AI_GATEWAY_API_KEY.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tool } from 'ai';
import { z } from 'zod';
import type { Classification, FailureType } from './types.js';

const CLASSIFIER_SYSTEM_PROMPT = `You are a failure classifier for an AI coding agent benchmark.

Your job: figure out WHY a failed eval run failed. Each eval tests whether an AI model can complete a coding task (e.g. migrate to App Router, add a Next.js feature). You have tools to explore the result files.

Classify into one of:
- "model" — the model tried but wrote incorrect code
- "infra" — infrastructure broke (API errors, rate limits, crashes) and the model never got to do real work
- "timeout" — the run hit its time limit

The eval result directory contains run-1/ through run-N/ subdirectories (one per attempt, N depends on config), plus a summary.json. Each run directory has:
- result.json — status, error, duration
- transcript.json or transcript-raw.jsonl (or older results may have transcript.jsonl) — the agent's conversation log
- outputs/eval.txt — EVAL.ts test output
- outputs/scripts/*.txt — npm script outputs (e.g. build.txt), if the experiment configured scripts

IMPORTANT: The eval harness always runs EVAL.ts tests after the agent finishes, plus any npm scripts configured in the experiment's \`scripts\` array (e.g. \`["build"]\`). These run even if the model produced nothing — tests just run against unmodified scaffold code (TODO placeholders). So test/script failures alone do NOT mean the model wrote code.

The transcript is the key evidence. It records every action the model took. If there is no transcript file, or the transcript only shows errors (no tool calls or text output from the model), the model never actually ran — that's "infra". Only classify as "model" if you see evidence in the transcript that the model actually generated code.`;

/**
 * Validates and resolves a path, ensuring it stays within the allowed root.
 */
function safePath(root: string, relativePath: string): string | null {
  const resolved = resolve(root, relativePath);
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

/**
 * Creates sandboxed read-only tools for the AI classifier.
 */
export function createClassifierTools(evalResultDir: string) {
  return {
    list_files: tool({
      description:
        'List files and directories at a path relative to the eval result root. Use "." for the root.',
      inputSchema: z.object({
        path: z
          .string()
          .describe('Relative path to list, e.g. "." or "run-1" or "run-1/outputs"'),
      }),
      execute: async ({ path: relPath }) => {
        const target = safePath(evalResultDir, relPath);
        if (!target) return { error: 'Path outside allowed directory' };
        try {
          const entries = readdirSync(target);
          const results: Array<{ name: string; type: 'file' | 'dir' }> = [];
          for (const entry of entries.sort()) {
            const info = statSync(join(target, entry));
            results.push({ name: entry, type: info.isDirectory() ? 'dir' : 'file' });
          }
          return { entries: results };
        } catch {
          return { error: `Cannot list: ${relPath}` };
        }
      },
    }),

    read_file: tool({
      description:
        'Read a file relative to the eval result root. For large files, use offset/limit to paginate.',
      inputSchema: z.object({
        path: z
          .string()
          .describe('Relative path to the file, e.g. "run-1/result.json"'),
        offset: z
          .number()
          .describe('Line offset to start reading from (0-based)')
          .optional(),
        limit: z
          .number()
          .describe('Max number of lines to return')
          .optional(),
      }),
      execute: async ({ path: relPath, offset: rawOffset, limit: rawLimit }) => {
        const offset = rawOffset ?? 0;
        const limit = rawLimit ?? 200;
        const target = safePath(evalResultDir, relPath);
        if (!target) return { error: 'Path outside allowed directory' };
        try {
          const content = readFileSync(target, 'utf-8');
          const lines = content.split('\n');
          const sliced = lines.slice(offset, offset + limit);
          return {
            content: sliced.join('\n'),
            totalLines: lines.length,
            showing: `lines ${offset}-${Math.min(offset + limit, lines.length)} of ${lines.length}`,
          };
        } catch {
          return { error: `Cannot read: ${relPath}` };
        }
      },
    }),

    grep: tool({
      description:
        'Search for a pattern in files under a directory. Returns matching lines with context.',
      inputSchema: z.object({
        pattern: z.string().describe('Text or regex pattern to search for'),
        path: z
          .string()
          .describe('Relative directory or file to search in, e.g. "." or "run-1"'),
        maxResults: z
          .number()
          .describe('Max number of matches to return')
          .optional(),
      }),
      execute: async ({ pattern, path: relPath, maxResults: rawMax }) => {
        const maxResults = rawMax ?? 20;
        const target = safePath(evalResultDir, relPath);
        if (!target) return { error: 'Path outside allowed directory' };
        const regex = new RegExp(pattern, 'i');
        const matches: Array<{ file: string; line: number; text: string }> = [];

        async function searchFile(filePath: string, relName: string) {
          try {
            const content = readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
              if (regex.test(lines[i])) {
                matches.push({
                  file: relName,
                  line: i + 1,
                  text: lines[i].slice(0, 500),
                });
              }
            }
          } catch {
            // Skip unreadable files
          }
        }

        async function searchDir(dirPath: string, prefix: string) {
          try {
            const entries = readdirSync(dirPath);
            for (const entry of entries) {
              if (matches.length >= maxResults) break;
              const full = join(dirPath, entry);
              const rel = prefix ? `${prefix}/${entry}` : entry;
              const info = statSync(full);
              if (info.isDirectory()) {
                await searchDir(full, rel);
              } else {
                await searchFile(full, rel);
              }
            }
          } catch {
            // Skip unreadable dirs
          }
        }

        try {
          const info = statSync(target);
          if (info.isDirectory()) {
            await searchDir(target, relPath === '.' ? '' : relPath);
          } else {
            await searchFile(target, relPath);
          }
        } catch {
          return { error: `Path not found: ${relPath}` };
        }

        return {
          matches,
          totalFound: matches.length,
          truncated: matches.length >= maxResults,
        };
      },
    }),
  };
}

/**
 * Classify a failure using AI via the Vercel AI Gateway.
 * Requires AI_GATEWAY_API_KEY in the environment.
 */
export async function classifyWithAI(
  evalResultDir: string,
  evalName: string,
  experimentName: string
): Promise<Classification | null> {
  const { generateText, hasToolCall, createGateway } = await import('ai');

  const gateway = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN ?? '' });

  let classification: Classification | null = null;

  const explorationTools = createClassifierTools(evalResultDir);
  const allTools = {
    ...explorationTools,
    classify: tool({
      description: 'Submit your final classification. Call this once you have enough evidence.',
      inputSchema: z.object({
        failureType: z
          .enum(['model', 'infra', 'timeout'])
          .describe('The failure category'),
        failureReason: z
          .string()
          .describe('Brief 1-2 sentence explanation of why'),
      }),
      execute: async ({ failureType, failureReason }) => {
        classification = { failureType: failureType as FailureType, failureReason };
        return { ok: true };
      },
    }),
  };

  try {
    await generateText({
      model: gateway('anthropic/claude-sonnet-4-5'),
      system: CLASSIFIER_SYSTEM_PROMPT,
      prompt: `Classify the failure for eval "${evalName}" (experiment: ${experimentName}). Use the exploration tools to investigate, then call classify() with your verdict.`,
      tools: allTools,
      stopWhen: hasToolCall('classify'),
    });

    return classification;
  } catch {
    return null;
  }
}

/**
 * Classify a failed eval result using AI.
 * Requires AI_GATEWAY_API_KEY in the environment.
 *
 * Caches results in classification.json within the eval result directory.
 */
export async function classifyFailure(
  evalResultDir: string,
  evalName: string,
  experimentName: string
): Promise<Classification | null> {
  // Check for cached classification
  const cachedPath = join(evalResultDir, 'classification.json');
  try {
    const cached = JSON.parse(readFileSync(cachedPath, 'utf-8'));
    if (cached.failureType && cached.failureReason) {
      return { failureType: cached.failureType, failureReason: cached.failureReason };
    }
  } catch {
    // No cache
  }

  // Classify with AI
  const classification = await classifyWithAI(evalResultDir, evalName, experimentName);

  // Cache the result
  if (classification) {
    try {
      writeFileSync(cachedPath, JSON.stringify(classification, null, 2));
    } catch {
      // Non-fatal: caching failed
    }
  }

  return classification;
}

/**
 * Check if an eval result was classified as a non-model failure (infra or timeout).
 * Reads classification.json — the single source of truth for classification data.
 *
 * Returns false for acknowledged failures (--ack-failures), since those are
 * intentionally kept as final results.
 */
export function isNonModelFailure(evalResultDir: string): boolean {
  try {
    const classification = JSON.parse(readFileSync(join(evalResultDir, 'classification.json'), 'utf-8'));
    if (classification.acknowledged) return false;
    return classification.failureType != null && classification.failureType !== 'model';
  } catch {
    return false;
  }
}
