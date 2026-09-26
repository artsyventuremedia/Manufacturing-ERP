// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**', '**/*.cjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // ADR-0008: money and quantity must never be JS numbers in domain code.
    files: ['modules/*/src/domain/**/*.ts', 'packages/kernel/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'TSPropertySignature[key.name=/(amount|Amount|qty|Qty|quantity|Quantity|price|Price|rate|Rate)$/] > TSTypeAnnotation > TSNumberKeyword',
          message:
            'Money/quantity fields must use Money/Quantity/Decimal, never number (ADR-0008).',
        },
        {
          selector:
            'PropertyDefinition[key.name=/(amount|Amount|qty|Qty|quantity|Quantity|price|Price|rate|Rate)$/] > TSTypeAnnotation > TSNumberKeyword',
          message:
            'Money/quantity fields must use Money/Quantity/Decimal, never number (ADR-0008).',
        },
      ],
    },
  },
  {
    // NestJS relies on decorator metadata: DI classes must be value imports.
    files: ['apps/core/src/**/*.ts', 'packages/http/src/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    // Tool configs are outside package tsconfigs; lint them without type information.
    files: ['**/vitest*.ts', '*.config.js', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
