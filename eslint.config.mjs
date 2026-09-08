import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      '.superpowers/**',
      '.worktrees/**',
      'data/**',
      'backups/**',
      'logs/**',
      '*-report/**',
      'reports/**',
      'test-results/**',
      'coverage/**',
      '.cache/**',
      '.codex-log/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['public/*.js'],
    languageOptions: { globals: globals.browser, sourceType: 'script' },
  },
  {
    files: ['tests/e2e/*.mjs'],
    languageOptions: { globals: globals.browser },
  },
  {
    rules: {
      // Storage access is best effort when browser privacy settings deny it.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },
];
