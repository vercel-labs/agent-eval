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
    // Injected sandbox runtime: plain JS that runs on Node (fetch + process globals).
    files: ['src/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', fetch: 'readonly', console: 'readonly' },
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
