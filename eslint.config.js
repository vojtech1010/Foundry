import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

import architecture from './eslint/architecture.js';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.agent/**',
      '.agents/**',
      'tools/oxlint/anti-slop/**',
      'tests/fixtures/**',
      'eslint.config.js',
      'eslint/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    plugins: {
      foundry: architecture,
    },
    rules: {
      'foundry/no-forbidden-slice-import': 'error',
      'foundry/no-cross-slice-internal': 'error',
      'foundry/no-direct-fs-import': 'error',
    },
  },
);
