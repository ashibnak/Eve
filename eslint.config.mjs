import i18next from 'eslint-plugin-i18next';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import eve from './tools/eslint/no-physical-tailwind.mjs';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/src/generated/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'docs/**',
      'tools/boundaries/__fixtures__/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    // Nest relies on runtime class references for DI; type-only import rewriting would break it.
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, eve, i18next },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'eve/no-physical-tailwind': 'error',
      // UI text lives only in i18n/*.json (CLAUDE.md); flag literal strings in JSX.
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-only',
          // Technical attributes, never shown to people. Visible text (labels, aria-label,
          // title, placeholder, alt) must come from i18n.
          'jsx-attributes': {
            exclude: [
              'className',
              'style',
              'type',
              'key',
              'id',
              'htmlFor',
              'role',
              'dir',
              'variant',
              'autoComplete',
              'inputMode',
              'data-testid',
              // Accessibility states and in-app routes, never shown to people.
              'aria-hidden',
              'aria-current',
              'to',
            ],
          },
        },
      ],
    },
  },
);
