import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  collectLocalFiles,
  splitTestFiles,
  SandboxManager,
  IGNORED_PATTERNS,
  TEST_FILE_PATTERNS,
  type CommandResult,
  type SandboxFile,
} from './sandbox.js';

const TEST_DIR = '/tmp/eval-framework-sandbox-test';

/**
 * A real 1x1 PNG. Byte 0 is 0x89, which is not a valid UTF-8 lead byte, so any
 * UTF-8 decode of this file replaces it with U+FFFD.
 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('sandbox utilities', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('collectLocalFiles', () => {
    it('collects files from nested directories', async () => {
      mkdirSync(join(TEST_DIR, 'src'));
      writeFileSync(join(TEST_DIR, 'src/index.ts'), 'code');
      writeFileSync(join(TEST_DIR, 'package.json'), '{}');

      const files = await collectLocalFiles(TEST_DIR);

      expect(files.map((f) => f.path).sort()).toEqual(['package.json', 'src/index.ts']);
    });

    it('excludes default ignored patterns', async () => {
      writeFileSync(join(TEST_DIR, 'index.ts'), 'code');
      mkdirSync(join(TEST_DIR, 'node_modules'));
      writeFileSync(join(TEST_DIR, 'node_modules/pkg.js'), 'module');
      mkdirSync(join(TEST_DIR, '.git'));
      writeFileSync(join(TEST_DIR, '.git/config'), 'git config');

      const files = await collectLocalFiles(TEST_DIR);

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('index.ts');
    });

    it('uses custom exclude patterns', async () => {
      writeFileSync(join(TEST_DIR, 'index.ts'), 'code');
      writeFileSync(join(TEST_DIR, 'index.test.ts'), 'test');

      const files = await collectLocalFiles(TEST_DIR, {
        excludePatterns: ['*.test.ts'],
      });

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('index.ts');
    });
  });

  describe('splitTestFiles', () => {
    it('separates test files from workspace files', () => {
      const files: SandboxFile[] = [
        { path: 'src/App.tsx', content: 'app code' },
        { path: 'EVAL.tsx', content: 'eval tests' },
        { path: 'PROMPT.md', content: 'task description' },
        { path: 'package.json', content: '{}' },
      ];

      const { workspaceFiles, testFiles } = splitTestFiles(files);

      expect(workspaceFiles.map((f) => f.path).sort()).toEqual([
        'package.json',
        'src/App.tsx',
      ]);
      expect(testFiles.map((f) => f.path).sort()).toEqual([
        'EVAL.tsx',
        'PROMPT.md',
      ]);
    });
  });

  describe('constants', () => {
    it('IGNORED_PATTERNS includes common ignores', () => {
      expect(IGNORED_PATTERNS).toContain('.git');
      expect(IGNORED_PATTERNS).toContain('node_modules');
    });

    it('TEST_FILE_PATTERNS includes eval file patterns', () => {
      expect(TEST_FILE_PATTERNS).toContain('EVAL.ts');
      expect(TEST_FILE_PATTERNS).toContain('EVAL.tsx');
      expect(TEST_FILE_PATTERNS).toContain('PROMPT.md');
    });
  });
});

describe('SandboxManager.readFileBuffer', () => {
  /**
   * Builds a SandboxManager whose only stubbed seam is `runCommand`, so the real
   * `readFileBuffer` implementation runs. No sandbox, credentials or network.
   */
  function stubbedSandbox(
    run: (command: string, args: string[]) => CommandResult
  ): SandboxManager {
    const sandbox = Object.create(SandboxManager.prototype) as SandboxManager;
    sandbox.runCommand = async (command: string, args: string[] = []) =>
      run(command, args);
    return sandbox;
  }

  it('round-trips binary content that readFile would corrupt', async () => {
    const calls: Array<[string, string[]]> = [];
    const sandbox = stubbedSandbox((command, args) => {
      calls.push([command, args]);
      return { stdout: PNG_BYTES.toString('base64'), stderr: '', exitCode: 0 };
    });

    const content = await sandbox.readFileBuffer('public/favicon.png');

    expect(calls).toEqual([['base64', ['public/favicon.png']]]);
    expect(Buffer.compare(content, PNG_BYTES)).toBe(0);
  });

  it('decodes base64 that coreutils wrapped across lines', async () => {
    const wrapped = PNG_BYTES.toString('base64').replace(/(.{20})/g, '$1\n');
    const sandbox = stubbedSandbox(() => ({
      stdout: wrapped,
      stderr: '',
      exitCode: 0,
    }));

    expect(Buffer.compare(await sandbox.readFileBuffer('a.png'), PNG_BYTES)).toBe(0);
  });

  it('throws when the file cannot be read', async () => {
    const sandbox = stubbedSandbox(() => ({
      stdout: '',
      stderr: 'base64: missing.png: No such file or directory',
      exitCode: 1,
    }));

    await expect(sandbox.readFileBuffer('missing.png')).rejects.toThrow(
      'Failed to read file missing.png: base64: missing.png: No such file or directory'
    );
  });
});

// Integration tests that require actual Vercel credentials
// These are skipped by default and can be run with SANDBOX_INTEGRATION_TEST=1
describe.skipIf(!process.env.SANDBOX_INTEGRATION_TEST)('sandbox integration', () => {
  it('can create and stop a sandbox', async () => {
    const { SandboxManager } = await import('./sandbox.js');

    const sandbox = await SandboxManager.create({ timeout: 60000 });
    expect(sandbox.sandboxId).toBeDefined();

    const result = await sandbox.runCommand('echo', ['hello']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);

    await sandbox.stop();
  });
});
