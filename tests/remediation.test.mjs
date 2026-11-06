import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { SaveStore, atomicJson, within } from '../electron/storage.mjs';
import { assertDiskSpace, assertDiskBudgets, exportName, withinOnDisk } from '../electron/fs-utils.mjs';
import { Logger, MAX_LOG_BYTES } from '../electron/logger.mjs';
import { validArguments, IPC_SCHEMA } from '../shared/ipc-schema.mjs';
import { publicIcon, iconResponse } from '../electron/game-icons.mjs';
import { runE2E } from '../scripts/e2e-harness.mjs';

test('unidentified corrupt transactions retain safety dependencies under 0/0 across restarts', async (t) => {
  const f = await fixture(t),
    point = await f.safety(1);
  f.store.config.restorePointRetention = { active: 0, removed: 0 };
  await f.store.saveConfig();
  const folder = path.join(f.store.dataDir, 'transactions');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'unknown.json'), '{');
  for (let restart = 0; restart < 2; restart++) {
    const reopened = await new SaveStore(f.store.dataDir).init();
    assert(reopened.retentionDeferred.has(f.id));
    assert.equal((await reopened.readSnapshot(f.id, point.id)).id, point.id);
  }
});

test('E2E evidence failure never replaces the original business assertion', async () => {
  const original = new Error('original-business-failure');
  const write = fs.writeFile;
  fs.writeFile = async (file, ...args) => {
    if (String(file).endsWith('run.json')) throw new Error('injected-report-failure');
    return write(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      runE2E('harness-fault', async () => {
        throw original;
      }),
      (error) => error === original,
    );
  } finally {
    fs.writeFile = write;
    syncBuiltinESMExports();
  }
});

test('a nonexistent requested E2E executable is rejected without source fallback', async () => {
  const previous = process.env.SAVEHUB_TEST_EXECUTABLE;
  process.env.SAVEHUB_TEST_EXECUTABLE = path.resolve('.test-data', 'does-not-exist.exe');
  try {
    await assert.rejects(
      runE2E('invalid-target', async (harness) => {
        await harness.launch(path.join(harness.base, 'data'));
      }),
      { code: 'ENOENT' },
    );
  } finally {
    if (previous === undefined) delete process.env.SAVEHUB_TEST_EXECUTABLE;
    else process.env.SAVEHUB_TEST_EXECUTABLE = previous;
  }
});

test('recovery boundary table validates the entire batch before applying queue limits', async (t) => {
  for (const [limit, active, count, allowed] of [
    [5, 0, 6, false],
    [5, 0, 5, true],
    [5, 5, 1, true],
    [5, 4, 3, true],
    [5, 5, 5, true],
    [0, 0, 1, false],
    [2, 2, 3, false],
  ]) {
    await t.test(`${limit}/${active}/${count}`, async (t) => {
      const f = await fixture(t);
      await f.store.setRestorePointRetention({ active: limit, removed: 15 });
      for (let i = 0; i < active; i++) await f.safety(i);
      const selected = [];
      for (let i = 0; i < count; i++) selected.push(await f.safety(active + i, true));
      const before = await f.store.snapshots(f.id, true);
      if (!allowed) {
        await assert.rejects(
          f.store.updateSnapshots(
            f.id,
            selected.map((item) => item.id),
            { deleted: false },
          ),
        );
        assert.deepEqual(await f.store.snapshots(f.id, true), before);
      } else {
        const start = Date.now();
        await f.store.updateSnapshots(
          f.id,
          selected.map((item) => item.id),
          { deleted: false },
        );
        const after = await f.store.snapshots(f.id, true);
        assert.equal(after.filter((item) => !item.deletedAt).length, Math.min(active + count, limit));
        for (const item of selected) {
          const recovered = await f.store.readSnapshot(f.id, item.id);
          assert.equal(recovered.deletedAt, undefined);
          assert(Date.parse(recovered.updatedAt) >= start);
          assert.equal(recovered.createdAt, item.createdAt);
        }
      }
    });
  }
});

test('IPC contracts reject malformed arguments before dispatch and accept zero retention', () => {
  assert(validArguments('setRestorePointRetention', [{ active: 0, removed: 15 }]));
  for (const args of [
    [{ active: '0', removed: 15 }],
    [{ active: -1, removed: 15 }],
    [{ active: 5, removed: Infinity }],
    [{ active: 5, removed: 15, extra: 1 }],
    [],
  ])
    assert(!validArguments('setRestorePointRetention', args));
  assert(!validArguments('updateSnapshot', ['game', 'id', { protected: 'yes' }]));
  assert(!validArguments('saveSnapshot', ['game', { label: 'save', protected: true }]));
  assert(validArguments('saveSnapshot', ['game', { label: 'save', note: 'note' }]));
  assert(!validArguments('updateSnapshots', ['game', 'all', { label: 'invalid-batch-field' }]));
  assert(validArguments('updateSnapshots', ['game', 'all', { protected: true }]));
  assert(
    validArguments('saveGame', [
      {
        name: 'Game',
        locations: { win32: { root: 'C:/saves', items: ['a'] }, darwin: { root: '/saves', items: ['a'] } },
      },
    ]),
  );
  assert(!validArguments('saveGame', [{ name: 'Game', locations: { win32: { root: 'C:/saves', items: [123] } } }]));
  assert(!validArguments('deleteSnapshots', ['../outside', ['record']]));
  assert(!validArguments('state', [true]));
  assert(validArguments('removeGame', ['game']));
  assert(Object.keys(IPC_SCHEMA).includes('executeGameImport'));
});

test('custom icons are independently fetched, remain portable and reject foreign resource identities', async (t) => {
  const f = await fixture(t),
    icon = 'data:image/png;base64,' + Buffer.from('synthetic-image').toString('base64');
  await f.store.upsertGame({ ...f.input, id: f.id, icon });
  const game = (await f.store.state()).games[0];
  assert(game.icon.startsWith('savehub-icon://game/'));
  assert.equal(Buffer.from(await iconResponse(f.store, game.icon).arrayBuffer()).toString(), 'synthetic-image');
  assert.equal(iconResponse(f.store, game.icon.replace(f.id, 'foreign')).status, 404);
  await f.store.upsertGame({ ...game, name: 'Changed' });
  assert.equal(f.store.game(f.id).icon, icon);
  assert.equal(publicIcon(f.store.game(f.id)), game.icon);
  await assert.rejects(f.store.upsertGame({ ...game, icon: game.icon.replace(f.id, 'foreign') }));
});

test('operation IDs span log types while recovery and automatic pruning use separate files', async (t) => {
  const f = await fixture(t);
  await f.store.logger.run(
    'recover',
    async () => {
      await f.store.logger.warn('prune-deferred', { operation: 'prune', gameId: f.id, code: 'EBUSY' });
    },
    { gameId: f.id },
  );
  const records = f.store.logger.entries.slice(-3);
  assert.equal(new Set(records.map((item) => item.operationId)).size, 1);
  assert.deepEqual(
    records.map((item) => item.operation),
    ['recover', 'prune', 'recover'],
  );
  assert.equal(records[2].result, 'success');
  await fs.access(path.join(f.store.logger.logDir, 'warn', 'prune.jsonl'));
});

test('cached summaries cannot hide external modifications from stale import confirmation', async (t) => {
  const f = await fixture(t),
    original = await f.store.createSnapshot(f.id, { label: 'before' });
  await f.store.snapshots(f.id);
  const manifest = await f.store.readSnapshot(f.id, original.id);
  manifest.label = 'external';
  await atomicJson(path.join(f.store.snapshotDir(f.id, original.id), 'manifest.json'), manifest);
  assert.equal((await f.store.readSnapshot(f.id, original.id)).label, 'external');
  f.store.invalidateGameCache(f.id);
  assert.equal((await f.store.snapshots(f.id))[0].label, 'external');
});

async function fixture(t) {
  const root = path.resolve('.test-data');
  await fs.mkdir(root, { recursive: true });
  const base = await fs.mkdtemp(path.join(root, 'remediation-'));
  const source = path.join(base, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'save.dat'), 'original');
  const store = await new SaveStore(path.join(base, 'data')).init();
  t.after(async () => {
    await store.logger.queue;
    assert(within(root, base) && root !== base);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  });
  const input = {
    name: 'Rules',
    locations: { win32: { root: source, items: ['save.dat'] }, darwin: { root: source, items: ['save.dat'] } },
  };
  const id = await store.upsertGame(input);
  const safety = async (index, deleted = false) => {
    const meta = await store.capture(store.game(id), source, ['save.dat'], { kind: 'safety', label: `point-${index}` });
    meta.createdAt = new Date(Date.UTC(2020, 0, 30 - index)).toISOString();
    meta.updatedAt = new Date(Date.UTC(2021, 0, index + 1)).toISOString();
    if (deleted) meta.deletedAt = new Date().toISOString();
    await atomicJson(path.join(store.snapshotDir(id, meta.id), 'manifest.json'), meta);
    store.invalidateSnapshotCache(id, meta.id);
    return meta;
  };
  return { base, source, store, id, input, safety };
}

test('default 5/15 queues evict by modification time and physically delete only removed overflow', async (t) => {
  const f = await fixture(t),
    points = [];
  assert.deepEqual((await f.store.state()).restorePointRetention, { active: 5, removed: 15 });
  for (let i = 0; i < 22; i++) points.push(await f.safety(i));
  await f.store.pruneRestorePoints(f.id);
  const all = (await f.store.snapshots(f.id, true)).filter((p) => p.kind === 'safety');
  assert.equal(all.filter((p) => !p.deletedAt).length, 5);
  assert.equal(all.filter((p) => p.deletedAt).length, 15);
  assert(all.some((p) => p.id === points[21].id && !p.deletedAt));
  for (const point of points.slice(0, 2))
    await assert.rejects(fs.stat(f.store.snapshotDir(f.id, point.id)), { code: 'ENOENT' });
  await f.store.verify(f.id, points[2].id);
});

test('global settings validate integers atomically and per-game zero differs from inheritance', async (t) => {
  const f = await fixture(t),
    other = await f.store.upsertGame({ ...f.input, name: 'Other' });
  for (const active of [-1, 1.5, '', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const before = await fs.readFile(f.store.configFile, 'utf8');
    await assert.rejects(f.store.setRestorePointRetention({ active, removed: 15 }), /整数/);
    assert.equal(await fs.readFile(f.store.configFile, 'utf8'), before);
  }
  await f.store.upsertGame({ ...f.input, id: f.id, restorePointRetention: { active: 0, removed: 8 } });
  await f.store.setRestorePointRetention({ active: 3, removed: 7 });
  let state = await f.store.state();
  assert.deepEqual(state.games.find((g) => g.id === f.id).restorePointRetentionEffective, { active: 0, removed: 8 });
  assert.deepEqual(state.games.find((g) => g.id === other).restorePointRetentionEffective, { active: 3, removed: 7 });
  await f.store.upsertGame({ ...f.input, id: f.id, restorePointRetention: {} });
  const reopened = await new SaveStore(f.store.dataDir).init();
  state = await reopened.state();
  assert.deepEqual(state.games.find((g) => g.id === f.id).restorePointRetentionEffective, { active: 3, removed: 7 });
});

for (const [active, removed] of [
  [0, 15],
  [5, 0],
  [0, 0],
])
  test(`retention ${active}/${removed} preserves transaction safety then enforces both queues`, async (t) => {
    const f = await fixture(t);
    const snapshot = await f.store.createSnapshot(f.id, { label: 'base' });
    await f.store.setRestorePointRetention({ active, removed });
    await fs.writeFile(path.join(f.source, 'save.dat'), 'live-progress');
    let safetySeen = false;
    f.store.fault = async (phase, context) => {
      if (phase === 'after-install') {
        const safety = await f.store.verify(f.id, context.journal.safetyId);
        assert.equal(
          await fs.readFile(path.join(f.store.snapshotDir(f.id, safety.id), 'payload', 'save.dat'), 'utf8'),
          'live-progress',
        );
        safetySeen = true;
      }
    };
    const result = await f.store.restoreSnapshot(f.id, snapshot.id);
    assert(safetySeen);
    assert.equal(await fs.readFile(path.join(f.source, 'save.dat'), 'utf8'), 'original');
    const points = (await f.store.snapshots(f.id, true)).filter((p) => p.kind === 'safety');
    assert.equal(points.filter((p) => !p.deletedAt).length, active ? 1 : 0);
    assert.equal(points.filter((p) => p.deletedAt).length, active ? 0 : removed ? 1 : 0);
    if (!active && removed) {
      await assert.rejects(f.store.updateSnapshot(f.id, result.safetyId, { deleted: false }), /为 0/);
      await assert.rejects(f.store.updateSnapshots(f.id, [result.safetyId], { deleted: false }), /为 0/);
    }
  });

test('over-limit recovery changes nothing; full queues accept an allowed batch and refresh timestamps', async (t) => {
  const f = await fixture(t),
    active = [],
    removed = [];
  await f.store.setRestorePointRetention({ active: 2, removed: 15 });
  for (let i = 0; i < 2; i++) active.push(await f.safety(i));
  for (let i = 2; i < 5; i++) removed.push(await f.safety(i, true));
  const before = await Promise.all(
    removed.map((p) => fs.readFile(path.join(f.store.snapshotDir(f.id, p.id), 'manifest.json'), 'utf8')),
  );
  await assert.rejects(
    f.store.updateSnapshots(
      f.id,
      removed.map((p) => p.id),
      { deleted: false },
    ),
    /选择 3 条.*最多保留 2 条/,
  );
  assert.deepEqual(
    await Promise.all(
      removed.map((p) => fs.readFile(path.join(f.store.snapshotDir(f.id, p.id), 'manifest.json'), 'utf8')),
    ),
    before,
  );
  const start = Date.now();
  const chosen = removed.slice(0, 2);
  const report = await f.store.updateSnapshots(
    f.id,
    chosen.map((p) => p.id),
    { deleted: false },
  );
  assert.deepEqual(report.failed, []);
  for (const point of chosen) {
    const recovered = await f.store.verify(f.id, point.id);
    assert(!recovered.deletedAt);
    assert(Date.parse(recovered.updatedAt) >= start);
    assert.equal(recovered.createdAt, point.createdAt);
  }
  assert.equal(
    (await f.store.readSnapshot(f.id, chosen[0].id)).updatedAt,
    (await f.store.readSnapshot(f.id, chosen[1].id)).updatedAt,
  );
  for (const point of active) assert((await f.store.readSnapshot(f.id, point.id)).deletedAt);
});

test('automatic physical deletion persists intent and startup retries a partial deletion', async (t) => {
  const f = await fixture(t),
    point = await f.safety(0);
  f.store.fault = async (phase, context) => {
    if (phase === 'before-purge-remove') {
      await fs.rm(path.join(context.stage, 'manifest.json'), { force: true });
      throw new Error('partial-delete');
    }
  };
  await f.store.setRestorePointRetention({ active: 0, removed: 0 });
  assert((await f.store.readSnapshot(f.id, point.id)).purgePending);
  const reopened = await new SaveStore(f.store.dataDir).init();
  assert.deepEqual(await reopened.snapshots(f.id, true), []);
  await assert.rejects(fs.stat(f.store.snapshotDir(f.id, point.id)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.source, 'save.dat'), 'utf8'), 'original');
});

for (const exists of [true, false])
  test(`post-commit maintenance failure cannot roll back restored content (original exists=${exists})`, async (t) => {
    const f = await fixture(t),
      snapshot = await f.store.createSnapshot(f.id, { label: 'target' });
    if (exists) await fs.writeFile(path.join(f.source, 'save.dat'), 'before');
    else await fs.rm(path.join(f.source, 'save.dat'));
    f.store.pruneRestorePoints = async () => {
      throw new Error('injected scan failure');
    };
    await f.store.restoreSnapshot(f.id, snapshot.id);
    assert.equal(await fs.readFile(path.join(f.source, 'save.dat'), 'utf8'), 'original');
    const names = await fs.readdir(path.join(f.store.dataDir, 'transactions'));
    for (const name of names.filter((n) => n.endsWith('.json')))
      assert.notEqual(
        JSON.parse(await fs.readFile(path.join(f.store.dataDir, 'transactions', name))).status,
        'rolled-back',
      );
  });

test('disk budgets enforce zero and exact thresholds, separate volumes and report statfs failures', async (t) => {
  const f = await fixture(t),
    original = fs.statfs,
    originalLstat = fs.lstat;
  t.after(() => {
    fs.statfs = original;
    fs.lstat = originalLstat;
    syncBuiltinESMExports();
  });
  fs.statfs = async () => ({ bavail: 0, bsize: 4096 });
  syncBuiltinESMExports();
  await assert.rejects(assertDiskSpace(f.source, 1), /空间不足/);
  // A 20,000-byte payload requires 86,536 bytes including the documented reserve.
  for (const available of [86535, 86536, 86537]) {
    fs.statfs = async () => ({ bavail: available, bsize: 1 });
    syncBuiltinESMExports();
    if (available < 86536) await assert.rejects(assertDiskSpace(f.source, 20000), /空间不足/);
    else await assertDiskSpace(f.source, 20000);
  }
  fs.statfs = async () => ({ bavail: 100000, bsize: 1 });
  syncBuiltinESMExports();
  await assertDiskSpace(f.source, 20000);
  await assert.rejects(
    assertDiskBudgets([
      { directory: f.source, bytes: 20000 },
      { directory: f.store.vault, bytes: 20000 },
    ]),
    /空间不足/,
  );
  fs.lstat = async (file, ...args) => {
    const stat = await originalLstat(file, ...args);
    stat.dev = path.resolve(String(file)) === path.resolve(f.source) ? 101 : 202;
    return stat;
  };
  syncBuiltinESMExports();
  await assertDiskBudgets([
    { directory: f.source, bytes: 20000 },
    { directory: f.store.vault, bytes: 20000 },
  ]);
  fs.statfs = async () => {
    throw Object.assign(new Error('injected-statfs-failure'), { code: 'EIO' });
  };
  syncBuiltinESMExports();
  await assert.rejects(assertDiskSpace(f.source, 20000), {
    code: 'storage.diskSpaceUnavailable',
  });
});

test('schema-corrupt journals are isolated; quarantine failures are reported honestly without overwriting evidence', async (t) => {
  const f = await fixture(t);
  for (const directory of ['transactions', 'import-transactions']) {
    const root = path.join(f.store.dataDir, directory);
    await fs.mkdir(path.join(root, 'quarantine'), { recursive: true });
    await fs.writeFile(path.join(root, 'bad.json'), '{}');
    await fs.writeFile(path.join(root, 'quarantine', 'bad.json'), 'old evidence');
  }
  const recovered = await new SaveStore(f.store.dataDir).init();
  assert.equal(recovered.recoveryMessages.length, 2);
  for (const directory of ['transactions', 'import-transactions']) {
    const root = path.join(f.store.dataDir, directory);
    assert.equal(await fs.readFile(path.join(root, 'quarantine', 'bad.json'), 'utf8'), 'old evidence');
    assert.equal((await fs.readdir(path.join(root, 'quarantine'))).length, 2);
  }
  const file = path.join(f.store.dataDir, 'transactions', 'blocked.json');
  await fs.writeFile(file, '{}');
  const failed = await new SaveStore(f.store.dataDir, {
    fault: async (phase) => {
      if (phase === 'before-quarantine') throw new Error('EACCES');
    },
  }).init();
  assert(failed.recoveryMessages.some((message) => message.includes('隔离失败')));
  assert(!failed.recoveryMessages.some((message) => message.includes('已隔离')));
  assert.equal(await fs.readFile(file, 'utf8'), '{}');
});

test('bad manifest summaries stay local and legacy modification time uses creation time once', async (t) => {
  const f = await fixture(t),
    point = await f.safety(0);
  const file = path.join(f.store.snapshotDir(f.id, point.id), 'manifest.json');
  for (const patch of [
    { createdAt: null },
    { updatedAt: 'bad' },
    { kind: 'unknown' },
    { bytes: -1 },
    { fileCount: 99 },
  ]) {
    await atomicJson(file, { ...point, ...patch });
    f.store.invalidateSnapshotCache(f.id, point.id);
    assert((await f.store.snapshots(f.id, true)).find((p) => p.id === point.id).corrupted);
  }
  const legacy = { ...point };
  delete legacy.updatedAt;
  await atomicJson(file, legacy);
  assert.equal((await f.store.readSnapshot(f.id, point.id)).updatedAt, point.createdAt);
});

test('library backup recovery is explicit and preserves the corrupt original', async (t) => {
  const f = await fixture(t);
  await f.store.setTheme('tech');
  await fs.writeFile(f.store.configFile, '{broken');
  await assert.rejects(
    new SaveStore(f.store.dataDir).init(),
    (error) => error.code === 'LIBRARY_CORRUPT' && error.recoveryAvailable,
  );
  const recovered = await new SaveStore(f.store.dataDir).init([], { recoverPrevious: true });
  assert(recovered.game(f.id));
  const copy = (await fs.readdir(f.store.dataDir)).find((name) => name.startsWith('library.json.corrupt-'));
  assert.equal(await fs.readFile(path.join(f.store.dataDir, copy), 'utf8'), '{broken');
});

test('summary cache is bounded, contains no file records, and writes invalidate only the relevant game', async (t) => {
  const f = await fixture(t);
  await f.safety(0);
  await f.store.state();
  for (const value of f.store.manifestCache.values()) assert.equal(value.meta?.records, undefined);
  f.store.manifestCache.maxBytes = 1024;
  for (let i = 0; i < 100; i++) f.store.manifestCache.set(`other/${i}`, { label: 'x'.repeat(200) });
  assert(f.store.manifestCache.bytes <= 1024);
  assert(f.store.manifestCache.size < 10);
  f.store.invalidateGameCache(f.id);
  assert(f.store.manifestCache.size > 0);
});

test('existing path containment uses filesystem identity', async (t) => {
  const f = await fixture(t);
  assert(await withinOnDisk(f.base, path.join(f.source, 'save.dat')));
  assert(!(await withinOnDisk(f.source, f.store.dataDir)));
  const pendingRoot = path.join(f.base, 'non-existent-root');
  assert(await withinOnDisk(pendingRoot, path.join(pendingRoot, 'sub', 'save.dat')));
  assert(!(await withinOnDisk(pendingRoot, path.join(f.base, 'source', 'save.dat'))));
  if (process.platform === 'win32') assert(await withinOnDisk(f.source.toUpperCase(), path.join(f.source, 'save.dat')));
});

async function logFiles(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await logFiles(file)));
    else result.push(file);
  }
  return result;
}

test('classified logs share one byte budget, evict global oldest records and retain valid UTF-8 JSON', async (t) => {
  const f = await fixture(t);
  assert.equal(MAX_LOG_BYTES, 20 * 1024 * 1024);
  const logger = new Logger(f.store.dataDir, { maxBytes: 2200 });
  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      logger.write(i % 2 ? 'error' : 'info', i % 3 ? 'restore' : 'export', { text: `记录-${i}-${'界'.repeat(20)}` }),
    ),
  );
  await logger.info('recover', { operation: 'recover', latest: true, detail: '界'.repeat(10000) });
  const files = await logFiles(logger.logDir),
    rows = [];
  let bytes = 0;
  for (const file of files) {
    const data = await fs.readFile(file);
    bytes += data.length;
    for (const line of data.toString('utf8').split('\n').filter(Boolean)) rows.push(JSON.parse(line));
  }
  assert(bytes <= 2200);
  assert(rows.length < 31);
  assert(files.some((file) => file.includes(`${path.sep}error${path.sep}`)));
  assert(rows.some((row) => row.operation === 'recover' && row.details.truncated));
  assert(!rows.some((row) => row.details?.text?.startsWith('记录-0-')));
  assert.equal(logger.lastError, null);
});

test('legacy logs migrate into the shared budget and failed log writes never reject operations', async (t) => {
  const f = await fixture(t),
    root = f.store.logger.logDir;
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, 'savehub.1.log'),
    JSON.stringify({ time: '2020-01-01T00:00:00Z', level: 'error', event: 'restore', details: { legacy: true } }) +
      '\n',
  );
  const logger = new Logger(f.store.dataDir);
  await logger.info('startup');
  await assert.rejects(fs.stat(path.join(root, 'savehub.1.log')), { code: 'ENOENT' });
  const rows = (await fs.readFile(path.join(root, 'error', 'restore.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert(rows.some((row) => row.details.legacy));
  const blocked = path.join(f.base, 'blocked');
  await fs.writeFile(blocked, 'file');
  const bad = new Logger(blocked);
  assert.equal(await bad.run('restore', async () => 42), 42);
});

test('blocked games preserve ready pathStatus in state while blocking all game and import mutations', async (t) => {
  const f = await fixture(t);
  const snap = await f.store.createSnapshot(f.id, { label: 'initial' });
  const exportDir = path.join(f.base, 'exports');
  await fs.mkdir(exportDir);
  const snapExport = await f.store.exportSnapshots(f.id, [snap.id], exportDir);
  const gameExport = await f.store.exportGames([f.id], exportDir, true);

  f.store.blockedGames.add(f.id);
  const state = await f.store.state();
  const gameState = state.games.find((g) => g.id === f.id);
  assert.equal(gameState.pathStatus, 'ready');
  assert.equal(gameState.recoveryBlocked, true);

  await assert.rejects(f.store.createSnapshot(f.id, { label: 'blocked' }), { code: 'storage.gameRecoveryBlocked' });
  await assert.rejects(f.store.restoreSnapshot(f.id, snap.id), { code: 'storage.gameRecoveryBlocked' });
  await assert.rejects(f.store.removeGame(f.id, false, false), { code: 'storage.gameRecoveryBlocked' });
  await assert.rejects(f.store.removeGame(f.id, false, true), { code: 'storage.gameRecoveryBlocked' });
  await assert.rejects(f.store.prepareImport(f.id, snapExport.folder), { code: 'storage.gameRecoveryBlocked' });

  const gamePlan = await f.store.prepareGameImport(gameExport.folder);
  await assert.rejects(
    f.store.reviewGameImport(gamePlan.id, [{ itemId: gamePlan.items[0].id, action: 'overwrite', targetId: f.id }]),
    { code: 'storage.gameRecoveryBlocked' },
  );
});

test('English locale localizes export folder names and import report includes retention prune statistics', async (t) => {
  const f = await fixture(t);
  await f.store.setLanguage('en');
  assert.equal(exportName('...', 'en'), 'Unnamed Save');
  const exportDir = path.join(f.base, 'exports-en');
  await fs.mkdir(exportDir);
  const p1 = await f.safety(0);
  const p2 = await f.safety(1);
  const snapExport = await f.store.exportSnapshots(f.id, [p1.id, p2.id], exportDir);
  assert(path.basename(snapExport.folder).includes('Save Export'));
  const gameExport = await f.store.exportGames([f.id], exportDir, false);
  assert(path.basename(gameExport.folder).includes('Game Export'));

  const target = await new SaveStore(path.join(f.base, 'target-en')).init();
  t.after(async () => {
    await target.logger.queue;
  });
  await target.setRestorePointRetention({ active: 1, removed: 0 });
  const targetGameId = await target.upsertGame(f.input);
  const plan = await target.prepareImport(targetGameId, snapExport.folder);
  const report = await target.executeImport(plan.id, []);
  assert.deepEqual(report.pruned, { movedCount: 1, purgedCount: 1 });
});
