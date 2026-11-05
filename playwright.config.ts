import { defineConfig } from '@playwright/test';
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
