import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { globSync } from 'glob';
import type { Sandbox, EvalFixture, RunnableExperimentConfig } from './types.js';
import type { SandboxFile } from './sandbox.js';

/** Persistent cache location, relative to the eval project cwd. */
export const SANDBOX_TEMPLATE_CACHE_PATH = '.agent-eval/sandbox-templates.json';

export type SandboxTemplateIdentityValue =
  | null
  | boolean
  | number
  | string
  | readonly SandboxTemplateIdentityValue[]
  | { readonly [key: string]: SandboxTemplateIdentityValue | undefined };

export interface SandboxTemplateIdentityContext {
  fixture: EvalFixture;
  config: RunnableExperimentConfig;
  hashFiles(patterns: string[]): string;
}

export interface SandboxTemplatePrepareContext {
  sandbox: Sandbox;
  fixture: EvalFixture;
  config: RunnableExperimentConfig;
}

export interface SandboxTemplate {
  key: string;
  identity?: (
    context: SandboxTemplateIdentityContext
  ) => SandboxTemplateIdentityValue | Promise<SandboxTemplateIdentityValue>;
  prepare(context: SandboxTemplatePrepareContext): void | Promise<void>;
}

/** Define expensive, reusable sandbox preparation for an experiment. */
export function defineSandboxTemplate(template: SandboxTemplate): SandboxTemplate {
  if (!template.key.trim()) {
    throw new Error('Sandbox template key must be a non-empty string.');
  }
  return template;
}

function hashSandboxFiles(files: SandboxFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`file:${file.path}\n`);
    hash.update(file.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function hashFixturePatterns(fixturePath: string, patterns: string[]): string {
  const paths = globSync(patterns, { cwd: fixturePath, nodir: true, dot: true }).sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(`file:${path}\n`);
    hash.update(readFileSync(join(fixturePath, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Sandbox template identity must be JSON-serializable.');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new Error('Sandbox template identity must be JSON-serializable.');
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Sandbox template identity must be JSON-serializable.');
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(',')}}`;
}

export async function computeSandboxTemplateIdentity(options: {
  template: SandboxTemplate;
  fixture: EvalFixture;
  config: RunnableExperimentConfig;
  workspaceFiles: SandboxFile[];
  backend: 'vercel' | 'docker';
  runtime: string;
}): Promise<string> {
  const { template, fixture, config, workspaceFiles, backend, runtime } = options;
  // The complete visible workspace is always part of the identity. A custom
  // identity can add external/contextual inputs, but can never make different
  // fixture starting states share a snapshot.
  const workspaceIdentity = hashSandboxFiles(workspaceFiles);
  const additionalIdentity = template.identity
    ? await template.identity({
        fixture,
        config,
        hashFiles: (patterns) => hashFixturePatterns(fixture.path, patterns),
      })
    : null;

  return createHash('sha256')
    .update(
      canonicalize({
        format: 1,
        key: template.key,
        workspaceIdentity,
        additionalIdentity,
        backend,
        runtime,
      })
    )
    .digest('hex');
}

interface TemplateCacheFile {
  version: 1;
  snapshots: Record<string, string>;
}

let cache: TemplateCacheFile | undefined;

function getCachePath(): string {
  return join(process.cwd(), SANDBOX_TEMPLATE_CACHE_PATH);
}

function readCache(): TemplateCacheFile {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(getCachePath(), 'utf8')) as TemplateCacheFile;
    cache = parsed.version === 1 && parsed.snapshots ? parsed : { version: 1, snapshots: {} };
  } catch {
    cache = { version: 1, snapshots: {} };
  }
  return cache;
}

function writeCache(value: TemplateCacheFile): void {
  const cachePath = getCachePath();
  mkdirSync(dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, cachePath);
}

export function getCachedSnapshotId(identity: string): string | undefined {
  return readCache().snapshots[identity];
}

export function cacheSnapshotId(identity: string, snapshotId: string): void {
  const value = readCache();
  value.snapshots[identity] = snapshotId;
  writeCache(value);
}

export function removeCachedSnapshotId(identity: string): void {
  const value = readCache();
  if (!(identity in value.snapshots)) return;
  delete value.snapshots[identity];
  writeCache(value);
}

/** @internal Test helper. */
export function resetSandboxTemplateCacheForTests(): void {
  cache = undefined;
}
