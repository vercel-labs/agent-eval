import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureGeneratedFiles,
  ensureValidationRunner,
  FALLBACK_VITEST_VERSION,
  initGitAndCommit,
  injectTranscriptContext,
  prepareNeutralWorkspace,
  runValidation,
  TRANSCRIPT_CONTEXT_PATH,
} from './shared.js';
import { LocalSandbox } from './plugin/local-sandbox.test-support.js';

describe('prepareNeutralWorkspace', () => {
  it('copies Vercel sandboxes into /workspace and switches the working directory', async () => {
    const sandbox = {
      getWorkingDirectory: vi.fn(() => '/vercel/sandbox'),
      setWorkingDirectory: vi.fn(),
      runShell: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    };

    const result = await prepareNeutralWorkspace(sandbox as never);

    expect(sandbox.runShell).toHaveBeenCalledWith('git remote remove origin 2>/dev/null || true; rm -rf .git/logs');
    expect(sandbox.runShell).toHaveBeenCalledWith(expect.stringContaining('sudo cp -a . /workspace/'));
    expect(sandbox.setWorkingDirectory).toHaveBeenCalledWith('/workspace');
    expect(result).toEqual({
      cwd: '/workspace',
      env: { USER: 'user', LOGNAME: 'user' },
    });
  });

  it('keeps non-Vercel sandbox working directories in place', async () => {
    const sandbox = {
      getWorkingDirectory: vi.fn(() => '/home/sandbox/workspace'),
      setWorkingDirectory: vi.fn(),
      runShell: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    };

    const result = await prepareNeutralWorkspace(sandbox as never);

    expect(sandbox.runShell).toHaveBeenCalledTimes(1);
    expect(sandbox.setWorkingDirectory).not.toHaveBeenCalled();
    expect(result).toEqual({
      cwd: '/home/sandbox/workspace',
      env: { USER: 'user', LOGNAME: 'user' },
    });
  });
});

describe('ensureValidationRunner', () => {
  const sandboxWith = (present: boolean) => ({
    runShell: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: present ? 0 : 1 })),
    runCommand: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
  });

  it('leaves a workspace that already has vitest alone', async () => {
    const sandbox = sandboxWith(true);

    await ensureValidationRunner(sandbox as never);

    expect(sandbox.runShell).toHaveBeenCalledWith('test -e node_modules/vitest/package.json');
    expect(sandbox.runCommand).not.toHaveBeenCalled();
  });

  it('reinstalls vitest when the agent removed it, leaving manifest and lockfile alone', async () => {
    const sandbox = sandboxWith(false);

    await ensureValidationRunner(sandbox as never);

    expect(sandbox.runCommand).toHaveBeenCalledWith('npm', [
      'install',
      '--no-save',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      `vitest@${FALLBACK_VITEST_VERSION}`,
    ]);
  });
});

describe('runValidation', () => {
  it('restores the runner before invoking vitest', async () => {
    const order: string[] = [];
    const sandbox = {
      runShell: vi.fn(async (cmd: string) => {
        order.push(`shell:${cmd}`);
        return { stdout: 'package.json\nEVAL.ts\n', stderr: '', exitCode: 1 };
      }),
      runCommand: vi.fn(async (cmd: string, args: string[]) => {
        order.push(`${cmd} ${args.join(' ')}`);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };

    await runValidation(sandbox as never, []);

    const install = order.findIndex((c) => c.startsWith('npm install --no-save'));
    const run = order.findIndex((c) => c.startsWith('npx vitest run'));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(install);
  });
});

/**
 * A real 1x1 PNG. Byte 0 is 0x89, which is not a valid UTF-8 lead byte, so any
 * UTF-8 decode of this file replaces it with U+FFFD.
 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * Reproduces what the sandbox transport does to `readFile`: stdout is a string,
 * decoded as UTF-8 chunk by chunk. Invalid bytes become U+FFFD, and multi-byte
 * sequences straddling a chunk boundary are lost too.
 */
function decodeLikeStdout(bytes: Buffer, chunkSize = 8): string {
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    out += new TextDecoder().decode(bytes.subarray(offset, offset + chunkSize));
  }
  return out;
}

/** `nameStatus` is what `git diff --name-status -z` prints: "<status>\0<path>\0" records. */
function fakeSandbox(files: Record<string, Buffer>, nameStatus: string) {
  return {
    runShell: vi.fn(async () => ({ stdout: nameStatus, stderr: '', exitCode: 0 })),
    readFile: vi.fn(async (path: string) => decodeLikeStdout(files[path])),
    readFileBuffer: vi.fn(async (path: string) => files[path]),
  };
}

describe('captureGeneratedFiles', () => {
  it('captures binary files without corrupting them', async () => {
    const sandbox = fakeSandbox(
      { 'public/favicon.png': PNG_BYTES },
      'A\0public/favicon.png\0'
    );

    const { generatedFiles } = await captureGeneratedFiles(sandbox as never);

    expect(Buffer.compare(generatedFiles['public/favicon.png'], PNG_BYTES)).toBe(0);
    // Guards the premise: the string path this replaced really was lossy.
    expect(
      Buffer.from(await sandbox.readFile('public/favicon.png'), 'utf-8')
    ).not.toEqual(PNG_BYTES);
  });

  it('captures text files unchanged', async () => {
    const source = Buffer.from('export const x = 1;\n', 'utf-8');
    const sandbox = fakeSandbox({ 'src/index.ts': source }, 'M\0src/index.ts\0');

    const { generatedFiles } = await captureGeneratedFiles(sandbox as never);

    expect(Buffer.compare(generatedFiles['src/index.ts'], source)).toBe(0);
    expect(generatedFiles['src/index.ts'].toString('utf-8')).toBe('export const x = 1;\n');
  });

  it('records deleted files without reading them', async () => {
    const sandbox = fakeSandbox(
      { 'src/kept.ts': Buffer.from('kept', 'utf-8') },
      'D\0src/gone.ts\0M\0src/kept.ts\0'
    );

    const { generatedFiles, deletedFiles } = await captureGeneratedFiles(sandbox as never);

    expect(deletedFiles).toEqual(['src/gone.ts']);
    expect(Object.keys(generatedFiles)).toEqual(['src/kept.ts']);
    expect(sandbox.readFileBuffer).toHaveBeenCalledTimes(1);
    expect(sandbox.readFileBuffer).toHaveBeenCalledWith('src/kept.ts');
  });

  it('skips files it cannot read', async () => {
    const sandbox = fakeSandbox({}, 'A\0unreadable.bin\0');
    sandbox.readFileBuffer.mockRejectedValueOnce(new Error('permission denied'));

    const { generatedFiles } = await captureGeneratedFiles(sandbox as never);

    expect(generatedFiles).toEqual({});
  });
});

describe('captureGeneratedFiles against a real git repository', () => {
  let sandbox: LocalSandbox;

  afterEach(() => {
    sandbox.dispose();
  });

  /** A workspace with a git baseline, as the orchestrator sets it up before the agent runs. */
  async function workspaceWith(files: Record<string, string>): Promise<string> {
    sandbox = new LocalSandbox();
    await sandbox.writeFiles(files);
    await initGitAndCommit(sandbox);
    return sandbox.getWorkingDirectory();
  }

  it('records a renamed file as the old path deleted and the new path written', async () => {
    const cwd = await workspaceWith({ 'src/old-name.ts': 'export const answer = 42;\n', 'README.md': '# app\n' });
    mkdirSync(join(cwd, 'lib'));
    renameSync(join(cwd, 'src/old-name.ts'), join(cwd, 'lib/new-name.ts'));

    const { generatedFiles, deletedFiles } = await captureGeneratedFiles(sandbox as never);

    expect(deletedFiles).toEqual(['src/old-name.ts']);
    expect(Object.keys(generatedFiles)).toEqual(['lib/new-name.ts']);
    expect(generatedFiles['lib/new-name.ts'].toString('utf-8')).toBe('export const answer = 42;\n');
  });

  it('records a renamed and edited file the same way', async () => {
    const cwd = await workspaceWith({ 'button.jsx': 'export function Button() {\n  return <button />;\n}\n' });
    renameSync(join(cwd, 'button.jsx'), join(cwd, 'Button.tsx'));
    writeFileSync(join(cwd, 'Button.tsx'), 'export function Button() {\n  return <button type="button" />;\n}\n');

    const { generatedFiles, deletedFiles } = await captureGeneratedFiles(sandbox as never);

    expect(deletedFiles).toEqual(['button.jsx']);
    expect(generatedFiles['Button.tsx'].toString('utf-8')).toContain('type="button"');
  });

  it('keeps paths that git would otherwise quote', async () => {
    const cwd = await workspaceWith({ 'old "quoted".txt': 'gone\n' });
    unlinkSync(join(cwd, 'old "quoted".txt'));
    writeFileSync(join(cwd, 'say "hi".txt'), 'hi\n');
    writeFileSync(join(cwd, 'café.md'), 'menu\n');
    writeFileSync(join(cwd, 'my notes.md'), 'notes\n');

    const { generatedFiles, deletedFiles } = await captureGeneratedFiles(sandbox as never);

    expect(deletedFiles).toEqual(['old "quoted".txt']);
    expect(Object.keys(generatedFiles).sort()).toEqual(['café.md', 'my notes.md', 'say "hi".txt']);
    expect(generatedFiles['say "hi".txt'].toString('utf-8')).toBe('hi\n');
  });

  it('ignores files the baseline .gitignore excludes', async () => {
    const cwd = await workspaceWith({ 'package.json': '{}' });
    mkdirSync(join(cwd, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
    writeFileSync(join(cwd, 'run.sh'), '#!/bin/sh\necho ok\n');
    chmodSync(join(cwd, 'run.sh'), 0o755);

    const { generatedFiles, deletedFiles } = await captureGeneratedFiles(sandbox as never);

    expect(Object.keys(generatedFiles)).toEqual(['run.sh']);
    expect(deletedFiles).toEqual([]);
  });
});

describe('injectTranscriptContext', () => {
  it('exposes the run\'s token usage to EVAL.ts in __agent_eval__/results.json', async () => {
    const written: Record<string, string> = {};
    const sandbox = { writeFiles: vi.fn(async (files: Record<string, string>) => Object.assign(written, files)) };
    const transcript = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 120 } }),
    ].join('\n');

    await injectTranscriptContext(sandbox as never, transcript, 'codex', 'gpt-5.4');

    const context = JSON.parse(written[TRANSCRIPT_CONTEXT_PATH]);
    expect(context.o11y.usage).toEqual({
      inputTokens: 1000,
      cacheReadTokens: 2000,
      outputTokens: 120,
      totalTokens: 3120,
    });
  });
});
