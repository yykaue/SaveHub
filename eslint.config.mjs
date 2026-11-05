import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/**', 'dist/**', 'release/**', '.test-data/**', 'docs/screenshots/**'] },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'off', // TypeScript/checkJs checks names in typed source and the preload.
      'no-unused-vars': 'off',
      'no-control-regex': 'off', // Filesystem path validation deliberately rejects control bytes.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-constant-binary-expression': 'error',
      'constructor-super': 'error',
    },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
];
