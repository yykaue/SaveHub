import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// ESLint 扁平化规则配置（覆盖前端 TS/TSX、Electron 主进程 MJS/CJS 及脚本测试）
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
      'no-undef': 'off', // 由 TypeScript / checkJs 负责类型化源码与 preload 的全局标识符检查
      'no-unused-vars': 'off',
      'no-control-regex': 'off', // 文件系统路径安全校验需要主动匹配并拒绝控制字符
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-constant-binary-expression': 'error',
      'constructor-super': 'error',
    },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
];
