import js from '@eslint/js';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { globalIgnores } from 'eslint/config';

export default tseslint.config([
  // `docs/` is its own package — its own pnpm-workspace.yaml, its own lockfile,
  // its own tsconfig via Astro's generated `.astro/types.d.ts` (see
  // docs/pnpm-workspace.yaml for why it is isolated). `projectService` below
  // resolves every *.ts/*.tsx it finds against *this* tsconfig, which docs'
  // files were never part of, hence the parse errors. Same reasoning as
  // excluding `node_modules`: a directory that manages its own toolchain.
  // `packages/*/dist` is each package's build output (plan.md §H3), generated and not hand-written.
  globalIgnores(['dist', 'packages/*/dist', 'node_modules', 'docs']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      reactHooks.configs.flat['recommended-latest'],
      reactRefresh.configs.vite,
      // plan.md §14.2. A regression net over the accessibility work already
      // done, not a compliance claim: automated tooling catches 30–57% of WCAG
      // failures (§8), so the manual contrast sweep stays the real check.
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `_name` marks a parameter kept for the signature but not yet used.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The engine must stay pure: no DOM, no React, no async. Enforced by review + this fence.
    files: ['src/engine/**/*.ts'],
    languageOptions: { globals: {} },
  },
]);
