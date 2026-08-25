/**
 * fx agent definition for research-enabled runs through Vercel AI Gateway.
 */

import { fileURLToPath } from 'node:url';

import type { Agent, AgentRunOptions } from '../types.js';
import type { ModelTier } from '../../types.js';
import { AI_GATEWAY } from '../shared.js';
import type { AgentDefinition, InstallStep } from '../plugin/contract.js';
import { runWithDefinition } from '../plugin/orchestrator.js';

export const FX_VERSION = '0.0.5';

export const FX_RELEASE_SHA256 = {
  x64: 'd5639d173267774aa8228a474baf619a7076ac41a91023915007c865143429b1',
  arm64: '8bbcde6a41256c4fac4e0a022291cf02740419e27afabde3b8f45e7a4e393edb',
} as const;

const FX_RUNTIME_PROTOCOL = 'ask-json-session-v1';

/** Build the zero-dependency installer executed inside the Linux sandbox. */
export function buildFxInstallScript(): string {
  return `
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const version = ${JSON.stringify(FX_VERSION)};
const checksums = ${JSON.stringify(FX_RELEASE_SHA256)};
if (process.platform !== 'linux' || !(process.arch in checksums)) {
  throw new Error(\`Unsupported fx sandbox platform: \${process.platform}/\${process.arch}\`);
}

const releaseArch = process.arch === 'x64' ? 'x86_64' : 'aarch64';
const asset = \`fx-linux-\${releaseArch}.tar.gz\`;
const url = \`https://github.com/vercel-labs/fx/releases/download/v\${version}/\${asset}\`;
const installDir = resolve('__agent_eval__/bin');
const archivePath = join(installDir, asset);
const binaryPath = join(installDir, 'fx');

mkdirSync(installDir, { recursive: true });
const maxArchiveBytes = 32 * 1024 * 1024;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60_000);
let archive;
try {
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok) throw new Error(\`fx download failed: HTTP \${response.status}\`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxArchiveBytes) {
    throw new Error('fx archive exceeds 32 MB');
  }
  if (!response.body) throw new Error('fx download returned no body');

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxArchiveBytes) {
      controller.abort();
      throw new Error('fx archive exceeds 32 MB');
    }
    chunks.push(bytes);
  }
  archive = Buffer.concat(chunks, size);
} finally {
  clearTimeout(timeout);
}

const actual = createHash('sha256').update(archive).digest('hex');
const expected = checksums[process.arch];
if (actual !== expected) throw new Error(\`fx checksum mismatch: expected \${expected}, got \${actual}\`);

writeFileSync(archivePath, archive);
const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', installDir, 'fx'], { encoding: 'utf8' });
unlinkSync(archivePath);
if (extracted.status !== 0) throw new Error(\`fx extraction failed: \${extracted.stderr || extracted.error?.message || 'unknown error'}\`);
chmodSync(binaryPath, 0o755);

const installed = spawnSync(binaryPath, ['--version'], { encoding: 'utf8' });
if (installed.status !== 0 || installed.stdout.trim() !== version) {
  throw new Error(\`fx version check failed: \${installed.stdout || installed.stderr || installed.error?.message || 'unknown error'}\`);
}
`;
}

export function createFxDefinition(): AgentDefinition {
  return {
    name: 'vercel-ai-gateway/fx',
    displayName: 'fx (Vercel AI Gateway)',
    defaultModel: 'zai/glm-5.2',
    o11yAgentName: 'vercel-ai-gateway/fx',
    bundledSkillsControl: 'not-applicable',
    requiresWebResearch: true,
    supportsCrossAgentJudge: false,
    runnerPath: fileURLToPath(new URL('./run.mjs', import.meta.url)),

    getApiKeyEnvVar(): string {
      return AI_GATEWAY.apiKeyEnvVar;
    },

    install(_options: AgentRunOptions): InstallStep[] {
      return [
        {
          kind: 'command',
          cmd: 'npm',
          args: ['install'],
          retryOnce: true,
          errorPrefix: 'npm install failed',
          errorBody: 'last10',
        },
        {
          kind: 'command',
          cmd: 'node',
          args: ['--input-type=module', '--eval', buildFxInstallScript()],
          errorPrefix: 'fx install failed',
          errorBody: 'stderr',
        },
      ];
    },

    configFiles: () => [],

    authEnv(options: AgentRunOptions): Record<string, string> {
      return { [AI_GATEWAY.apiKeyEnvVar]: options.apiKey };
    },

    fingerprintExtra(): Record<string, unknown> {
      return {
        fxVersion: FX_VERSION,
        fxRuntimeProtocol: FX_RUNTIME_PROTOCOL,
      };
    },
  };
}

export function createFxAgent(): Agent {
  const definition = createFxDefinition();
  return {
    name: definition.name,
    displayName: definition.displayName,
    getApiKeyEnvVar: definition.getApiKeyEnvVar,
    getDefaultModel(): ModelTier {
      return definition.defaultModel;
    },
    run: (fixturePath, options) => runWithDefinition(definition, fixturePath, options),
    definition,
  };
}
