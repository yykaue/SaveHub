import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect } from '@playwright/test';
import { SaveStore, atomicJson } from '../electron/storage.mjs';
import { runE2E } from './e2e-harness.mjs';

const percentile = (values) => {
  const ordered = [...values].sort((a, b) => a - b);
  return { p50: ordered[Math.floor(ordered.length / 2)], p95: ordered.at(-1), samples: values };
};

await runE2E('benchmark-ui', async (harness) => {
  const live = path.join(harness.base, 'live');
  await fs.mkdir(live);
  await fs.writeFile(path.join(live, 'save.dat'), 'benchmark');
  const store = await new SaveStore(path.join(harness.base, 'data')).init();
  const counts = [100, 1000, 10000];
  for (const count of counts) {
    const gameId = await store.upsertGame({
      name: `Benchmark ${count}`,
      locations: { win32: { root: live, items: ['save.dat'] }, darwin: { root: live, items: ['save.dat'] } },
    });
    const seed = await store.capture(store.game(gameId), live, ['save.dat'], { label: `needle-${count}` });
    for (let i = 1; i < count; i++) {
      const id = randomUUID();
      await atomicJson(path.join(store.snapshotDir(gameId, id), 'manifest.json'), {
        ...seed,
        id,
        label: `record-${i}`,
      });
    }
  }
  const application = await harness.launch(store.dataDir);
  const page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  const pick = (count) =>
    page
      .getByRole('navigation', { name: '游戏列表', exact: true })
      .getByRole('button', { name: new RegExp(`^Benchmark ${count}\\b`) })
      .click();
  const rows = page.locator('.snapshot-row');
  const search = page.getByRole('textbox', { name: '搜索存档', exact: true });
  const painted = () =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const timed = async (action) => {
    const start = performance.now();
    await action();
    await painted();
    return performance.now() - start;
  };
  const results = [];
  await page.getByRole('button', { name: /^存档库/ }).click();
  for (const count of counts) {
    const switching = [],
      searching = [],
      scrolling = [],
      paging = [];
    for (let i = 0; i < 5; i++) {
      await pick(count === 100 ? 1000 : 100);
      switching.push(
        await timed(async () => {
          await pick(count);
          await expect(page.locator('.hero-title h2')).toHaveText(`Benchmark ${count}`);
          await expect(rows).toHaveCount(100);
        }),
      );
      searching.push(
        await timed(async () => {
          await search.fill(`needle-${count}`);
          await expect(rows).toHaveCount(1);
          await expect(rows.first()).toContainText(`needle-${count}`);
        }),
      );
      await search.fill('');
      await expect(rows).toHaveCount(100);
      scrolling.push(
        await page.locator('main').evaluate(async (element) => {
          element.scrollTop = 0;
          await new Promise(requestAnimationFrame);
          const start = performance.now();
          element.scrollTop = element.scrollHeight;
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          if (element.scrollTop <= 0) throw new Error('Expected scrollable list');
          return performance.now() - start;
        }),
      );
      if (count > 100) {
        const firstId = await rows.first().getAttribute('data-snapshot-id');
        paging.push(
          await timed(async () => {
            await page.locator('.pagination button').last().click();
            await expect(rows.first()).not.toHaveAttribute('data-snapshot-id', firstId);
            await expect(rows).toHaveCount(100);
          }),
        );
        await page.locator('.pagination button').first().click();
        await expect(rows.first()).toHaveAttribute('data-snapshot-id', firstId);
      }
    }
    assert.equal(await rows.count(), 100);
    results.push({
      count,
      domRows: await rows.count(),
      switchingMs: percentile(switching),
      searchMs: percentile(searching),
      scrollTwoFramesMs: percentile(scrolling),
      nextPageMs: paging.length ? percentile(paging) : null,
    });
    harness.done(`${count} summaries: navigation, full-list search, scrolling and bounded 100-row rendering verified`);
  }
  const target = await application.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    platform: process.platform,
    arch: process.arch,
  }));
  const report = {
    date: new Date().toISOString(),
    target,
    notes: [
      'Valid metadata-only fixtures; only each seed has payload. No file operation is performed on the cloned summaries.',
      'Five samples per scale; p95 is the maximum of five samples, not a statistical performance guarantee.',
      'Switch/search/page times include Playwright action and assertion overhead plus two animation frames; tracing remains enabled.',
      'Scroll time is programmatic scrolling followed by two frames, not an FPS or physical input latency measurement.',
    ],
    results,
  };
  await atomicJson(path.join(harness.screenshots, 'benchmark.json'), report);
  await atomicJson('test-results/benchmark-ui.json', report);
  console.log(JSON.stringify(report, null, 2));
});
