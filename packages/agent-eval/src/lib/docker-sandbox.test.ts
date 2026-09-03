/**
 * Integration tests for Docker sandbox.
 * These tests require Docker to be running.
 * Skip with: SKIP_DOCKER_TESTS=1 npm test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  DockerSandboxManager,
  SANDBOX_APT_PACKAGES,
  SANDBOX_HOME,
  dockerSandboxAptInstallScript,
  dockerSandboxPath,
  dockerSandboxUserEnv,
} from './docker-sandbox.js';
import type { CommandResult } from './sandbox.js';

/**
 * A real 1x1 PNG. Byte 0 is 0x89, which is not a valid UTF-8 lead byte, so any
 * UTF-8 decode of this file replaces it with U+FFFD.
 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// Check if Docker is available
async function isDockerAvailable(): Promise<boolean> {
  try {
    const { execSync } = await import('child_process');
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('dockerSandboxAptInstallScript', () => {
  it('installs curl alongside git so official installer scripts can run', () => {
    expect(SANDBOX_APT_PACKAGES).toContain('curl');
    expect(SANDBOX_APT_PACKAGES).toContain('git');
    expect(SANDBOX_APT_PACKAGES).toContain('ca-certificates');
    expect(dockerSandboxAptInstallScript()).toBe(
      'apt-get update -qq && apt-get install -y -qq ca-certificates git curl'
    );
  });
});

describe('dockerSandboxUserEnv', () => {
  it('puts the node user home and ~/.local/bin on the sandbox PATH', () => {
    const path = dockerSandboxPath();
    expect(path.startsWith(`${SANDBOX_HOME}/.npm-global/bin:`)).toBe(true);
    expect(path).toContain(`${SANDBOX_HOME}/.local/bin`);
    expect(path).toContain('/usr/bin');

    const env = dockerSandboxUserEnv({ CURSOR_API_KEY: 'k', PATH: '/tmp' });
    expect(env.HOME).toBe(SANDBOX_HOME);
    expect(env.CURSOR_API_KEY).toBe('k');
    // Callers cannot replace PATH — user-local bins must stay visible.
    expect(env.PATH).toBe(path);
    expect(env.PATH).not.toBe('/tmp');
  });
});

describe('DockerSandboxManager', () => {
  const skipDocker = process.env.SKIP_DOCKER_TESTS === '1';
  let dockerAvailable = false;

  beforeAll(async () => {
    if (!skipDocker) {
      dockerAvailable = await isDockerAvailable();
    }
  });

  describe('when Docker is available', () => {
    it('can create and stop a sandbox', async () => {
      if (skipDocker || !dockerAvailable) {
        console.log('Skipping: Docker not available');
        return;
      }

      const sandbox = await DockerSandboxManager.create({
        timeout: 60000,
        runtime: 'node24',
      });

      expect(sandbox.sandboxId).toBeTruthy();
      expect(sandbox.getWorkingDirectory()).toBe('/home/sandbox/workspace');

      await sandbox.stop();
    }, 120000); // 2 minute timeout for image pull

    it('can run commands', async () => {
      if (skipDocker || !dockerAvailable) {
        console.log('Skipping: Docker not available');
        return;
      }

      const sandbox = await DockerSandboxManager.create({
        timeout: 60000,
        runtime: 'node24',
      });

      try {
        const result = await sandbox.runCommand('echo', ['hello world']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('hello world');
      } finally {
        await sandbox.stop();
      }
    }, 120000);

    it('can write and read files', async () => {
      if (skipDocker || !dockerAvailable) {
        console.log('Skipping: Docker not available');
        return;
      }

      const sandbox = await DockerSandboxManager.create({
        timeout: 60000,
        runtime: 'node24',
      });

      try {
        await sandbox.writeFiles({
          'test.txt': 'Hello from test!',
          'nested/file.json': '{"key": "value"}',
        });

        const content1 = await sandbox.readFile('test.txt');
        expect(content1.trim()).toBe('Hello from test!');

        const content2 = await sandbox.readFile('nested/file.json');
        expect(JSON.parse(content2)).toEqual({ key: 'value' });
      } finally {
        await sandbox.stop();
      }
    }, 120000);

    it('reads binary files back byte-for-byte', async () => {
      if (skipDocker || !dockerAvailable) {
        console.log('Skipping: Docker not available');
        return;
      }

      const sandbox = await DockerSandboxManager.create({
        timeout: 60000,
        runtime: 'node24',
      });

      try {
        await sandbox.uploadFiles([{ path: 'favicon.png', content: PNG_BYTES }]);

        // Proves `base64` exists in the image and that the transport survives
        // bytes the UTF-8 path would replace with U+FFFD.
        const bytes = await sandbox.readFileBuffer('favicon.png');
        expect(Buffer.compare(bytes, PNG_BYTES)).toBe(0);

        const asText = await sandbox.readFile('favicon.png');
        expect(Buffer.from(asText, 'utf-8')).not.toEqual(PNG_BYTES);
      } finally {
        await sandbox.stop();
      }
    }, 120000);

    it('can run npm commands', async () => {
      if (skipDocker || !dockerAvailable) {
        console.log('Skipping: Docker not available');
        return;
      }

      const sandbox = await DockerSandboxManager.create({
        timeout: 120000,
        runtime: 'node24',
      });

      try {
        // Create a minimal package.json
        await sandbox.writeFiles({
          'package.json': JSON.stringify({
            name: 'test-project',
            version: '1.0.0',
            type: 'module',
          }),
        });

        // Run npm install (should succeed even with no deps)
        const result = await sandbox.runCommand('npm', ['install']);
        expect(result.exitCode).toBe(0);

        // Check node version
        const nodeResult = await sandbox.runCommand('node', ['--version']);
        expect(nodeResult.exitCode).toBe(0);
        expect(nodeResult.stdout).toMatch(/^v2[04]/); // v20 or v24
      } finally {
        await sandbox.stop();
      }
    }, 180000); // 3 minute timeout

    it('returns correct exit codes for failed commands', async () => {
      if (skipDocker || !dockerAvailable) {
        console.log('Skipping: Docker not available');
        return;
      }

      const sandbox = await DockerSandboxManager.create({
        timeout: 60000,
        runtime: 'node24',
      });

      try {
        const result = await sandbox.runCommand('false'); // Always exits with 1
        expect(result.exitCode).toBe(1);
      } finally {
        await sandbox.stop();
      }
    }, 120000);

    it('resolves user-local binaries and sets HOME for the sandbox user', async () => {
      if (skipDocker || !dockerAvailable) {
        console.log('Skipping: Docker not available');
        return;
      }

      const sandbox = await DockerSandboxManager.create({
        timeout: 60000,
        runtime: 'node24',
      });

      try {
        const home = await sandbox.runShell('printf %s "$HOME"');
        expect(home.exitCode).toBe(0);
        expect(home.stdout).toBe(SANDBOX_HOME);

        const install = await sandbox.runShell(
          'mkdir -p "$HOME/.local/bin" && printf "%s\\n" "#!/bin/sh" "echo from-local-bin" > "$HOME/.local/bin/agent-eval-path-canary" && chmod +x "$HOME/.local/bin/agent-eval-path-canary"'
        );
        expect(install.exitCode).toBe(0);

        // Regression for Cursor: spawnSync('agent') → ENOENT when PATH omitted ~/.local/bin.
        const result = await sandbox.runCommand('agent-eval-path-canary');
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('from-local-bin');

        // node:*-slim has no curl; Cursor's installer is `curl … | bash`.
        const curl = await sandbox.runCommand('curl', ['--version']);
        expect(curl.exitCode).toBe(0);
        expect(curl.stdout).toMatch(/^curl /);
      } finally {
        await sandbox.stop();
      }
    }, 120000);

    it('can run shell commands', async () => {
      if (skipDocker || !dockerAvailable) {
        console.log('Skipping: Docker not available');
        return;
      }

      const sandbox = await DockerSandboxManager.create({
        timeout: 60000,
        runtime: 'node24',
      });

      try {
        const result = await sandbox.runShell('echo "hello" && echo "world"');
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('hello');
        expect(result.stdout).toContain('world');
      } finally {
        await sandbox.stop();
      }
    }, 120000);

    // Regression: Docker multiplexes stdout/stderr into a single framed stream,
    // and large output is delivered across many `data` events that split frames
    // at arbitrary byte offsets. The previous parser read each chunk
    // independently and mis-read bytes that straddled a chunk boundary, silently
    // dropping/corrupting output (e.g. truncating large file reads via `cat`).
    // A large file round-trip reproduces the corruption on main without the fix.
    it('reads back a large file without dropping or corrupting bytes', async () => {
      if (skipDocker || !dockerAvailable) {
        console.log('Skipping: Docker not available');
        return;
      }

      const sandbox = await DockerSandboxManager.create({
        timeout: 60000,
        runtime: 'node24',
      });

      try {
        // ~512KB of line-numbered content. Numbered lines make any dropped or
        // reordered bytes detectable, and the size guarantees the output spans
        // many stream chunks/frames.
        const lines: string[] = [];
        for (let i = 0; i < 8192; i++) {
          lines.push(`line ${i.toString().padStart(6, '0')}: café[0m✓ ${'x'.repeat(48)}`);
        }
        const content = lines.join('\n') + '\n';

        await sandbox.writeFiles({ 'large.txt': content });

        const readBack = await sandbox.readFile('large.txt');
        expect(readBack.length).toBe(content.length);
        expect(readBack).toBe(content);
      } finally {
        await sandbox.stop();
      }
    }, 120000);
  });

  // These need no daemon: only `runCommand` is stubbed, so the real
  // `readFileBuffer` implementation runs against a fake transport.
  describe('readFileBuffer', () => {
    function stubbedSandbox(
      run: (command: string, args: string[]) => CommandResult
    ): DockerSandboxManager {
      const sandbox = Object.create(
        DockerSandboxManager.prototype
      ) as DockerSandboxManager;
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
});
