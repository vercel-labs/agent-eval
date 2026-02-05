/**
 * End-to-end integration tests for the eval framework.
 *
 * These tests require valid Vercel and Anthropic credentials.
 * Run with: INTEGRATION_TEST=1 npm test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { config as dotenvConfig } from 'dotenv';
import { initProject } from './lib/init.js';
import { loadFixture, loadAllFixtures } from './lib/fixture.js';
import { runSingleEval } from './lib/runner.js';
import { loadConfig } from './lib/config.js';
import { getSandboxBackendInfo } from './lib/sandbox.js';

// Load .env file (try .env.local first, then .env)
dotenvConfig({ path: '.env.local' });
dotenvConfig();

const TEST_DIR = '/tmp/eval-framework-integration-test';

// Check if Docker is available (for sandbox backend)
function isDockerAvailableSync(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Sandbox availability: either Vercel credentials OR Docker
const hasVercelSandbox = !!(process.env.VERCEL_TOKEN || process.env.VERCEL_OIDC_TOKEN);
const hasDockerSandbox = isDockerAvailableSync();
const hasSandbox = hasVercelSandbox || hasDockerSandbox;

// AI Gateway credentials (need API key + sandbox)
const hasAiGatewayCredentials = !!process.env.AI_GATEWAY_API_KEY && hasSandbox;
// Direct API credentials (need API key + sandbox)
const hasAnthropicCredentials = !!process.env.ANTHROPIC_API_KEY && hasSandbox;
const hasOpenAiCredentials = !!process.env.OPENAI_API_KEY && hasSandbox;
// OpenCode credentials (only supports AI Gateway)
const hasOpenCodeCredentials = hasAiGatewayCredentials;

describe.skipIf(!process.env.INTEGRATION_TEST)('integration tests', () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });

    // Log sandbox backend info
    const sandboxInfo = getSandboxBackendInfo();
    console.log(`\nSandbox backend: ${sandboxInfo.description}`);
    console.log(`  Vercel available: ${hasVercelSandbox}`);
    console.log(`  Docker available: ${hasDockerSandbox}\n`);
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('project initialization', () => {
    // Create test project before all tests in this block
    beforeAll(() => {
      const projectDir = join(TEST_DIR, 'test-project');
      if (!existsSync(projectDir)) {
        initProject({
          name: 'test-project',
          targetDir: TEST_DIR,
        });
      }
    });

    it('creates a complete project structure', () => {
      const projectDir = join(TEST_DIR, 'test-project');

      // Verify structure
      expect(existsSync(join(projectDir, 'package.json'))).toBe(true);
      expect(existsSync(join(projectDir, 'experiments/cc.ts'))).toBe(true);
      expect(existsSync(join(projectDir, 'experiments/codex.ts'))).toBe(true);
      expect(existsSync(join(projectDir, 'evals/add-greeting/PROMPT.md'))).toBe(true);
      expect(existsSync(join(projectDir, 'evals/add-greeting/EVAL.ts'))).toBe(true);
      expect(existsSync(join(projectDir, 'evals/add-greeting/package.json'))).toBe(true);

      // Verify package.json is valid
      const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'));
      expect(pkg.name).toBe('test-project');
      expect(pkg.type).toBe('module');
      expect(pkg.scripts).toBeUndefined();
    });

    it('can load fixtures from generated project', () => {
      const projectDir = join(TEST_DIR, 'test-project');
      const evalsDir = join(projectDir, 'evals');

      const { fixtures, errors } = loadAllFixtures(evalsDir);

      expect(fixtures).toHaveLength(1);
      expect(errors).toHaveLength(0);
      expect(fixtures[0].name).toBe('add-greeting');
    });

    it('can load Claude Code experiment config from generated project', async () => {
      const projectDir = join(TEST_DIR, 'test-project');
      const configPath = join(projectDir, 'experiments/cc.ts');

      const config = await loadConfig(configPath);

      expect(config.agent).toBe('vercel-ai-gateway/claude-code');
      expect(config.model).toBe('opus');
    });

    it('can load Codex experiment config from generated project', async () => {
      const projectDir = join(TEST_DIR, 'test-project');
      const configPath = join(projectDir, 'experiments/codex.ts');

      const config = await loadConfig(configPath);

      expect(config.agent).toBe('vercel-ai-gateway/codex');
      expect(config.model).toBe('openai/gpt-5.2-codex');
    });
  });

  describe.skipIf(!hasAiGatewayCredentials)('Claude Code (Vercel AI Gateway) sandbox execution', () => {
    it('surfaces CLI error when invalid model is provided', async () => {
      // Create a simple test fixture
      const fixtureDir = join(TEST_DIR, 'invalid-model-claude');
      mkdirSync(join(fixtureDir, 'src'), { recursive: true });

      writeFileSync(join(fixtureDir, 'PROMPT.md'), 'Say hello');
      writeFileSync(
        join(fixtureDir, 'EVAL.ts'),
        `
import { test, expect } from 'vitest';
test('dummy', () => expect(true).toBe(true));
`
      );
      writeFileSync(
        join(fixtureDir, 'package.json'),
        JSON.stringify({
          name: 'invalid-model-claude',
          type: 'module',
          devDependencies: { vitest: '^2.1.0' },
        })
      );
      writeFileSync(join(fixtureDir, 'src/index.ts'), '');

      const fixture = loadFixture(TEST_DIR, 'invalid-model-claude');

      const result = await runSingleEval(fixture, {
        agent: 'vercel-ai-gateway/claude-code',
        model: 'invalid-model-xyz',
        timeout: 60,
        apiKey: process.env.AI_GATEWAY_API_KEY!,
        scripts: [],
      });

      // Should fail with CLI error about invalid model
      expect(result.result.status).toBe('failed');
      expect(result.result.error).toBeDefined();
      // Error from CLI/API should mention the invalid model
      expect(result.result.error).toContain('invalid-model-xyz');
    }, 120000);

    it('can run a simple eval with Claude Code', async () => {
      // Create a simple test fixture
      const fixtureDir = join(TEST_DIR, 'simple-eval-claude');
      mkdirSync(join(fixtureDir, 'src'), { recursive: true });

      writeFileSync(
        join(fixtureDir, 'PROMPT.md'),
        'Add a function called greet that returns "Hello!"'
      );
      writeFileSync(
        join(fixtureDir, 'EVAL.ts'),
        `
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';

test('greet exists', () => {
  const content = readFileSync('src/index.ts', 'utf-8');
  expect(content).toContain('greet');
});
`
      );
      writeFileSync(
        join(fixtureDir, 'package.json'),
        JSON.stringify({
          name: 'simple-eval-claude',
          type: 'module',
          scripts: { build: 'tsc' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.1.0' },
        })
      );
      writeFileSync(
        join(fixtureDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'bundler',
            outDir: 'dist',
          },
          include: ['src'],
        })
      );
      writeFileSync(join(fixtureDir, 'src/index.ts'), '// TODO: implement');

      const fixture = loadFixture(TEST_DIR, 'simple-eval-claude');

      const result = await runSingleEval(fixture, {
        agent: 'vercel-ai-gateway/claude-code',
        model: 'sonnet',
        timeout: 120,
        apiKey: process.env.AI_GATEWAY_API_KEY!,
        scripts: ['build'],
      });

      // Verify result structure
      expect(result.result.duration).toBeGreaterThan(0);
      expect(result.result.status).toBeDefined();
      // Agent must actually succeed - not just return a result
      if (result.result.status === 'failed') {
        console.error('Agent failed with error:', result.result.error);
      }
      expect(result.result.status).toBe('passed');

      // Verify output content exists (if available)
      if (result.outputContent) {
        expect(typeof result.outputContent).toBe('object');
      }
    }, 300000); // 5 minute timeout
  });

  describe.skipIf(!hasAnthropicCredentials)('Claude Code (Direct API) sandbox execution', () => {
    it('can run a simple eval with Claude Code using direct Anthropic API', async () => {
      // Create a simple test fixture
      const fixtureDir = join(TEST_DIR, 'simple-eval-claude-direct');
      mkdirSync(join(fixtureDir, 'src'), { recursive: true });

      writeFileSync(
        join(fixtureDir, 'PROMPT.md'),
        'Add a function called greet that returns "Hello from direct API!"'
      );
      writeFileSync(
        join(fixtureDir, 'EVAL.ts'),
        `
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';

test('greet exists', () => {
  const content = readFileSync('src/index.ts', 'utf-8');
  expect(content).toContain('greet');
});
`
      );
      writeFileSync(
        join(fixtureDir, 'package.json'),
        JSON.stringify({
          name: 'simple-eval-claude-direct',
          type: 'module',
          scripts: { build: 'tsc' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.1.0' },
        })
      );
      writeFileSync(
        join(fixtureDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'bundler',
            outDir: 'dist',
          },
          include: ['src'],
        })
      );
      writeFileSync(join(fixtureDir, 'src/index.ts'), '// TODO: implement');

      const fixture = loadFixture(TEST_DIR, 'simple-eval-claude-direct');

      const result = await runSingleEval(fixture, {
        agent: 'claude-code', // Direct API (no ai-gateway/ prefix)
        model: 'sonnet',
        timeout: 120,
        apiKey: process.env.ANTHROPIC_API_KEY!,
        scripts: ['build'],
      });

      // Verify result structure
      expect(result.result.duration).toBeGreaterThan(0);
      expect(result.result.status).toBeDefined();
      // Agent must actually succeed - not just return a result
      if (result.result.status === 'failed') {
        console.error('Agent failed with error:', result.result.error);
      }
      expect(result.result.status).toBe('passed');

      // Verify output content exists (if available)
      if (result.outputContent) {
        expect(typeof result.outputContent).toBe('object');
      }
    }, 300000); // 5 minute timeout
  });

  describe.skipIf(!hasAiGatewayCredentials)('Codex (Vercel AI Gateway) sandbox execution', () => {
    it('can run a simple eval with Codex', async () => {
      // Create a simple test fixture
      const fixtureDir = join(TEST_DIR, 'simple-eval-codex');
      mkdirSync(join(fixtureDir, 'src'), { recursive: true });

      writeFileSync(
        join(fixtureDir, 'PROMPT.md'),
        'Add a function called greet that returns "Hello!"'
      );
      writeFileSync(
        join(fixtureDir, 'EVAL.ts'),
        `
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';

test('greet exists', () => {
  const content = readFileSync('src/index.ts', 'utf-8');
  expect(content).toContain('greet');
});
`
      );
      writeFileSync(
        join(fixtureDir, 'package.json'),
        JSON.stringify({
          name: 'simple-eval-codex',
          type: 'module',
          scripts: { build: 'tsc' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.1.0' },
        })
      );
      writeFileSync(
        join(fixtureDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'bundler',
            outDir: 'dist',
          },
          include: ['src'],
        })
      );
      writeFileSync(join(fixtureDir, 'src/index.ts'), '// TODO: implement');

      const fixture = loadFixture(TEST_DIR, 'simple-eval-codex');

      const result = await runSingleEval(fixture, {
        agent: 'vercel-ai-gateway/codex',
        model: 'openai/gpt-5.2-codex',
        timeout: 120,
        apiKey: process.env.AI_GATEWAY_API_KEY!,
        scripts: ['build'],
      });

      // Verify Codex actually succeeded (not just returned a result)
      if (result.result.status === 'failed') {
        console.error('Codex failed with error:', result.result.error);
      }
      expect(result.result.status).toBe('passed');
      expect(result.result.duration).toBeGreaterThan(0);

      // Verify output content exists (if available)
      if (result.outputContent) {
        expect(typeof result.outputContent).toBe('object');
      }

      // Verify transcript is captured (if available)
      if (result.transcript) {
        expect(typeof result.transcript).toBe('string');
      }
    }, 300000); // 5 minute timeout

    it('verifies result output structure matches expected format', async () => {
      // Create a simple test fixture
      const fixtureDir = join(TEST_DIR, 'result-structure-codex');
      mkdirSync(join(fixtureDir, 'src'), { recursive: true });

      writeFileSync(
        join(fixtureDir, 'PROMPT.md'),
        'Create a simple hello.ts file that exports a greeting constant.'
      );
      writeFileSync(
        join(fixtureDir, 'EVAL.ts'),
        `
import { test, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';

test('hello.ts exists', () => {
  expect(existsSync('src/hello.ts')).toBe(true);
});

test('contains greeting', () => {
  const content = readFileSync('src/hello.ts', 'utf-8');
  expect(content).toContain('greeting');
});
`
      );
      writeFileSync(
        join(fixtureDir, 'package.json'),
        JSON.stringify({
          name: 'result-structure-codex',
          type: 'module',
          scripts: { build: 'tsc' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.1.0' },
        })
      );
      writeFileSync(
        join(fixtureDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'bundler',
            outDir: 'dist',
          },
          include: ['src'],
        })
      );

      const fixture = loadFixture(TEST_DIR, 'result-structure-codex');

      const result = await runSingleEval(fixture, {
        agent: 'vercel-ai-gateway/codex',
        model: 'openai/gpt-5.2-codex',
        timeout: 120,
        apiKey: process.env.AI_GATEWAY_API_KEY!,
        scripts: ['build'],
      });

      // Verify EvalRunData structure
      expect(result).toHaveProperty('result');
      expect(result.result).toHaveProperty('status');
      expect(result.result).toHaveProperty('duration');

      // Verify optional properties have correct types when present
      if (result.result.error) {
        expect(typeof result.result.error).toBe('string');
      }

      // Verify transcript structure if present
      if (result.transcript) {
        expect(typeof result.transcript).toBe('string');
        // Codex uses JSON format
        try {
          JSON.parse(result.transcript);
        } catch {
          // It's fine if it's not valid JSON - transcript format may vary
        }
      }

      // Verify output content structure if present
      if (result.outputContent) {
        if (result.outputContent.eval) {
          expect(typeof result.outputContent.eval).toBe('string');
        }
        if (result.outputContent.scripts?.build) {
          expect(typeof result.outputContent.scripts.build).toBe('string');
        }
      }
    }, 300000); // 5 minute timeout
  });

  describe.skipIf(!hasOpenAiCredentials)('Codex (Direct API) sandbox execution', () => {
    it('can run a simple eval with Codex using direct OpenAI API', async () => {
      // Create a simple test fixture
      const fixtureDir = join(TEST_DIR, 'simple-eval-codex-direct');
      mkdirSync(join(fixtureDir, 'src'), { recursive: true });

      writeFileSync(
        join(fixtureDir, 'PROMPT.md'),
        'Add a function called greet that returns "Hello from OpenAI!"'
      );
      writeFileSync(
        join(fixtureDir, 'EVAL.ts'),
        `
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';

test('greet exists', () => {
  const content = readFileSync('src/index.ts', 'utf-8');
  expect(content).toContain('greet');
});
`
      );
      writeFileSync(
        join(fixtureDir, 'package.json'),
        JSON.stringify({
          name: 'simple-eval-codex-direct',
          type: 'module',
          scripts: { build: 'tsc' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.1.0' },
        })
      );
      writeFileSync(
        join(fixtureDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'bundler',
            outDir: 'dist',
          },
          include: ['src'],
        })
      );
      writeFileSync(join(fixtureDir, 'src/index.ts'), '// TODO: implement');

      const fixture = loadFixture(TEST_DIR, 'simple-eval-codex-direct');

      const result = await runSingleEval(fixture, {
        agent: 'codex', // Direct API (no ai-gateway/ prefix)
        model: 'openai/gpt-5.2-codex',
        timeout: 120,
        apiKey: process.env.OPENAI_API_KEY!,
        scripts: ['build'],
      });

      // Verify result structure
      expect(result.result.duration).toBeGreaterThan(0);
      expect(result.result.status).toBeDefined();
      // Agent must actually succeed - not just return a result
      if (result.result.status === 'failed') {
        console.error('Agent failed with error:', result.result.error);
      }
      expect(result.result.status).toBe('passed');

      // Verify output content exists (if available)
      if (result.outputContent) {
        expect(typeof result.outputContent).toBe('object');
      }

      // Verify transcript is captured (if available)
      if (result.transcript) {
        expect(typeof result.transcript).toBe('string');
      }
    }, 300000); // 5 minute timeout

    it('verifies Codex direct API uses correct configuration', async () => {
      // Create a simple test fixture
      const fixtureDir = join(TEST_DIR, 'codex-direct-config-test');
      mkdirSync(join(fixtureDir, 'src'), { recursive: true });

      writeFileSync(
        join(fixtureDir, 'PROMPT.md'),
        'Create a hello.ts file that exports a greeting constant.'
      );
      writeFileSync(
        join(fixtureDir, 'EVAL.ts'),
        `
import { test, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';

test('hello.ts exists', () => {
  expect(existsSync('src/hello.ts')).toBe(true);
});
`
      );
      writeFileSync(
        join(fixtureDir, 'package.json'),
        JSON.stringify({
          name: 'codex-direct-config-test',
          type: 'module',
          scripts: { build: 'tsc' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.1.0' },
        })
      );
      writeFileSync(
        join(fixtureDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'bundler',
            outDir: 'dist',
          },
          include: ['src'],
        })
      );

      const fixture = loadFixture(TEST_DIR, 'codex-direct-config-test');

      const result = await runSingleEval(fixture, {
        agent: 'codex', // Direct API
        model: 'openai/gpt-5.2-codex',
        timeout: 120,
        apiKey: process.env.OPENAI_API_KEY!,
        scripts: ['build'],
      });

      // Verify EvalRunData structure
      expect(result).toHaveProperty('result');
      expect(result.result).toHaveProperty('status');
      expect(result.result).toHaveProperty('duration');
    }, 300000); // 5 minute timeout
  });

  describe.skipIf(!hasOpenCodeCredentials)('OpenCode (Vercel AI Gateway) sandbox execution', () => {
    it('can run a simple eval with OpenCode', async () => {
      // Create a simple test fixture
      const fixtureDir = join(TEST_DIR, 'simple-eval-opencode');
      mkdirSync(join(fixtureDir, 'src'), { recursive: true });

      writeFileSync(
        join(fixtureDir, 'PROMPT.md'),
        'Add a function called greet that returns "Hello!"'
      );
      writeFileSync(
        join(fixtureDir, 'EVAL.ts'),
        `
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';

test('greet exists', () => {
  const content = readFileSync('src/index.ts', 'utf-8');
  expect(content).toContain('greet');
});
`
      );
      writeFileSync(
        join(fixtureDir, 'package.json'),
        JSON.stringify({
          name: 'simple-eval-opencode',
          type: 'module',
          scripts: { build: 'tsc' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.1.0' },
        })
      );
      writeFileSync(
        join(fixtureDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'bundler',
            outDir: 'dist',
          },
          include: ['src'],
        })
      );
      writeFileSync(join(fixtureDir, 'src/index.ts'), '// TODO: implement');

      const fixture = loadFixture(TEST_DIR, 'simple-eval-opencode');

      const result = await runSingleEval(fixture, {
        agent: 'vercel-ai-gateway/opencode',
        model: 'vercel/anthropic/claude-sonnet-4',
        timeout: 180,
        apiKey: process.env.AI_GATEWAY_API_KEY!,
        scripts: ['build'],
      });

      // Verify result structure
      expect(result.result.duration).toBeGreaterThan(0);
      expect(result.result.status).toBeDefined();
      // Agent must actually succeed - not just return a result
      if (result.result.status === 'failed') {
        console.error('Agent failed with error:', result.result.error);
      }
      expect(result.result.status).toBe('passed');

      // Verify output content exists (if available)
      if (result.outputContent) {
        expect(typeof result.outputContent).toBe('object');
      }

      // Verify transcript is captured (if available)
      if (result.transcript) {
        expect(typeof result.transcript).toBe('string');
      }
    }, 300000); // 5 minute timeout

    it('verifies result output structure matches expected format', async () => {
      // Create a simple test fixture
      const fixtureDir = join(TEST_DIR, 'result-structure-opencode');
      mkdirSync(join(fixtureDir, 'src'), { recursive: true });

      writeFileSync(
        join(fixtureDir, 'PROMPT.md'),
        'Create a simple hello.ts file that exports a greeting constant.'
      );
      writeFileSync(
        join(fixtureDir, 'EVAL.ts'),
        `
import { test, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';

test('hello.ts exists', () => {
  expect(existsSync('src/hello.ts')).toBe(true);
});

test('contains greeting', () => {
  const content = readFileSync('src/hello.ts', 'utf-8');
  expect(content).toContain('greeting');
});
`
      );
      writeFileSync(
        join(fixtureDir, 'package.json'),
        JSON.stringify({
          name: 'result-structure-opencode',
          type: 'module',
          scripts: { build: 'tsc' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.1.0' },
        })
      );
      writeFileSync(
        join(fixtureDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'bundler',
            outDir: 'dist',
          },
          include: ['src'],
        })
      );

      const fixture = loadFixture(TEST_DIR, 'result-structure-opencode');

      const result = await runSingleEval(fixture, {
        agent: 'vercel-ai-gateway/opencode',
        model: 'vercel/anthropic/claude-sonnet-4',
        timeout: 180,
        apiKey: process.env.AI_GATEWAY_API_KEY!,
        scripts: ['build'],
      });

      // Verify EvalRunData structure
      expect(result).toHaveProperty('result');
      expect(result.result).toHaveProperty('status');
      expect(result.result).toHaveProperty('duration');

      // Verify optional properties have correct types when present
      if (result.result.error) {
        expect(typeof result.result.error).toBe('string');
      }

      // Verify transcript structure if present
      if (result.transcript) {
        expect(typeof result.transcript).toBe('string');
        // OpenCode uses JSON format
        try {
          JSON.parse(result.transcript.split('\n')[0]);
        } catch {
          // It's fine if it's not valid JSON - transcript format may vary
        }
      }

      // Verify output content structure if present
      if (result.outputContent) {
        if (result.outputContent.eval) {
          expect(typeof result.outputContent.eval).toBe('string');
        }
        if (result.outputContent.scripts?.build) {
          expect(typeof result.outputContent.scripts.build).toBe('string');
        }
      }
    }, 300000); // 5 minute timeout
  });

  // ============================================================================
  // AI SDK Harness tests
  // Tests the new AI SDK agent with various models via AI Gateway
  // ============================================================================

  describe.skipIf(!hasAiGatewayCredentials)('AI SDK Harness tests', () => {
    // First test with Claude to verify the agent implementation works
    it('AI SDK Harness with anthropic/claude-sonnet-4 (baseline)', async () => {
      const fixtureDir = join(TEST_DIR, 'ai-sdk-claude-baseline');
      mkdirSync(join(fixtureDir, 'src'), { recursive: true });

      writeFileSync(
        join(fixtureDir, 'PROMPT.md'),
        'Add a function called greet that returns "Hello from Claude!"'
      );
      writeFileSync(
        join(fixtureDir, 'EVAL.ts'),
        `
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';

test('greet exists', () => {
  const content = readFileSync('src/index.ts', 'utf-8');
  expect(content).toContain('greet');
});
`
      );
      writeFileSync(
        join(fixtureDir, 'package.json'),
        JSON.stringify({
          name: 'ai-sdk-claude-baseline',
          type: 'module',
          scripts: { build: 'tsc' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.1.0' },
        })
      );
      writeFileSync(
        join(fixtureDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'bundler',
            outDir: 'dist',
          },
          include: ['src'],
        })
      );
      writeFileSync(join(fixtureDir, 'src/index.ts'), '// TODO: implement');

      const fixture = loadFixture(TEST_DIR, 'ai-sdk-claude-baseline');

      const result = await runSingleEval(fixture, {
        agent: 'vercel-ai-gateway/ai-sdk-harness',
        model: 'anthropic/claude-sonnet-4',
        timeout: 300,
        apiKey: process.env.AI_GATEWAY_API_KEY!,
        scripts: ['build'],
      });

      console.log('\n=== AI SDK Harness + anthropic/claude-sonnet-4 (baseline) ===');
      console.log('Status:', result.result.status);
      console.log('Duration:', result.result.duration);
      if (result.result.error) {
        console.log('Error:', result.result.error);
      }
      if (result.transcript) {
        console.log('Transcript length:', result.transcript.length);
        console.log('Transcript preview:', result.transcript.substring(0, 1000));
      }

      expect(result.result.duration).toBeGreaterThan(0);
      expect(result.result.status).toBeDefined();
      // This should pass if the agent implementation is correct
      expect(result.result.status).toBe('passed');
    }, 600000);
    // Test with moonshotai/kimi-k2.5
    it('AI SDK Harness with moonshotai/kimi-k2.5', async () => {
      const fixtureDir = join(TEST_DIR, 'ai-sdk-kimi-k2.5');
      mkdirSync(join(fixtureDir, 'src'), { recursive: true });

      writeFileSync(
        join(fixtureDir, 'PROMPT.md'),
        'Add a function called greet that returns "Hello from Kimi!"'
      );
      writeFileSync(
        join(fixtureDir, 'EVAL.ts'),
        `
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';

test('greet exists', () => {
  const content = readFileSync('src/index.ts', 'utf-8');
  expect(content).toContain('greet');
});
`
      );
      writeFileSync(
        join(fixtureDir, 'package.json'),
        JSON.stringify({
          name: 'ai-sdk-kimi-k2.5',
          type: 'module',
          scripts: { build: 'tsc' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.1.0' },
        })
      );
      writeFileSync(
        join(fixtureDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'bundler',
            outDir: 'dist',
          },
          include: ['src'],
        })
      );
      writeFileSync(join(fixtureDir, 'src/index.ts'), '// TODO: implement');

      const fixture = loadFixture(TEST_DIR, 'ai-sdk-kimi-k2.5');

      const result = await runSingleEval(fixture, {
        agent: 'vercel-ai-gateway/ai-sdk-harness',
        model: 'moonshotai/kimi-k2.5',
        timeout: 300,
        apiKey: process.env.AI_GATEWAY_API_KEY!,
        scripts: ['build'],
      });

      // Log detailed info for debugging
      console.log('\n=== AI SDK Harness + moonshotai/kimi-k2.5 ===');
      console.log('Status:', result.result.status);
      console.log('Duration:', result.result.duration);
      if (result.result.error) {
        console.log('Error:', result.result.error);
      }
      if (result.transcript) {
        console.log('Transcript length:', result.transcript.length);
        console.log('Transcript preview:', result.transcript.substring(0, 500));
      }

      // Verify result structure
      expect(result.result.duration).toBeGreaterThan(0);
      expect(result.result.status).toBeDefined();
      // Agent must actually succeed - not just return a result
      if (result.result.status === 'failed') {
        console.error('Agent failed with error:', result.result.error);
      }
      expect(result.result.status).toBe('passed');

      // Verify transcript is captured
      if (result.transcript) {
        expect(typeof result.transcript).toBe('string');
        expect(result.transcript.length).toBeGreaterThan(0);
      }
    }, 600000);

    // Comprehensive test verifying transcript and result structure
    it('verifies AI SDK Harness + Kimi K2.5 transcript and result structure', async () => {
      const fixtureDir = join(TEST_DIR, 'ai-sdk-kimi-structure-test');
      mkdirSync(join(fixtureDir, 'src'), { recursive: true });

      writeFileSync(
        join(fixtureDir, 'PROMPT.md'),
        'Create a hello.ts file in the src directory that exports a greeting constant set to "Hello from Kimi K2.5!"'
      );
      writeFileSync(
        join(fixtureDir, 'EVAL.ts'),
        `
import { test, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';

test('hello.ts exists', () => {
  expect(existsSync('src/hello.ts')).toBe(true);
});

test('contains greeting constant', () => {
  const content = readFileSync('src/hello.ts', 'utf-8');
  expect(content).toContain('greeting');
  expect(content).toContain('Hello from Kimi');
});
`
      );
      writeFileSync(
        join(fixtureDir, 'package.json'),
        JSON.stringify({
          name: 'ai-sdk-kimi-structure-test',
          type: 'module',
          scripts: { build: 'tsc' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.1.0' },
        })
      );
      writeFileSync(
        join(fixtureDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'bundler',
            outDir: 'dist',
          },
          include: ['src'],
        })
      );

      const fixture = loadFixture(TEST_DIR, 'ai-sdk-kimi-structure-test');

      const result = await runSingleEval(fixture, {
        agent: 'vercel-ai-gateway/ai-sdk-harness',
        model: 'moonshotai/kimi-k2.5',
        timeout: 300,
        apiKey: process.env.AI_GATEWAY_API_KEY!,
        scripts: ['build'],
      });

      console.log('\n=== AI SDK + Kimi K2.5 Structure Test ===');
      console.log('Status:', result.result.status);
      console.log('Duration:', result.result.duration);
      console.log('Has transcript:', !!result.transcript);
      console.log('Has outputContent:', !!result.outputContent);
      console.log('Has generatedFiles:', !!result.generatedFiles);

      // Verify EvalRunData structure
      expect(result).toHaveProperty('result');
      expect(result.result).toHaveProperty('status');
      expect(result.result).toHaveProperty('duration');

      // Verify optional properties have correct types when present
      if (result.result.error) {
        expect(typeof result.result.error).toBe('string');
        console.log('Error:', result.result.error);
      }

      // Verify transcript structure if present
      if (result.transcript) {
        expect(typeof result.transcript).toBe('string');
        expect(result.transcript.length).toBeGreaterThan(0);

        // AI SDK agent outputs JSON events
        const firstLine = result.transcript.split('\n')[0];
        try {
          const parsed = JSON.parse(firstLine);
          console.log('Transcript first event type:', parsed.type || 'unknown');
        } catch {
          console.log('Transcript is not JSONL format');
        }
      }

      // Verify output content structure if present
      if (result.outputContent) {
        console.log('Output content keys:', Object.keys(result.outputContent));
        if (result.outputContent.eval) {
          expect(typeof result.outputContent.eval).toBe('string');
        }
        if (result.outputContent.scripts?.build) {
          expect(typeof result.outputContent.scripts.build).toBe('string');
        }
      }

      // Verify generated files if present
      if (result.generatedFiles) {
        console.log('Generated files:', Object.keys(result.generatedFiles));
      }
    }, 600000);
  });

  // ============================================================================
  // Parallel sandbox tests for all agents/models
  // ============================================================================

  // Helper to create a unique fixture for each test
  function createTestFixture(testId: string) {
    const fixtureDir = join(TEST_DIR, testId);
    mkdirSync(join(fixtureDir, 'src'), { recursive: true });

    writeFileSync(
      join(fixtureDir, 'PROMPT.md'),
      'Add a function called greet that returns "Hello!"'
    );
    writeFileSync(
      join(fixtureDir, 'EVAL.ts'),
      `
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';

test('greet exists', () => {
  const content = readFileSync('src/index.ts', 'utf-8');
  expect(content).toContain('greet');
});
`
    );
    writeFileSync(
      join(fixtureDir, 'package.json'),
      JSON.stringify({
        name: testId,
        type: 'module',
        scripts: { build: 'tsc' },
        devDependencies: { typescript: '^5.0.0', vitest: '^2.1.0' },
      })
    );
    writeFileSync(
      join(fixtureDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'bundler',
          outDir: 'dist',
        },
        include: ['src'],
      })
    );
    writeFileSync(join(fixtureDir, 'src/index.ts'), '// TODO: implement');

    return loadFixture(TEST_DIR, testId);
  }

  describe.skipIf(!hasAiGatewayCredentials)('Parallel agent/model/sandbox tests', () => {
    // OpenCode + Minimax on Docker
    it.concurrent.skipIf(!hasDockerSandbox)(
      'OpenCode + minimax-m2.1 on Docker',
      async () => {
        const fixture = createTestFixture('opencode-minimax-docker');
        const result = await runSingleEval(fixture, {
          agent: 'vercel-ai-gateway/opencode',
          model: 'vercel/minimax/minimax-m2.1',
          timeout: 180,
          apiKey: process.env.AI_GATEWAY_API_KEY!,
          scripts: ['build'],
          sandbox: 'docker',
        });
        expect(result.result.duration).toBeGreaterThan(0);
        // Agent must actually succeed - not just return a result
      if (result.result.status === 'failed') {
        console.error('Agent failed with error:', result.result.error);
      }
      expect(result.result.status).toBe('passed');
      },
      300000
    );

    // OpenCode + Minimax on Vercel
    it.concurrent.skipIf(!hasVercelSandbox)(
      'OpenCode + minimax-m2.1 on Vercel',
      async () => {
        const fixture = createTestFixture('opencode-minimax-vercel');
        const result = await runSingleEval(fixture, {
          agent: 'vercel-ai-gateway/opencode',
          model: 'vercel/minimax/minimax-m2.1',
          timeout: 180,
          apiKey: process.env.AI_GATEWAY_API_KEY!,
          scripts: ['build'],
          sandbox: 'vercel',
        });
        expect(result.result.duration).toBeGreaterThan(0);
        // Agent must actually succeed - not just return a result
      if (result.result.status === 'failed') {
        console.error('Agent failed with error:', result.result.error);
      }
      expect(result.result.status).toBe('passed');
      },
      300000
    );

    // Claude Code on Docker
    it.concurrent.skipIf(!hasDockerSandbox)(
      'Claude Code + sonnet on Docker',
      async () => {
        const fixture = createTestFixture('claude-code-docker');
        const result = await runSingleEval(fixture, {
          agent: 'vercel-ai-gateway/claude-code',
          model: 'sonnet',
          timeout: 180,
          apiKey: process.env.AI_GATEWAY_API_KEY!,
          scripts: ['build'],
          sandbox: 'docker',
        });
        expect(result.result.duration).toBeGreaterThan(0);
        // Agent must actually succeed - not just return a result
      if (result.result.status === 'failed') {
        console.error('Agent failed with error:', result.result.error);
      }
      expect(result.result.status).toBe('passed');
      },
      300000
    );

    // Claude Code on Vercel
    it.concurrent.skipIf(!hasVercelSandbox)(
      'Claude Code + sonnet on Vercel',
      async () => {
        const fixture = createTestFixture('claude-code-vercel');
        const result = await runSingleEval(fixture, {
          agent: 'vercel-ai-gateway/claude-code',
          model: 'sonnet',
          timeout: 180,
          apiKey: process.env.AI_GATEWAY_API_KEY!,
          scripts: ['build'],
          sandbox: 'vercel',
        });
        expect(result.result.duration).toBeGreaterThan(0);
        // Agent must actually succeed - not just return a result
      if (result.result.status === 'failed') {
        console.error('Agent failed with error:', result.result.error);
      }
      expect(result.result.status).toBe('passed');
      },
      300000
    );

    // Codex on Docker
    it.concurrent.skipIf(!hasDockerSandbox)(
      'Codex + gpt-5.2-codex on Docker',
      async () => {
        const fixture = createTestFixture('codex-docker');
        const result = await runSingleEval(fixture, {
          agent: 'vercel-ai-gateway/codex',
          model: 'openai/gpt-5.2-codex',
          timeout: 180,
          apiKey: process.env.AI_GATEWAY_API_KEY!,
          scripts: ['build'],
          sandbox: 'docker',
        });
        expect(result.result.duration).toBeGreaterThan(0);
        // Agent must actually succeed - not just return a result
      if (result.result.status === 'failed') {
        console.error('Agent failed with error:', result.result.error);
      }
      expect(result.result.status).toBe('passed');
      },
      300000
    );

    // Codex on Vercel
    it.concurrent.skipIf(!hasVercelSandbox)(
      'Codex + gpt-5.2-codex on Vercel',
      async () => {
        const fixture = createTestFixture('codex-vercel');
        const result = await runSingleEval(fixture, {
          agent: 'vercel-ai-gateway/codex',
          model: 'openai/gpt-5.2-codex',
          timeout: 180,
          apiKey: process.env.AI_GATEWAY_API_KEY!,
          scripts: ['build'],
          sandbox: 'vercel',
        });
        expect(result.result.duration).toBeGreaterThan(0);
        // Agent must actually succeed - not just return a result
      if (result.result.status === 'failed') {
        console.error('Agent failed with error:', result.result.error);
      }
      expect(result.result.status).toBe('passed');
      },
      300000
    );

    // AI SDK Harness + Kimi K2.5 on Docker
    it.concurrent.skipIf(!hasDockerSandbox)(
      'AI SDK Harness + kimi-k2.5 on Docker',
      async () => {
        const fixture = createTestFixture('ai-sdk-kimi-docker');
        const result = await runSingleEval(fixture, {
          agent: 'vercel-ai-gateway/ai-sdk-harness',
          model: 'moonshotai/kimi-k2.5',
          timeout: 300,
          apiKey: process.env.AI_GATEWAY_API_KEY!,
          scripts: ['build'],
          sandbox: 'docker',
        });
        console.log('AI SDK + kimi-k2.5 Docker:', result.result.status, result.result.error || '');
        expect(result.result.duration).toBeGreaterThan(0);
        // Agent must actually succeed - not just return a result
      if (result.result.status === 'failed') {
        console.error('Agent failed with error:', result.result.error);
      }
      expect(result.result.status).toBe('passed');
      },
      600000
    );

    // AI SDK Harness + Kimi K2.5 on Vercel
    it.concurrent.skipIf(!hasVercelSandbox)(
      'AI SDK Harness + kimi-k2.5 on Vercel',
      async () => {
        const fixture = createTestFixture('ai-sdk-kimi-vercel');
        const result = await runSingleEval(fixture, {
          agent: 'vercel-ai-gateway/ai-sdk-harness',
          model: 'moonshotai/kimi-k2.5',
          timeout: 300,
          apiKey: process.env.AI_GATEWAY_API_KEY!,
          scripts: ['build'],
          sandbox: 'vercel',
        });
        console.log('AI SDK + kimi-k2.5 Vercel:', result.result.status, result.result.error || '');
        expect(result.result.duration).toBeGreaterThan(0);
        // Agent must actually succeed - not just return a result
      if (result.result.status === 'failed') {
        console.error('Agent failed with error:', result.result.error);
      }
      expect(result.result.status).toBe('passed');
      },
      600000
    );
  });

  describe('CLI commands', () => {
    // Ensure test project exists before CLI tests
    beforeAll(() => {
      const projectDir = join(TEST_DIR, 'test-project');
      if (!existsSync(projectDir)) {
        initProject({
          name: 'test-project',
          targetDir: TEST_DIR,
        });
      }
    });

    it('can dry run Claude Code experiment via CLI', () => {
      const projectDir = join(TEST_DIR, 'test-project');
      // Config at experiments/cc.ts -> evals inferred at ../evals
      const result = execSync(
        `npx tsx ${process.cwd()}/src/cli.ts ${projectDir}/experiments/cc.ts --dry`,
        { encoding: 'utf-8' }
      );

      expect(result).toContain('DRY RUN');
      expect(result).toContain('add-greeting');
      expect(result).toContain('Agent: vercel-ai-gateway/claude-code');
    });

    it('can dry run Codex experiment via CLI', () => {
      const projectDir = join(TEST_DIR, 'test-project');
      // Config at experiments/codex.ts -> evals inferred at ../evals
      const result = execSync(
        `npx tsx ${process.cwd()}/src/cli.ts ${projectDir}/experiments/codex.ts --dry`,
        { encoding: 'utf-8' }
      );

      expect(result).toContain('DRY RUN');
      expect(result).toContain('add-greeting');
      expect(result).toContain('Agent: vercel-ai-gateway/codex');
      expect(result).toContain('Model: openai/gpt-5.2-codex');
    });
  });
});
