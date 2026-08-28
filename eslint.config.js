const expoConfig = require('eslint-config-expo/flat');
const { defineConfig, globalIgnores } = require('eslint/config');

module.exports = defineConfig([
  expoConfig,
  globalIgnores([
    'dist/**',
    'dist-*/**',
    '.tmp-*/**',
    'node_modules/**',
    '.expo/**',
    'android/**',
    'ios/**',
    'coverage/**',
    'expo-env.d.ts',
  ]),
  {
    // eslint-config-expo leaves this as 'detect', and eslint-plugin-react's
    // detection path calls `context.getFilename()`, which ESLint 10 removed —
    // it throws before linting a single file. Naming the version explicitly
    // skips detection entirely. Keep in step with the `react` dependency; a
    // stale value only changes which version-gated React rules fire.
    settings: { react: { version: '19.2' } },
    rules: {
      // The gateway's own error text is the whole point of the debug log, so
      // console calls funnel through src/lib/log.ts rather than being banned.
      'no-console': 'off',
      // `expo/fetch` and `expo-router` subpaths are resolved by Metro, not by
      // eslint-plugin-import's node resolver.
      'import/no-unresolved': 'off',
    },
  },
  {
    // Scoped to TypeScript: eslint-config-expo registers the @typescript-eslint
    // plugin only in its own TS-scoped object, and a flat-config rule can only
    // name a plugin that is in scope for the same files.
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Expo's default passes `args: 'none'`, which never flags an unused
      // parameter. Tightened to flag them unless deliberately named with `_`.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    languageOptions: {
      globals: {
        jest: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
  },
]);
