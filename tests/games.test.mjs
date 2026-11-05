import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { SaveStore, atomicJson, within } from '../electron/storage.mjs';

const root = path.resolve('.test-data');
const read = (file) => fs.readFile(file, 'utf8');
const choices = (plan, action = 'skip') =>
  plan.items
    .filter((item) => item.matches.length)
    .map((item) => ({ itemId: item.id, action, targetId: item.matches[0].id }));
const saveChoices = (review, action = 'skip') =>
  review.games
    .filter((game) => game.snapshots)
    .map((game) => ({ itemId: game.itemId, decisions: choices(game.snapshots, action) }));
async function fixture(t) {
  await fs.mkdir(root, { recursive: true });
  const base = await fs.mkdtemp(path.join(root, 'games-'));
  t.after(async () => {
    assert(within(root, base) && base !== root);
    await fs.rm(base, { recursive: true, force: true });
  });
  const source = path.join(base, 'live');
  await fs.mkdir(path.join(source, 'saves', 'empty'), { recursive: true });
  await fs.writeFile(path.join(source, 'saves', 'progress.dat'), 'original-progress');
  const store = await new SaveStore(path.join(base, 'data'), { platform: 'win32' }).init();
  const input = {
    name: '测试游戏',
    subtitle: 'GAME SETTINGS',
    icon: 'ring',
    color: '#729486',
    legacyRoot: '',
    locations: {
      win32: { root: source, items: ['saves'] },
      darwin: { root: '', items: [] },
    },
  };
  const id = await store.upsertGame(input);
  const destination = path.join(base, 'exports');
  await fs.mkdir(destination);
  const target = await new SaveStore(path.join(base, 'target'), { platform: 'darwin' }).init();
  const add = (label) => store.createSnapshot(id, { label, note: `${label}-note` });
  const payload = (owner, gameId, save) =>
    path.join(owner.snapshotDir(gameId, save.id), 'payload', 'saves', 'progress.dat');
  const bundle = async (include = false, ids = [id]) => (await store.exportGames(ids, destination, include)).folder;
  return { base, source, store, target, id, input, destination, add, payload, bundle };
}
async function marks(f) {
  const ordinary = await f.add('普通存档'),
    protectedSave = await f.add('保护存档'),
    trash = await f.add('回收站');
  await f.store.updateSnapshot(f.id, ordinary.id, { favorite: true });
  await f.store.updateSnapshot(f.id, protectedSave.id, { protected: true, favorite: true });
  await f.store.updateSnapshot(f.id, trash.id, { deleted: true });
  const safety = await f.store.capture(f.store.game(f.id), f.source, ['saves'], {
    label: '读档恢复点',
    kind: 'safety',
  });
  return { ordinary, protectedSave, trash, safety };
}
async function review(owner, folder, action = 'skip') {
  const plan = await owner.prepareGameImport(folder);
  const result = await owner.reviewGameImport(plan.id, choices(plan, action));
  return { plan, review: result };
}

test('game deletion defaults to retaining every record, identity and flag through restart and restore', async (t) => {
  const f = await fixture(t);
  await marks(f);
  const before = await f.store.snapshots(f.id, true);
  await f.store.removeGame(f.id);
  assert(f.store.game(f.id, true).deletedAt);
  assert.deepEqual(await f.store.snapshots(f.id, true), before);
  const resumed = await new SaveStore(f.store.dataDir).init();
  await resumed.removeGame(f.id, true);
  assert(!resumed.game(f.id).deletedAt);
  assert.deepEqual(await resumed.snapshots(f.id, true), before);
  for (const save of before) assert.equal(await read(f.payload(resumed, f.id, save)), 'original-progress');
});

test('explicit game purge physically removes the entire game directory and configuration, including protected and corrupt records', async (t) => {
  const f = await fixture(t);
  await marks(f);
  const other = await f.store.upsertGame({ ...f.input, name: '另一个游戏' });
  const otherSave = await f.store.createSnapshot(other, { label: '保留', note: '' });
  await fs.mkdir(path.join(f.store.gameDir(f.id), 'snapshots', 'broken'));
  await fs.writeFile(path.join(f.store.gameDir(f.id), 'snapshots', 'broken', 'unknown'), 'corrupt');
  await fs.mkdir(path.join(f.store.gameDir(f.id), 'extra-configuration'));
  await fs.writeFile(path.join(f.store.gameDir(f.id), 'extra-configuration', 'notes.json'), '{}');
  await f.store.removeGame(f.id, false, true);
  await assert.rejects(fs.stat(f.store.gameDir(f.id)), { code: 'ENOENT' });
  assert(!f.store.config.games.some((game) => game.id === f.id));
  assert(!JSON.parse(await read(f.store.configFile)).games.some((game) => game.id === f.id));
  await f.store.verify(other, otherSave.id);
  assert.equal(await read(path.join(f.source, 'saves', 'progress.dat')), 'original-progress');
  await assert.rejects(f.store.removeGame(f.id, true), /找不到/);
  const resumed = await new SaveStore(f.store.dataDir).init();
  assert(!resumed.config.games.some((game) => game.id === f.id));
  await assert.rejects(fs.stat(resumed.gameDir(f.id)), { code: 'ENOENT' });
});

test('interrupted game purge remains retry-only and startup resumes committed cleanup intent', async (t) => {
  const f = await fixture(t);
  const first = await f.add('第一份'),
    second = await f.add('第二份');
  f.store.fault = async (phase) => {
    if (phase === 'before-game-purge-remove') {
      await fs.rm(f.payload(f.store, f.id, first));
      throw new Error('simulated interruption');
    }
  };
  await assert.rejects(f.store.removeGame(f.id, false, true), /simulated interruption/);
  assert(f.store.game(f.id, true).purgeGamePending);
  await assert.rejects(f.store.removeGame(f.id, true), /尚未完成/);
  assert.equal(await read(f.payload(f.store, f.id, second)), 'original-progress');
  const resumed = await new SaveStore(f.store.dataDir).init();
  assert(!resumed.config.games.some((game) => game.id === f.id));
  await assert.rejects(fs.stat(resumed.gameDir(f.id)), { code: 'ENOENT' });
  assert.deepEqual(await resumed.snapshots(f.id, true), []);
});

test('game purge rejects junctions and invalid options before recording removal', async (t) => {
  const f = await fixture(t);
  const save = await f.add('保留');
  for (const args of [
    [true, true],
    [false, 'true'],
    ['false', false],
  ])
    await assert.rejects(f.store.removeGame(f.id, ...args), /选项无效/);
  const link = path.join(f.store.snapshotDir(f.id, save.id), 'payload', 'junction');
  await fs.symlink(f.source, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.removeGame(f.id, false, true), /链接|联接/);
  assert(!f.store.game(f.id).deletedAt);
  assert.equal(await read(path.join(f.source, 'saves', 'progress.dat')), 'original-progress');
  await fs.unlink(link);
});

test('default game exports contain configuration only and import review and cancellation never write', async (t) => {
  const f = await fixture(t);
  await f.add('不应导出');
  const folder = await f.bundle();
  const index = JSON.parse(await read(path.join(folder, 'games.json')));
  const gameFolder = path.join(folder, index.games[0]);
  assert.deepEqual((await fs.readdir(gameFolder)).sort(), ['game.json']);
  let result = await review(f.target, folder);
  assert.deepEqual(f.target.config.games, []);
  assert.deepEqual(await fs.readdir(f.target.vault), []);
  f.target.cancelGameImport(result.plan.id);
  await assert.rejects(f.target.executeGameImport(result.review.id, []), /失效/);
  result = await review(f.target, gameFolder);
  result.plan.items[0].game.name = 'forged';
  const report = await f.target.executeGameImport(result.review.id, []);
  assert.deepEqual(report.games.imported, ['测试游戏']);
  const imported = f.target.config.games[0];
  assert.equal(imported.subtitle, f.input.subtitle);
  assert.deepEqual(imported.locations, f.input.locations);
  assert.equal(imported.color, f.input.color);
  assert.equal(imported.icon, f.input.icon);
  assert.deepEqual(await f.target.snapshots(imported.id, true), []);
  await assert.rejects(f.target.executeGameImport(result.review.id, []), /失效/);
});

test('combined game bundles round-trip every save state, original platform, timestamps and exact bytes across platforms', async (t) => {
  const f = await fixture(t);
  await marks(f);
  const originals = await f.store.snapshots(f.id, true);
  const folder = await f.bundle(true),
    result = await review(f.target, folder);
  assert.equal(result.review.games[0].snapshots.items.length, 4);
  const report = await f.target.executeGameImport(result.review.id, saveChoices(result.review));
  assert.deepEqual(report.games.failed, []);
  assert.deepEqual(report.snapshots[0].report.failed, []);
  const game = f.target.config.games[0],
    copies = await f.target.snapshots(game.id, true);
  assert.equal(copies.length, 4);
  for (const original of originals) {
    const copy = copies.find((item) => item.label === original.label);
    for (const key of ['kind', 'favorite', 'protected', 'deletedAt', 'createdAt', 'platform', 'bytes', 'fileCount'])
      assert.equal(copy[key], original[key], key);
    await f.target.verify(game.id, copy.id);
    assert.equal(await read(f.payload(f.target, game.id, copy)), 'original-progress');
  }
});

test('game conflicts match normalized names and source identity; overwrite retains local identity and saves, coexistence numbers names', async (t) => {
  const f = await fixture(t);
  const localId = await f.target.upsertGame({ ...f.input, name: '测试游戏', subtitle: 'LOCAL' });
  const localSave = await f.target.capture(f.target.game(localId), f.source, ['saves'], { label: '本地记录' });
  const createdAt = f.target.game(localId).createdAt,
    folder = await f.bundle();
  let result = await review(f.target, folder, 'overwrite');
  assert.equal(result.plan.items[0].matches[0].id, localId);
  await f.target.executeGameImport(result.review.id, []);
  assert.equal(f.target.game(localId).createdAt, createdAt);
  assert.equal(f.target.game(localId).subtitle, f.input.subtitle);
  await f.target.verify(localId, localSave.id);
  result = await review(f.target, folder, 'keep-both');
  const report = await f.target.executeGameImport(result.review.id, []);
  assert.deepEqual(report.games.keptBoth, ['测试游戏 (2)']);
  const copy = f.target.config.games.find((game) => game.name.endsWith('(2)'));
  assert.notEqual(copy.id, localId);
  const plan = await f.target.prepareGameImport(folder);
  assert.equal(plan.items[0].matches.length, 2);
});

test('game skip also skips bundled records and game overwrite revives a deleted game without losing retained saves', async (t) => {
  const f = await fixture(t);
  await f.add('原有');
  const folder = await f.bundle(true);
  let result = await review(f.store, folder, 'skip');
  assert.equal(result.review.games[0].snapshots, null);
  const report = await f.store.executeGameImport(result.review.id, []);
  assert.deepEqual(report.games.skipped, ['测试游戏']);
  assert.equal((await f.store.snapshots(f.id)).length, 1);
  await f.store.removeGame(f.id);
  result = await review(f.store, folder, 'overwrite');
  await f.store.executeGameImport(result.review.id, saveChoices(result.review));
  assert(!f.store.game(f.id).deletedAt);
  assert.equal((await f.store.snapshots(f.id)).length, 1);
});

test('bundled saves independently mix overwrite, skip and keep-both while protected, trash and safety targets stay non-overwritable', async (t) => {
  const f = await fixture(t);
  const saved = await marks(f);
  const folder = await f.bundle(true);
  const result = await review(f.store, folder, 'overwrite');
  const plan = result.review.games[0].snapshots;
  assert.equal(plan.items.filter((item) => item.matches.length).length, 4);
  assert.equal((await f.store.snapshots(f.id, true)).length, 4);
  for (const id of [saved.protectedSave.id, saved.trash.id, saved.safety.id]) {
    const invalid = saveChoices(result.review);
    const item = plan.items.find((item) => item.matches.some((match) => match.id === id));
    invalid[0].decisions.find((choice) => choice.itemId === item.id).action = 'overwrite';
    await assert.rejects(f.store.executeGameImport(result.review.id, invalid), /不能被导入覆盖/);
    assert.equal((await f.store.snapshots(f.id, true)).length, 4);
  }
  const valid = saveChoices(result.review);
  valid[0].decisions.find((choice) => plan.items.find((item) => item.id === choice.itemId).name === '普通存档').action =
    'overwrite';
  valid[0].decisions.find((choice) => plan.items.find((item) => item.id === choice.itemId).name === '保护存档').action =
    'keep-both';
  const report = await f.store.executeGameImport(result.review.id, valid);
  assert.deepEqual(report.snapshots[0].report.overwritten, ['普通存档']);
  assert.deepEqual(report.snapshots[0].report.keptBoth, ['保护存档 (2)']);
  assert.equal((await f.store.snapshots(f.id, true)).length, 5);
  const original = await f.store.readSnapshot(f.id, saved.ordinary.id);
  assert(original.favorite);
});

test('forged, duplicate, incomplete or stale game choices reject before any configuration is committed', async (t) => {
  const f = await fixture(t),
    folder = await f.bundle();
  const plan = await f.store.prepareGameImport(folder);
  for (const invalid of [
    [],
    [{ itemId: 'forged', action: 'skip' }],
    [{ itemId: plan.items[0].id, action: 'overwrite', targetId: 'forged' }],
    [...choices(plan), ...choices(plan)],
  ])
    await assert.rejects(f.store.reviewGameImport(plan.id, invalid));
  await f.store.upsertGame({ ...f.store.game(f.id), subtitle: 'CHANGED' });
  await assert.rejects(f.store.reviewGameImport(plan.id, choices(plan)), /已变化/);
  assert.equal(f.store.config.games.length, 1);
});

test('stale games and changed bundle configuration invalidate final confirmation without writes', async (t) => {
  const f = await fixture(t),
    folder = await f.bundle();
  let result = await review(f.store, folder, 'overwrite');
  await f.store.upsertGame({ ...f.store.game(f.id), subtitle: 'LOCAL CHANGED' });
  await assert.rejects(f.store.executeGameImport(result.review.id, []), /已变化/);
  assert.equal(f.store.game(f.id).subtitle, 'LOCAL CHANGED');
  result = await review(f.target, folder);
  const file = path.join(folder, '测试游戏', 'game.json'),
    data = JSON.parse(await read(file));
  data.game.subtitle = 'SOURCE CHANGED';
  await atomicJson(file, data);
  await assert.rejects(f.target.executeGameImport(result.review.id, []), /导入源已变化/);
  assert.equal(f.target.config.games.length, 0);
});

test('stale or forged save decisions preflight all games before a new game can be imported', async (t) => {
  const f = await fixture(t);
  const save = await f.add('冲突');
  const other = await f.store.upsertGame({ ...f.input, name: '全新游戏' });
  const folder = await f.bundle(true, [other, f.id]);
  await f.store.removeGame(other);
  const result = await review(f.store, folder, 'overwrite');
  const decisions = saveChoices(result.review);
  const invalid = structuredClone(decisions);
  invalid[0].decisions[0].targetId = 'forged';
  invalid[0].decisions[0].action = 'overwrite';
  await assert.rejects(f.store.executeGameImport(result.review.id, invalid));
  assert(f.store.game(other, true).deletedAt);
  await f.store.updateSnapshot(f.id, save.id, { protected: true });
  await assert.rejects(f.store.executeGameImport(result.review.id, decisions), /已变化/);
  assert(f.store.game(other, true).deletedAt);
});

test('changed payload or index after preview blocks final game and save import without writes', async (t) => {
  const f = await fixture(t);
  await f.add('进度');
  const folder = await f.bundle(true);
  let result = await review(f.target, folder);
  const payload = path.join(folder, '测试游戏', 'snapshots', '进度', 'saves', 'progress.dat');
  await fs.writeFile(payload, 'tampered');
  await assert.rejects(f.target.executeGameImport(result.review.id, saveChoices(result.review)), /导入源已变化/);
  assert.equal(f.target.config.games.length, 0);
  await fs.writeFile(payload, 'original-progress');
  result = await review(f.target, folder);
  const index = path.join(folder, '测试游戏', 'snapshots', '.savehub-exports', 'collection.json');
  await fs.appendFile(index, '\n');
  await assert.rejects(f.target.executeGameImport(result.review.id, saveChoices(result.review)), /清单已变化/);
  assert.equal(f.target.config.games.length, 0);
});

test('empty and unconfigured games remain valid combined bundles with no phantom records', async (t) => {
  const f = await fixture(t);
  const folder = await f.bundle(true),
    result = await review(f.target, folder);
  assert.equal(result.review.games[0].snapshots, null);
  await f.target.executeGameImport(result.review.id, []);
  assert.equal(f.target.config.games.length, 1);
  const again = await f.target.exportGames([f.target.config.games[0].id], f.destination, true);
  assert.equal(again.snapshotCount, 0);
});

test('corrupt game save export rolls back owned staging and retains all existing destination files', async (t) => {
  const f = await fixture(t);
  const save = await f.add('损坏');
  await fs.writeFile(path.join(f.destination, 'existing.txt'), 'keep');
  await fs.writeFile(f.payload(f.store, f.id, save), 'corrupt');
  await assert.rejects(f.bundle(true), /完整性校验失败/);
  assert.deepEqual(await fs.readdir(f.destination), ['existing.txt']);
});

test('game export collision preflight and concurrent folder claim never replace or delete unrelated output', async (t) => {
  const f = await fixture(t);
  const first = await f.bundle(),
    second = await f.bundle();
  assert.notEqual(first, second);
  assert(second.endsWith('(2)'));
  f.store.fault = async (phase, { folder }) => {
    if (phase === 'before-game-export-publish') {
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, 'owned-by-other.txt'), 'keep');
    }
  };
  await assert.rejects(f.bundle());
  assert.equal(await read(path.join(f.destination, '测试游戏-游戏导出 (3)', 'owned-by-other.txt')), 'keep');
  assert(!(await fs.readdir(f.destination)).some((name) => name.startsWith('.savehub-games-')));
});

test('game package path traversal, duplicate paths and missing save payloads cannot be imported', async (t) => {
  const f = await fixture(t);
  await f.add('进度');
  const folder = await f.bundle(true);
  const index = path.join(folder, 'games.json'),
    original = JSON.parse(await read(index));
  for (const games of [['../escape'], ['测试游戏', '测试游戏']]) {
    await atomicJson(index, { ...original, games });
    await assert.rejects(f.target.prepareGameImport(folder), /安全|重复|目录/);
  }
  await atomicJson(index, original);
  await fs.rename(path.join(folder, '测试游戏', 'snapshots'), path.join(folder, 'retained-saves'));
  const plan = await f.target.prepareGameImport(folder);
  await assert.rejects(f.target.reviewGameImport(plan.id, []), /清单/);
  assert.equal(f.target.config.games.length, 0);
});

test('bundled overwrite uses the existing replacement rollback and reports save failure separately from game configuration', async (t) => {
  const f = await fixture(t);
  const save = await f.add('进度');
  const folder = await f.bundle(true);
  const result = await review(f.store, folder, 'overwrite'),
    decisions = saveChoices(result.review, 'overwrite');
  f.store.fault = async (phase) => {
    if (phase === 'after-import-install') throw new Error('replacement failure');
  };
  const report = await f.store.executeGameImport(result.review.id, decisions);
  assert.deepEqual(report.games.overwritten, ['测试游戏']);
  assert.equal(report.snapshots[0].report.failed.length, 1);
  assert.equal(await read(f.payload(f.store, f.id, save)), 'original-progress');
  await f.store.verify(f.id, save.id);
});

async function deferredReplacement(f) {
  await f.add('覆盖事务');
  const folder = await f.bundle(true);
  const result = await review(f.store, folder, 'overwrite');
  f.store.finishImportReplacement = async () => {
    throw new Error('deferred cleanup');
  };
  await f.store.executeGameImport(result.review.id, saveChoices(result.review, 'overwrite'));
  assert.equal((await fs.readdir(path.join(f.store.dataDir, 'import-transactions'))).length, 1);
}

test('game purge removes deferred replacement journals so restart never resurrects intentionally deleted saves', async (t) => {
  const f = await fixture(t);
  await deferredReplacement(f);
  await f.store.removeGame(f.id, false, true);
  assert.deepEqual(await fs.readdir(path.join(f.store.dataDir, 'import-transactions')), []);
  const resumed = await new SaveStore(f.store.dataDir).init();
  assert.deepEqual(await resumed.snapshots(f.id, true), []);
  assert(!resumed.config.games.some((game) => game.id === f.id));
  await assert.rejects(fs.stat(resumed.gameDir(f.id)), { code: 'ENOENT' });
});

test('an interrupted whole-game purge takes precedence over import rollback even if cleanup fails again at startup', async (t) => {
  const f = await fixture(t);
  await deferredReplacement(f);
  f.store.fault = async (phase, { directory }) => {
    if (phase === 'before-game-purge-remove') {
      await fs.rm(directory, { recursive: true, force: true });
      throw new Error('interrupted after removal');
    }
  };
  await assert.rejects(f.store.removeGame(f.id, false, true), /interrupted/);
  const resumed = await new SaveStore(f.store.dataDir, {
    fault: async (phase) => {
      if (phase === 'before-game-purge-remove') throw new Error('still locked');
    },
  }).init();
  assert(resumed.game(f.id, true).purgeGamePending);
  assert.equal(resumed.recoveryMessages.length, 1);
  assert.deepEqual(await resumed.snapshots(f.id, true), []);
  resumed.commitGame = async () => {
    throw new Error('Retry must not recreate the game cache directory');
  };
  resumed.fault = async () => {};
  await resumed.removeGame(f.id, false, true);
  assert.deepEqual(await fs.readdir(path.join(f.store.dataDir, 'import-transactions')), []);
  await new SaveStore(f.store.dataDir).init();
});

test('a failed final config commit leaves durable whole-game deletion intent and restart removes it without recreating the directory', async (t) => {
  const f = await fixture(t);
  await f.add('删除');
  const saveConfig = f.store.saveConfig.bind(f.store);
  f.store.saveConfig = async () => {
    if (!f.store.config.games.some((game) => game.id === f.id)) throw new Error('config locked');
    return saveConfig();
  };
  await assert.rejects(f.store.removeGame(f.id, false, true), /config locked/);
  assert(f.store.game(f.id, true).purgeGamePending);
  assert(JSON.parse(await read(f.store.configFile)).games.some((game) => game.id === f.id && game.purgeGamePending));
  await assert.rejects(fs.stat(f.store.gameDir(f.id)), { code: 'ENOENT' });
  const resumed = await new SaveStore(f.store.dataDir).init([f.store.game(f.id, true)]);
  assert.deepEqual(resumed.config.games, []);
  assert.deepEqual((await resumed.state()).games, []);
  await assert.rejects(fs.stat(resumed.gameDir(f.id)), { code: 'ENOENT' });
  await assert.rejects(resumed.removeGame(f.id, true), /找不到/);
});

test('older snapshot-only cleanup intents retain their original scope during startup recovery', async (t) => {
  const f = await fixture(t);
  await f.add('旧清理');
  const game = { ...f.store.game(f.id), deletedAt: new Date().toISOString(), purgeSnapshotsPending: true };
  await f.store.commitGame(game);
  const resumed = await new SaveStore(f.store.dataDir).init();
  assert(resumed.game(f.id, true).deletedAt);
  assert(!resumed.game(f.id, true).purgeSnapshotsPending);
  assert((await fs.stat(path.join(resumed.gameDir(f.id), 'game.json'))).isFile());
  assert.deepEqual(await resumed.snapshots(f.id, true), []);
  await resumed.removeGame(f.id, true);
  assert.equal(resumed.game(f.id).name, f.input.name);
});

test('a game named games.json round-trips and concurrent metadata publication keeps the existing file intact', async (t) => {
  const f = await fixture(t),
    id = await f.store.upsertGame({ ...f.input, name: 'games.json' });
  const folder = await f.bundle(false, [f.id, id]);
  const result = await review(f.target, folder);
  assert.equal(result.plan.items.length, 2);
  assert.equal(result.plan.failed.length, 0);
  await f.target.executeGameImport(result.review.id, []);
  assert(f.target.config.games.some((game) => game.name === 'games.json'));
  let claimed;
  f.store.fault = async (phase, { target, name }) => {
    if (phase === 'before-game-export-entry-publish' && name === 'games.json') {
      claimed = target;
      await fs.writeFile(target, 'owned-by-another-process', { flag: 'wx' });
    }
  };
  await assert.rejects(f.bundle());
  assert.equal(await read(claimed), 'owned-by-another-process');
});

test('moving a combined bundle preserves game and save duplicate identity with explicit targets for multiple copies', async (t) => {
  const f = await fixture(t);
  await f.add('重复进度');
  const folder = await f.bundle(true);
  let result = await review(f.target, folder);
  await f.target.executeGameImport(result.review.id, saveChoices(result.review));
  const id = f.target.config.games[0].id,
    original = (await f.target.snapshots(id))[0];
  const moved = path.join(f.destination, 'moved-bundle');
  await fs.rename(folder, moved);
  result = await review(f.target, moved, 'overwrite');
  assert.equal(result.review.games[0].snapshots.items[0].matches[0].id, original.id);
  await f.target.executeGameImport(result.review.id, saveChoices(result.review, 'keep-both'));
  result = await review(f.target, moved, 'overwrite');
  const item = result.review.games[0].snapshots.items[0];
  assert.equal(item.matches.length, 2);
  const selected = saveChoices(result.review, 'overwrite');
  selected[0].decisions[0].targetId = item.matches.find((save) => save.id !== original.id).id;
  const report = await f.target.executeGameImport(result.review.id, selected);
  assert.deepEqual(report.snapshots[0].report.overwritten, ['重复进度']);
  assert.equal((await f.target.snapshots(id)).length, 2);
});
