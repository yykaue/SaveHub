import { defineConfig } from '@playwright/test';

// Playwright 桌面端 E2E 测试配置（单 Worker 串行执行 Electron 窗口测试）
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 300000,
  workers: 1,
  fullyParallel: false,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: `${process.env.SAVEHUB_ARTIFACT_ROOT || 'test-results/source'}/report` }],
  ],
  outputDir: `${process.env.SAVEHUB_ARTIFACT_ROOT || 'test-results/source'}/runner`,
});
