/**
 * Eval fixture discovery and validation.
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import type { EvalFixture, ValidationMode } from './types.js';
import { REQUIRED_EVAL_FILES, EXCLUDED_FILES } from './types.js';

export interface FixtureLoadOptions {
  validation?: ValidationMode;
}

/**
 * Error thrown when an eval fixture is invalid.
 */
export class FixtureValidationError extends Error {
  constructor(
    public fixtureName: string,
    message: string
  ) {
    super(`Eval "${fixtureName}": ${message}`);
    this.name = 'FixtureValidationError';
  }
}

/**
 * Check if a file exists with exact case match (case-sensitive even on Mac/Windows).
 * Returns true only if the file exists AND the case matches exactly.
 */
function existsWithExactCase(dirPath: string, fileName: string): boolean {
  try {
    const files = readdirSync(dirPath);
    return files.includes(fileName);
  } catch {
    return false;
  }
}

/**
 * Discovers all eval fixtures in a directory.
 * Recursively searches for directories containing PROMPT.md.
 * Supports nested organization like "vercel-cli/deploy" or "flags/create-flag".
 */
export function discoverFixtures(evalsDir: string): string[] {
  const absolutePath = resolve(evalsDir);

  if (!existsSync(absolutePath)) {
    throw new Error(`Evals directory not found: ${absolutePath}`);
  }

  const fixtures: string[] = [];

  function walk(dir: string, basePath: string = '') {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      // Skip hidden directories and files
      if (entry.startsWith('.')) {
        continue;
      }

      const entryPath = join(dir, entry);
      
      // Only consider directories
      if (!statSync(entryPath).isDirectory()) {
        continue;
      }

      const relativePath = basePath ? `${basePath}/${entry}` : entry;

      // Check if this directory contains PROMPT.md (potential fixture)
      if (existsWithExactCase(entryPath, 'PROMPT.md')) {
        fixtures.push(relativePath);
      } else {
        // Not a fixture directory, recurse into it
        walk(entryPath, relativePath);
      }
    }
  }

  walk(absolutePath);
  return fixtures.sort();
}

/**
 * Validates that a fixture has all required files with correct case.
 * Returns an array of missing file names, or empty array if valid.
 * Note: Accepts either EVAL.ts or EVAL.tsx for the eval file.
 * Case-sensitive: 'prompt.md' will fail even on Mac/Windows.
 */
export function validateFixtureFiles(
  fixturePath: string,
  options: FixtureLoadOptions = {}
): string[] {
  const missing: string[] = [];
  const validation = options.validation ?? 'vitest';

  for (const file of REQUIRED_EVAL_FILES) {
    // Special case: Accept either EVAL.ts or EVAL.tsx (both case-sensitive)
    if (file === 'EVAL.ts') {
      if (validation === 'none') {
        continue;
      }
      const hasEvalTs = existsWithExactCase(fixturePath, 'EVAL.ts');
      const hasEvalTsx = existsWithExactCase(fixturePath, 'EVAL.tsx');
      if (!hasEvalTs && !hasEvalTsx) {
        missing.push('EVAL.ts or EVAL.tsx');
      }
    } else {
      if (!existsWithExactCase(fixturePath, file)) {
        missing.push(file);
      }
    }
  }

  return missing;
}

/**
 * Validates the package.json of a fixture.
 * Ensures it has "type": "module".
 */
export function validatePackageJson(fixturePath: string): { isModule: boolean; error?: string } {
  const packageJsonPath = join(fixturePath, 'package.json');

  try {
    const content = readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content);

    if (pkg.type !== 'module') {
      return {
        isModule: false,
        error: 'package.json must have "type": "module"',
      };
    }

    return { isModule: true };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        isModule: false,
        error: 'package.json is not valid JSON',
      };
    }
    throw error;
  }
}

/**
 * Loads a single eval fixture with full validation.
 */
export function loadFixture(
  evalsDir: string,
  name: string,
  options: FixtureLoadOptions = {}
): EvalFixture {
  const fixturePath = resolve(evalsDir, name);

  if (!existsSync(fixturePath)) {
    throw new FixtureValidationError(name, `Directory not found: ${fixturePath}`);
  }

  // Validate required files
  const missingFiles = validateFixtureFiles(fixturePath, options);
  if (missingFiles.length > 0) {
    throw new FixtureValidationError(
      name,
      `Missing required files: ${missingFiles.join(', ')}`
    );
  }

  // Validate package.json
  const pkgValidation = validatePackageJson(fixturePath);
  if (pkgValidation.error) {
    throw new FixtureValidationError(name, pkgValidation.error);
  }

  // Read prompt (case-sensitive check)
  if (!existsWithExactCase(fixturePath, 'PROMPT.md')) {
    throw new FixtureValidationError(name, 'PROMPT.md not found (case-sensitive: must be uppercase)');
  }
  const promptPath = join(fixturePath, 'PROMPT.md');
  const prompt = readFileSync(promptPath, 'utf-8');

  return {
    name,
    path: fixturePath,
    prompt,
    isModule: pkgValidation.isModule,
  };
}

/**
 * Discovers and loads all valid eval fixtures from a directory.
 * Returns both valid fixtures and any validation errors encountered.
 */
export function loadAllFixtures(
  evalsDir: string,
  options: FixtureLoadOptions = {}
): {
  fixtures: EvalFixture[];
  errors: FixtureValidationError[];
} {
  const fixtureNames = discoverFixtures(evalsDir);
  const fixtures: EvalFixture[] = [];
  const errors: FixtureValidationError[] = [];

  for (const name of fixtureNames) {
    try {
      const fixture = loadFixture(evalsDir, name, options);
      fixtures.push(fixture);
    } catch (error) {
      if (error instanceof FixtureValidationError) {
        errors.push(error);
      } else {
        throw error;
      }
    }
  }

  return { fixtures, errors };
}

/**
 * Gets a list of all files in a fixture directory.
 * Excludes PROMPT.md, EVAL.ts, node_modules, and .git.
 */
export function getFixtureFiles(
  fixturePath: string,
  excludePatterns: readonly string[] = EXCLUDED_FILES
): string[] {
  const files: string[] = [];

  function walk(dir: string, basePath: string = '') {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const relativePath = basePath ? `${basePath}/${entry}` : entry;

      // Check if should be excluded
      if (excludePatterns.some((pattern) => relativePath === pattern || entry === pattern)) {
        continue;
      }

      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath, relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walk(fixturePath);
  return files.sort();
}

/**
 * Reads all fixture files into a map.
 * Keys are relative paths, values are raw file contents (never decoded, so
 * binary fixture assets survive the round trip).
 */
export function readFixtureFiles(
  fixturePath: string,
  excludePatterns?: readonly string[]
): Map<string, Buffer> {
  const files = getFixtureFiles(fixturePath, excludePatterns);
  const contents = new Map<string, Buffer>();

  for (const file of files) {
    const fullPath = join(fixturePath, file);
    contents.set(file, readFileSync(fullPath));
  }

  return contents;
}

/**
 * Copies all fixture files into `destPath`, preserving relative layout.
 *
 * Prefer this over `readFixtureFiles` + `writeFileSync` when the destination is
 * the filesystem: the bytes never enter the heap, so there is no encoding to get
 * wrong and no need to hold an entire fixture tree in memory at once.
 */
export function copyFixtureFiles(
  fixturePath: string,
  destPath: string,
  excludePatterns?: readonly string[]
): void {
  for (const file of getFixtureFiles(fixturePath, excludePatterns)) {
    const fullPath = join(destPath, file);
    mkdirSync(dirname(fullPath), { recursive: true });
    copyFileSync(join(fixturePath, file), fullPath);
  }
}
