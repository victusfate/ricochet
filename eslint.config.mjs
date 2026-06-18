// scaffold-linter: ts sha256:7186527489b1
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Type-aware TypeScript linting. `projectService: true` lets typescript-eslint
// discover this repo's tsconfig.json (shipped alongside this config) and build a
// program per file, so type-checked rules work without a brittle `project` path.
// Plain .js/.mjs/.cjs files fall through to the JS recommended set.
export default tseslint.config(
  {
    ignores: [
      // scaffold-vendored tooling synced into consumer repos — and crucially
      // lib/linters/**, whose template configs would otherwise be discovered as
      // a second eslint root. Drop tools/** if you keep your own code there.
      'lib/linters/**',
      'tools/**',
      '**/*.scaffold-new',
      // Common build output — safe defaults; adjust per repo in the tune step.
      'dist/**',
      'build/**',
      'coverage/**',
      // repo tune: tooling/config + dev scripts live outside src/**, the only
      // path in this repo's tsconfig include, so they aren't in a TS program.
      // Linting targets product code under src/.
      '*.config.ts',
      '*.config.mts',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      // Node + browser globals so console/process/window aren't flagged no-undef.
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // scaffold quality thresholds — mirror the four-dimension rubric
      'max-lines': ['warn', { max: 500 }],
      'max-params': ['warn', 4],
      'complexity': ['warn', 10],
      'no-magic-numbers': ['warn', { ignore: [0, 1], ignoreArrayIndexes: true }],
      // repo tune: typescript-eslint's parser resolves Cloudflare/vitest ambient
      // types differently than tsc, so this rule's autofix strips `as` assertions
      // that tsc actually requires (e.g. `await res.json() as T`). tsc --strict is
      // authoritative for redundant assertions; defer to it and disable here.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  {
    // Type-aware rules need a program; config and JS files aren't in one.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
