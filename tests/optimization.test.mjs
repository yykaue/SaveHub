/**
 * 性能与体验优化专项测试套件：
 * 覆盖流式进度上报、摘要缓存复用、无保护冲突覆盖、IPC 参数白名单与分级日志等场景。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { SaveStore, atomicJson, within } from '../electron/storage.mjs';
import { Logger } from '../electron/logger.mjs';
import { validArguments } from '../shared/ipc-schema.mjs';

async function fixture(t) {
  const root = path.resolve('.test-data');
  await fs.mkdir(root, { recursive: true });
  const base = await fs.mkdtemp(path.join(root, 'optimization-'));
  const source = path.join(base, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'save.dat'), Buffer.alloc(2 * 1024 * 1024, 65));
  const store = await new SaveStore(path.join(base, 'data')).init();
  const input = {
    name: '优化测试',
    locations: {
      win32: { root: source, items: ['save.dat'] },
      darwin: { root: source, items: ['save.dat'] },
    },
  };
  const gameId = await store.upsertGame(input);
  const target = await new SaveStore(path.join(base, 'target')).init();
  const targetId = await target.upsertGame(input);
  const destination = path.join(base, 'export');
  await fs.mkdir(destination);
  t.after(async () => {
    await Promise.all([store.logger.queue, target.logger.queue]);
    assert(within(root, base) && root !== base);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  });
  return { base, source, store, input, gameId, target, targetId, destination };
}

async function logFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? logFiles(file) : [file];
      }),
    )
  ).flat();
}

test('unprotected favorite, trash, active and removed restore point conflicts can overwrite and keep local states', async (t) => {
  const f = await fixture(t);
  const first = await f.target.importLegacy(f.targetId, f.source);
  assert.equal(first.imported.length, 1);
  const [saved] = await f.target.snapshots(f.targetId);
  for (const state of [
    { kind: 'imported', favorite: true },
    { kind: 'imported', favorite: true, deletedAt: '2024-01-01T00:00:00.000Z' },
    { kind: 'safety', favorite: false },
    { kind: 'safety', favorite: true, deletedAt: '2024-01-02T00:00:00.000Z' },
  ]) {
    const original = await f.target.readSnapshot(f.targetId, saved.id);
    delete original.deletedAt;
    Object.assign(original, state);
    await atomicJson(path.join(f.target.snapshotDir(f.targetId, saved.id), 'manifest.json'), original);
    f.target.invalidateSnapshotCache(f.targetId, saved.id);
    await fs.writeFile(path.join(f.source, 'save.dat'), JSON.stringify(state));
    const plan = await f.target.prepareImport(f.targetId, f.source);
    const report = await f.target.executeImport(plan.id, [
      { itemId: plan.items[0].id, action: 'overwrite', targetId: saved.id },
    ]);
    assert.equal(report.overwritten.length, 1);
    assert.deepEqual(report.failed, []);
    const updated = await f.target.verify(f.targetId, saved.id);
    for (const key of ['id', 'createdAt', 'kind', 'favorite', 'deletedAt']) assert.equal(updated[key], original[key]);
    assert.equal(
      await fs.readFile(path.join(f.target.snapshotDir(f.targetId, saved.id), 'payload/save.dat'), 'utf8'),
      JSON.stringify(state),
    );
  }
});

for (const limits of [
  { active: 2, removed: 2 },
  { active: 0, removed: 0 },
  { active: 2, removed: 0 },
]) {
  test(`standalone restore point imports finish the whole batch before retention ${limits.active}/${limits.removed}`, async (t) => {
    const f = await fixture(t);
    const ids = [];
    for (let i = 0; i < 8; i++) {
      const meta = await f.store.capture(f.store.game(f.gameId), f.source, ['save.dat'], {
        label: `point-${i}`,
        kind: 'safety',
        metadata: {
          createdAt: `2020-01-0${i + 1}T00:00:00.000Z`,
          updatedAt: `2021-01-0${i + 1}T00:00:00.000Z`,
          ...(i >= 4 ? { deletedAt: '2022-01-01T00:00:00.000Z' } : {}),
        },
      });
      ids.push(meta.id);
    }
    const exported = await f.store.exportSnapshots(f.gameId, ids, f.destination);
    await f.target.setRestorePointRetention(limits);
    let beforePrune;
    f.target.fault = async (phase) => {
      if (phase === 'before-retention') beforePrune = await f.target.snapshots(f.targetId, true);
    };
    const plan = await f.target.prepareImport(f.targetId, exported.folder);
    const report = await f.target.executeImport(plan.id, []);
    assert.equal(report.imported.length, 8);
    assert.deepEqual(report.failed, []);
    assert.equal(beforePrune.length, 8, 'Every record must exist before maintenance');
    assert.equal(beforePrune.filter((p) => p.deletedAt).length, 4);
    const kept = await f.target.snapshots(f.targetId, true);
    assert.equal(kept.filter((p) => !p.deletedAt).length, limits.active);
    assert.equal(kept.filter((p) => p.deletedAt).length, limits.removed);
    if (limits.active)
      assert.deepEqual(
        kept
          .filter((p) => !p.deletedAt)
          .map((p) => p.label)
          .sort(),
        ['point-2', 'point-3'],
      );
    if (limits.removed)
      assert.deepEqual(
        kept
          .filter((p) => p.deletedAt)
          .map((p) => p.label)
          .sort(),
        ['point-6', 'point-7'],
      );
  });
}

test('combined game imports apply new limits only after all games and restore points have committed', async (t) => {
  const f = await fixture(t);
  const secondId = await f.store.upsertGame({ ...f.input, name: '第二个游戏' });
  for (const id of [f.gameId, secondId]) {
    await f.store.upsertGame({ ...f.store.game(id), restorePointRetention: { active: 0, removed: 0 } });
    for (let i = 0; i < 2; i++)
      await f.store.capture(f.store.game(id), f.source, ['save.dat'], {
        label: `point-${i}`,
        kind: 'safety',
      });
  }
  const exported = await f.store.exportGames([f.gameId, secondId], f.destination, true);
  const plan = await f.target.prepareGameImport(exported.folder);
  const review = await f.target.reviewGameImport(
    plan.id,
    plan.items
      .filter((item) => item.matches.length)
      .map((item) => ({ itemId: item.id, action: 'overwrite', targetId: item.matches[0].id })),
  );
  let firstPrune = true;
  f.target.fault = async (phase) => {
    if (phase !== 'before-retention' || !firstPrune) return;
    firstPrune = false;
    assert.equal(f.target.config.games.length, 2);
    for (const game of f.target.config.games) assert.equal((await f.target.snapshots(game.id, true)).length, 2);
  };
  const report = await f.target.executeGameImport(
    review.id,
    review.games.map((game) => ({ itemId: game.itemId, decisions: [] })),
  );
  assert(!firstPrune);
  assert.deepEqual(report.games.failed, []);
  assert(report.snapshots.every((entry) => entry.report.imported.length === 2 && !entry.report.failed.length));
  for (const game of f.target.config.games) assert.deepEqual(await f.target.snapshots(game.id, true), []);
});

test('import/export progress is monotonic across files, records and games and finishes at 100', async (t) => {
  const f = await fixture(t);
  const snapshots = [];
  for (let i = 0; i < 2; i++) snapshots.push(await f.store.createSnapshot(f.gameId, { label: `save-${i}` }));
  const capture = async (store, action) => {
    const values = [];
    store.onProgress = (p) => {
      if (p) values.push(p);
    };
    const result = await action();
    const percents = values.map((p) => p.percent ?? (p.total ? (100 * p.completed) / p.total : 0));
    assert(percents.length >= 2);
    assert.equal(percents[0], 0);
    assert.equal(percents.at(-1), 100);
    for (let i = 1; i < percents.length; i++)
      assert(percents[i] >= percents[i - 1], `${percents[i - 1]} -> ${percents[i]}`);
    return { result, values };
  };
  const exported = await capture(f.store, () =>
    f.store.exportSnapshots(
      f.gameId,
      snapshots.map((p) => p.id),
      f.destination,
    ),
  );
  assert(exported.values.some((p) => p.phase === 'copying' && p.percent > 20 && p.percent < 50));
  const plan = (await capture(f.target, () => f.target.prepareImport(f.targetId, exported.result.folder))).result;
  await capture(f.target, () => f.target.executeImport(plan.id, []));
  const bundle = (await capture(f.store, () => f.store.exportGames([f.gameId], f.destination, true))).result;
  const gamePlan = (await capture(f.target, () => f.target.prepareGameImport(bundle.folder))).result;
  const review = (
    await capture(f.target, () =>
      f.target.reviewGameImport(
        gamePlan.id,
        gamePlan.items.map((p) => ({ itemId: p.id, action: 'overwrite', targetId: f.targetId })),
      ),
    )
  ).result;
  await capture(f.target, () =>
    f.target.executeGameImport(
      review.id,
      review.games
        .filter((g) => g.snapshots)
        .map((g) => ({
          itemId: g.itemId,
          decisions: g.snapshots.items.filter((p) => p.matches.length).map((p) => ({ itemId: p.id, action: 'skip' })),
        })),
    ),
  );
});

test('log settings default and migrate to 20 MB, persist zero across restart, and reject invalid input', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.store.state()).logLimitMB, 20);
  const oldConfig = JSON.parse(await fs.readFile(f.store.configFile, 'utf8'));
  delete oldConfig.logLimitMB;
  await atomicJson(f.store.configFile, oldConfig);
  const migrated = await new SaveStore(f.store.dataDir).init();
  assert.equal((await migrated.state()).logLimitMB, 20);
  assert.equal(JSON.parse(await fs.readFile(migrated.configFile, 'utf8')).logLimitMB, 20);
  for (const value of [-1, 1.5, NaN, Infinity, '0', null, Number.MAX_SAFE_INTEGER]) {
    assert(!validArguments('setLogLimitMB', [value]));
    await assert.rejects(migrated.setLogLimitMB(value));
  }
  assert(validArguments('setLogLimitMB', [0]));
  await migrated.setLogLimitMB(1);
  assert.equal(migrated.logger.maxBytes, 1024 * 1024);
  await migrated.setLogLimitMB(0);
  await migrated.logger.error('should-not-be-stored');
  assert.deepEqual(await logFiles(migrated.logger.logDir), []);
  assert.equal(migrated.logger.entries.length, 0);
  const resumed = await new SaveStore(migrated.dataDir).init();
  assert.equal((await resumed.state()).logLimitMB, 0);
  await resumed.logger.run('capture', async () => 42);
  assert.deepEqual(await logFiles(resumed.logger.logDir), []);
  await resumed.setLogLimitMB(3);
  await resumed.logger.info('enabled-again');
  assert((await logFiles(resumed.logger.logDir)).length > 0);
  assert.equal((await new SaveStore(resumed.dataDir).init()).config.logLimitMB, 3);
});

test('changing log budgets trims old data immediately, zero clears legacy/current logs and pending writes', async (t) => {
  const f = await fixture(t);
  const logger = new Logger(path.join(f.base, 'log-only'));
  await fs.mkdir(logger.dataDir);
  for (let i = 0; i < 8; i++) await logger.info(`event-${i}`, { text: '界'.repeat(100) });
  await logger.setMaxBytes(1000);
  const size = async () =>
    (await Promise.all((await logFiles(logger.logDir)).map(async (file) => (await fs.stat(file)).size))).reduce(
      (a, b) => a + b,
      0,
    );
  assert((await size()) <= 1000);
  await Promise.all([logger.info('before-disable'), logger.setMaxBytes(0), logger.warn('after-disable')]);
  assert.equal(await size(), 0);
  assert.deepEqual(logger.entries, []);
  await fs.writeFile(path.join(logger.logDir, 'savehub.1.log'), '{"event":"legacy"}\n');
  const disabled = new Logger(logger.dataDir);
  await disabled.setMaxBytes(0);
  assert.deepEqual(await logFiles(logger.logDir), []);
  await disabled.setMaxBytes(1);
  await disabled.error('oversized-entry');
  assert.equal(await size(), 0, 'Even a single log line cannot exceed the limit');
});
