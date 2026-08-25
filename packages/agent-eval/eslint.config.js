import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // In-sandbox agent runners: plain ESM JS that runs on Node, so the Node
    // globals (process) are available. Everything else they use is imported
    // from node:* builtins.
    files: ['src/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    // Hand-authored declaration files (e.g. eval-helper.d.mts) augment upstream
    // interfaces — `declare module 'vitest'` must mirror Vitest's exact
    // `Assertion<T = any>` signature for the merge to apply, so the `any` and the
    // otherwise-unused type parameter are unavoidable, not accidental.
    files: ['src/**/*.d.mts', 'src/**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
