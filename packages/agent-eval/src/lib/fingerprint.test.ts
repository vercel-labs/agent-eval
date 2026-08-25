import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  computeFingerprint,
  computeContentFingerprint,
  computeReuseCompatibilityFingerprint,
  decideRefingerprint,
  fingerprintConfigInput,
} from './fingerprint.js';
import type { RunnableExperimentConfig } from './types.js';

const TEST_DIR = '/tmp/eval-framework-fingerprint-test';

const baseConfig: RunnableExperimentConfig = {
  agent: 'claude-code',
  model: 'opus',
  evals: '*',
  runs: 2,
  earlyExit: true,
  scripts: ['build'],
  timeout: 600,
};

function createEvalDir(name: string, files: Record<string, string>): string {
  const dir = join(TEST_DIR, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const filePath = join(dir, file);
    const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
    mkdirSync(fileDir, { recursive: true });
    writeFileSync(filePath, content);
  }
  return dir;
}

describe('computeFingerprint', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('produces consistent hash for same inputs', () => {
    const evalDir = createEvalDir('eval-1', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    const fp1 = computeFingerprint(evalDir, baseConfig);
    const fp2 = computeFingerprint(evalDir, baseConfig);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  it('changes when eval file content changes', () => {
    const evalDir = createEvalDir('eval-2', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code v1',
      'package.json': '{"type":"module"}',
    });

    const fp1 = computeFingerprint(evalDir, baseConfig);

    writeFileSync(join(evalDir, 'EVAL.ts'), 'test code v2');
    const fp2 = computeFingerprint(evalDir, baseConfig);

    expect(fp1).not.toBe(fp2);
  });

  it('changes when config model changes', () => {
    const evalDir = createEvalDir('eval-3', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    const fp1 = computeFingerprint(evalDir, baseConfig);
    const fp2 = computeFingerprint(evalDir, { ...baseConfig, model: 'sonnet' });

    expect(fp1).not.toBe(fp2);
  });

  it('keeps agent-default policy equivalent to existing fingerprints', () => {
    const evalDir = createEvalDir('eval-policy-default', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    const fp1 = computeFingerprint(evalDir, baseConfig);
    const fp2 = computeFingerprint(evalDir, { ...baseConfig, modelPolicy: 'agent-default' });

    expect(fp1).toBe(fp2);
  });

  it('changes for native-default policy', () => {
    const evalDir = createEvalDir('eval-policy-native', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    const fp1 = computeFingerprint(evalDir, baseConfig);
    const fp2 = computeFingerprint(evalDir, { ...baseConfig, model: 'native-default', modelPolicy: 'native-default' });

    expect(fp1).not.toBe(fp2);
  });

  it('keeps webResearch-off equivalent to existing fingerprints', () => {
    const evalDir = createEvalDir('eval-research-default', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    const fp1 = computeFingerprint(evalDir, baseConfig);
    const fp2 = computeFingerprint(evalDir, { ...baseConfig, webResearch: false });
    const fp3 = computeFingerprint(evalDir, { ...baseConfig, webResearch: undefined });

    expect(fp1).toBe(fp2);
    expect(fp1).toBe(fp3);
  });

  it('changes when webResearch is enabled (research results must not be reused for parametric runs)', () => {
    const evalDir = createEvalDir('eval-research-on', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    const fp1 = computeFingerprint(evalDir, baseConfig);
    const fp2 = computeFingerprint(evalDir, { ...baseConfig, webResearch: true });

    expect(fp1).not.toBe(fp2);
  });

  it('versions the repaired Codex web research mechanism only when opted in', () => {
    const gateway = fingerprintConfigInput({
      ...baseConfig,
      agent: 'vercel-ai-gateway/codex',
      webResearch: true,
    });
    const direct = fingerprintConfigInput({ ...baseConfig, agent: 'codex', webResearch: true });
    const claude = fingerprintConfigInput({ ...baseConfig, webResearch: true });
    const codexParametric = fingerprintConfigInput({ ...baseConfig, agent: 'codex' });

    expect(gateway.agentFingerprint).toEqual({ webResearchProtocol: 'live-v1' });
    expect(direct.agentFingerprint).toEqual({ webResearchProtocol: 'live-v1' });
    expect(claude.agentFingerprint).toBeUndefined();
    expect(codexParametric.agentFingerprint).toBeUndefined();
  });

  it('creates a non-carryable compatibility fingerprint only for opt-in runtime behavior', () => {
    expect(computeReuseCompatibilityFingerprint(baseConfig)).toBeUndefined();
    expect(
      computeReuseCompatibilityFingerprint({ ...baseConfig, disableBundledSkills: true })
    ).toMatch(/^[a-f0-9]{64}$/);

    const legacyResearch = computeReuseCompatibilityFingerprint({
      ...baseConfig,
      webResearch: true,
    });
    const codexResearch = computeReuseCompatibilityFingerprint({
      ...baseConfig,
      agent: 'vercel-ai-gateway/codex',
      webResearch: true,
    });
    expect(legacyResearch).toMatch(/^[a-f0-9]{64}$/);
    expect(codexResearch).toMatch(/^[a-f0-9]{64}$/);
    expect(codexResearch).not.toBe(legacyResearch);
  });

  it('does not create a cache boundary when bundled skills are not applicable', () => {
    const opencode = {
      ...baseConfig,
      agent: 'vercel-ai-gateway/opencode',
      disableBundledSkills: true,
    };
    expect(fingerprintConfigInput(opencode).disableBundledSkills).toBeUndefined();
    expect(computeReuseCompatibilityFingerprint(opencode)).toBeUndefined();
  });

  it('creates a cache boundary when isolation applies to a pinned judge', () => {
    const opencodeWithClaudeJudge = {
      ...baseConfig,
      agent: 'vercel-ai-gateway/opencode',
      disableBundledSkills: true,
      judge: {
        agent: 'vercel-ai-gateway/claude-code',
        model: 'claude-opus-4-8',
      },
    };
    expect(fingerprintConfigInput(opencodeWithClaudeJudge).disableBundledSkills).toBe(true);
    expect(computeReuseCompatibilityFingerprint(opencodeWithClaudeJudge)).toMatch(
      /^[a-f0-9]{64}$/
    );
  });

  it('keeps bundled-skill defaults equivalent to existing fingerprints', () => {
    const evalDir = createEvalDir('eval-skills-default', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    const fp1 = computeFingerprint(evalDir, baseConfig);
    const fp2 = computeFingerprint(evalDir, { ...baseConfig, disableBundledSkills: false });
    const fp3 = computeFingerprint(evalDir, { ...baseConfig, disableBundledSkills: undefined });

    expect(fp1).toBe(fp2);
    expect(fp1).toBe(fp3);
  });

  it('changes when bundled skills are explicitly disabled', () => {
    const evalDir = createEvalDir('eval-skills-disabled', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    const fp1 = computeFingerprint(evalDir, baseConfig);
    const fp2 = computeFingerprint(evalDir, { ...baseConfig, disableBundledSkills: true });

    expect(fp1).not.toBe(fp2);
  });

  it('changes when config timeout changes', () => {
    const evalDir = createEvalDir('eval-4', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    const fp1 = computeFingerprint(evalDir, baseConfig);
    const fp2 = computeFingerprint(evalDir, { ...baseConfig, timeout: 1200 });

    expect(fp1).not.toBe(fp2);
  });

  it('is not affected by evals filter (only content matters)', () => {
    const evalDir = createEvalDir('eval-5', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    const fp1 = computeFingerprint(evalDir, { ...baseConfig, evals: '*' });
    const fp2 = computeFingerprint(evalDir, { ...baseConfig, evals: ['eval-5'] });

    expect(fp1).toBe(fp2);
  });

  it('ignores node_modules directory', () => {
    const evalDir = createEvalDir('eval-6', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    const fp1 = computeFingerprint(evalDir, baseConfig);

    // Add node_modules (should be ignored)
    mkdirSync(join(evalDir, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(join(evalDir, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = {}');

    const fp2 = computeFingerprint(evalDir, baseConfig);
    expect(fp1).toBe(fp2);
  });

  it('extending a model array does not invalidate existing models', () => {
    const evalDir = createEvalDir('eval-7', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    // Simulate how CLI expands model arrays: each model gets its own config
    const fpModelA = computeFingerprint(evalDir, { ...baseConfig, model: 'model-a' });
    const fpModelB = computeFingerprint(evalDir, { ...baseConfig, model: 'model-b' });

    // Adding model-c to the array doesn't change model-a or model-b fingerprints
    // (CLI would just create a new experiment for model-c)
    const fpModelAAfter = computeFingerprint(evalDir, { ...baseConfig, model: 'model-a' });
    const fpModelBAfter = computeFingerprint(evalDir, { ...baseConfig, model: 'model-b' });

    expect(fpModelA).toBe(fpModelAAfter);
    expect(fpModelB).toBe(fpModelBAfter);
    expect(fpModelA).not.toBe(fpModelB); // different models = different fingerprints
  });

  it('keeps unpinned-judge equivalent to existing fingerprints', () => {
    const evalDir = createEvalDir('eval-judge-default', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    // Cached results predate the judge field; an unpinned config must hash the same.
    const fp1 = computeFingerprint(evalDir, baseConfig);
    const fp2 = computeFingerprint(evalDir, { ...baseConfig, judge: undefined });

    expect(fp1).toBe(fp2);
  });

  it('changes when a judge is pinned (judged results must not reuse self-graded ones)', () => {
    const evalDir = createEvalDir('eval-judge-pinned', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    const fp1 = computeFingerprint(evalDir, baseConfig);
    const fp2 = computeFingerprint(evalDir, { ...baseConfig, judge: { model: 'claude-opus-4-8' } });

    expect(fp1).not.toBe(fp2);
  });

  it('changes when the judge model or agent changes', () => {
    const evalDir = createEvalDir('eval-judge-vary', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'test code',
      'package.json': '{"type":"module"}',
    });

    const opus = computeFingerprint(evalDir, { ...baseConfig, judge: { model: 'claude-opus-4-8' } });
    const sonnet = computeFingerprint(evalDir, { ...baseConfig, judge: { model: 'claude-sonnet-4-5' } });
    const opusGateway = computeFingerprint(evalDir, {
      ...baseConfig,
      judge: { agent: 'vercel-ai-gateway/claude-code', model: 'claude-opus-4-8' },
    });

    expect(opus).not.toBe(sonnet); // different judge model
    expect(opus).not.toBe(opusGateway); // different judge agent
  });
});

describe('computeContentFingerprint', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('is stable for the same eval files and changes when a file changes', () => {
    const evalDir = createEvalDir('content-1', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'v1',
      'package.json': '{"type":"module"}',
    });

    const a = computeContentFingerprint(evalDir);
    expect(computeContentFingerprint(evalDir)).toBe(a);
    expect(a).toMatch(/^[a-f0-9]{64}$/);

    writeFileSync(join(evalDir, 'EVAL.ts'), 'v2');
    expect(computeContentFingerprint(evalDir)).not.toBe(a);
  });

  it('is NOT affected by config — a timeout bump leaves the content fingerprint unchanged', () => {
    const evalDir = createEvalDir('content-2', {
      'PROMPT.md': 'Do something',
      'EVAL.ts': 'v1',
      'package.json': '{"type":"module"}',
    });

    // The combined fingerprint changes with timeout; the content one must not.
    const contentBefore = computeContentFingerprint(evalDir);
    const combinedA = computeFingerprint(evalDir, baseConfig);
    const combinedB = computeFingerprint(evalDir, { ...baseConfig, timeout: 1200 });

    expect(combinedA).not.toBe(combinedB); // config affects combined
    expect(computeContentFingerprint(evalDir)).toBe(contentBefore); // ...but not content
  });
});

describe('decideRefingerprint', () => {
  it('carries forward a config-only change (content unchanged)', () => {
    const d = decideRefingerprint(
      { fingerprint: 'old-combined', contentFingerprint: 'C' },
      { fingerprint: 'new-combined', contentFingerprint: 'C' }
    );
    expect(d).toEqual({ fingerprint: 'new-combined', stale: false });
  });

  it('is a no-op when nothing changed', () => {
    const d = decideRefingerprint(
      { fingerprint: 'same', contentFingerprint: 'C' },
      { fingerprint: 'same', contentFingerprint: 'C' }
    );
    expect(d).toEqual({ stale: false });
  });

  it('never carries results across an opt-in runtime compatibility boundary', () => {
    const d = decideRefingerprint(
      { fingerprint: 'old-combined', contentFingerprint: 'C' },
      {
        fingerprint: 'new-combined',
        contentFingerprint: 'C',
        reuseCompatibilityFingerprint: 'runtime-v1',
      }
    );
    expect(d).toEqual({ stale: true });
    expect(d.fingerprint).toBeUndefined();
  });

  it('leaves a changed eval STALE — never masks it', () => {
    const d = decideRefingerprint(
      { fingerprint: 'old-combined', contentFingerprint: 'C_old' },
      { fingerprint: 'new-combined', contentFingerprint: 'C_new' }
    );
    expect(d).toEqual({ stale: true });
    expect(d.fingerprint).toBeUndefined(); // not re-stamped
  });

  it('legacy result (no content fp): adopts content fp only when already fully current', () => {
    const current = decideRefingerprint(
      { fingerprint: 'X' },
      { fingerprint: 'X', contentFingerprint: 'C' }
    );
    expect(current).toEqual({ contentFingerprint: 'C', stale: false });

    const behind = decideRefingerprint(
      { fingerprint: 'X_old' },
      { fingerprint: 'X_new', contentFingerprint: 'C' }
    );
    expect(behind).toEqual({ stale: true });
  });
});
