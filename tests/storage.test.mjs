import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SaveStore, cleanItems, within, atomicJson } from '../electron/storage.mjs';
import { readLiteralScript } from '../electron/presets.mjs';

const testRoot = path.resolve('.test-data');
async function fixture(t, options = {}) {
  await fs.mkdir(testRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(testRoot, 'core-'));
  t.after(async () => { assert(within(testRoot, base) && base !== testRoot); await fs.rm(base, { recursive: true, force: true }); });
  const source = path.join(base, 'game');
  await fs.mkdir(path.join(source, 'saves', '空目录'), { recursive: true });
  await fs.writeFile(path.join(source, 'saves', '角色 1.sl2'), 'original-data');
  await fs.writeFile(path.join(source, 'preferences'), 'setting-A');
  await fs.writeFile(path.join(source, 'unmanaged.txt'), 'never touch');
  const store = await new SaveStore(path.join(base, 'data'), options).init();
  const input = { name: '测试游戏', subtitle: 'TEST GAME', icon: 'ring', color: '#8a9270', legacyRoot: '', locations: { win32: { root: source, items: ['saves', 'preferences'] }, darwin: { root: source, items: ['saves', 'preferences'] } } };
  const id = await store.upsertGame(input);
  return { base, source, store, id, input };
}
const read = file => fs.readFile(file, 'utf8');
const save = (store, id, label = '第一份存档') => store.createSnapshot(id, { label, note: '测试记录' });

test('favorite, protected and trash flags retain one original snapshot and unchanged payload', async t => {
  const { store, id } = await fixture(t);
  const snapshot = await save(store, id);
  const original = await store.verify(id, snapshot.id);
  await store.updateSnapshot(id, snapshot.id, { favorite: true, protected: true });
  await store.updateSnapshots(id, [snapshot.id], { deleted: true });
  let marked = await store.readSnapshot(id, snapshot.id);
  assert(marked.favorite && marked.protected && marked.deletedAt);
  await store.updateSnapshots(id, [snapshot.id], { deleted: false });
  marked = await store.verify(id, snapshot.id);
  assert(marked.favorite && marked.protected && !marked.deletedAt);
  assert.equal(marked.id, original.id);
  assert.equal(marked.createdAt, original.createdAt);
  assert.equal(marked.fingerprint, original.fingerprint);
  assert.deepEqual(marked.records, original.records);
  assert.deepEqual((await store.snapshots(id, true)).map(item => item.id), [snapshot.id]);
  await store.updateSnapshot(id, snapshot.id, { protected: false });
  assert.equal((await store.verify(id, snapshot.id)).protected, false);
});

test('legacy automatic backups remain readable and are separate from user snapshots in state', async t => {
  const { store, id } = await fixture(t);
  const snapshot = await save(store, id);
  const { safetyId } = await store.restoreSnapshot(id, snapshot.id);
  for (const snapshotId of [snapshot.id, safetyId]) {
    const meta = await store.readSnapshot(id, snapshotId);
    delete meta.protected; // Simulate manifests written before the protection label existed.
    await atomicJson(path.join(store.snapshotDir(id, snapshotId), 'manifest.json'), meta);
  }
  const reopened = await new SaveStore(store.dataDir).init();
  const game = (await reopened.state()).games.find(game => game.id === id);
  assert.deepEqual(game.snapshots.map(item => item.id), [snapshot.id]);
  assert.deepEqual(game.restorePoints.map(item => item.id), [safetyId]);
  await assert.rejects(reopened.updateSnapshot(id, safetyId, { protected: true }), /自动恢复点/);
  await reopened.verify(id, safetyId);
  await reopened.restoreSnapshot(id, safetyId);
  assert.equal((await reopened.state()).games[0].snapshots.length, 1);
  assert.equal((await reopened.state()).games[0].restorePoints.length, 2);
});

test('batch marks validate every identity before changing records and reject cross-game selections', async t => {
  const { store, id, input } = await fixture(t);
  const first = await save(store, id);
  const otherId = await store.upsertGame({ ...input, name: '另一个游戏' });
  const other = await save(store, otherId);
  for (const ids of [[], [first.id, first.id], [first.id, '../escape'], [first.id, other.id]]) {
    await assert.rejects(store.updateSnapshots(id, ids, { deleted: true }));
    assert.equal((await store.readSnapshot(id, first.id)).deletedAt, undefined);
    assert.equal((await store.readSnapshot(otherId, other.id)).deletedAt, undefined);
  }
  await assert.rejects(store.updateSnapshots(id, [first.id], { deleted: true, protected: true }), /不支持/);
});

test('batch mark reports partial disk failures accurately and successful records remain recoverable', async t => {
  let failedId;
  const { store, id } = await fixture(t, { fault: async (phase, record) => { if (phase === 'before-batch-mark' && record.id === failedId) throw new Error('模拟写入失败'); } });
  const first = await save(store, id, '成功项 A'), failed = await save(store, id, '失败项'), last = await save(store, id, '成功项 B');
  failedId = failed.id;
  const report = await store.updateSnapshots(id, [first.id, failed.id, last.id], { deleted: true });
  assert.deepEqual(report.updated, [first.id, last.id]);
  assert.deepEqual(report.failed, [{ id: failed.id, label: '失败项', error: '模拟写入失败' }]);
  assert.equal((await store.readSnapshot(id, failed.id)).deletedAt, undefined);
  assert((await store.readSnapshot(id, first.id)).deletedAt);
  assert((await store.readSnapshot(id, last.id)).deletedAt);
  const recovered = await store.updateSnapshots(id, report.updated, { deleted: false });
  assert.equal(recovered.failed.length, 0);
  assert.equal((await store.snapshots(id)).length, 3);
});

test('export all includes ordinary manual and imported saves but excludes protected, trash and recovery points', async t => {
  const { base, source, store, id } = await fixture(t);
  const ordinary = await save(store, id, '普通'), favorite = await save(store, id, '收藏'), protectedSave = await save(store, id, '保护'), trashed = await save(store, id, '回收站');
  await store.updateSnapshot(id, favorite.id, { favorite: true });
  await store.updateSnapshot(id, protectedSave.id, { protected: true });
  await store.updateSnapshot(id, trashed.id, { deleted: true });
  await store.importLegacy(id, source);
  await store.restoreSnapshot(id, ordinary.id);
  const imported = (await store.snapshots(id)).find(item => item.kind === 'imported');
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  const result = await store.exportSnapshots(id, 'all', destination);
  assert.equal(result.count, 3);
  const collection = JSON.parse(await read(path.join(result.folder, 'collection.json')));
  assert.deepEqual([...collection.snapshots].sort(), [ordinary.id, favorite.id, imported.id].sort());
  assert.equal((await fs.readdir(result.folder)).length, 4);
  for (const snapshotId of collection.snapshots) assert.equal(await read(path.join(result.folder, `SaveHub-${snapshotId}`, 'payload', 'preferences')), 'setting-A');
});

test('selected exports preserve original flags and import as one collection without duplicating imports', async t => {
  const { base, store, id, input } = await fixture(t);
  const protectedSave = await save(store, id, '收藏与保护'), trashed = await save(store, id, '待找回');
  await store.updateSnapshot(id, protectedSave.id, { favorite: true, protected: true });
  await store.updateSnapshot(id, trashed.id, { deleted: true });
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  const result = await store.exportSnapshots(id, [protectedSave.id, trashed.id], destination);
  assert.equal(result.count, 2);
  const exportedTrash = JSON.parse(await read(path.join(result.folder, `SaveHub-${trashed.id}`, 'manifest.json')));
  assert(exportedTrash.deletedAt);
  const other = await new SaveStore(path.join(base, 'imported-library')).init();
  const otherId = await other.upsertGame(input);
  const imported = await other.importLegacy(otherId, result.folder);
  assert.equal(imported.imported.length, 2); assert.deepEqual(imported.failed, []);
  const copies = await other.snapshots(otherId);
  assert(copies.every(item => item.kind === 'imported' && !item.deletedAt));
  const marked = copies.find(item => item.label === '收藏与保护');
  assert(marked.protected && marked.favorite);
  for (const copy of copies) await other.verify(otherId, copy.id);
  const repeated = await other.importLegacy(otherId, result.folder);
  assert.equal(repeated.skipped.length, 2);
  assert.equal((await other.snapshots(otherId)).length, 2);
});

test('corrupt batch exports fail before output and do not disturb existing destination files', async t => {
  const { base, store, id } = await fixture(t);
  const good = await save(store, id), bad = await save(store, id);
  await fs.writeFile(path.join(store.snapshotDir(id, bad.id), 'payload', 'preferences'), 'tampered');
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'existing.txt'), 'keep');
  await assert.rejects(store.exportSnapshots(id, [good.id, bad.id], destination), /完整性校验失败/);
  assert.deepEqual(await fs.readdir(destination), ['existing.txt']);
  assert.equal(await read(path.join(destination, 'existing.txt')), 'keep');
  await assert.rejects(store.exportSnapshots(id, [good.id], store.dataDir), /资料库以外/);
});

test('collection imports reject path traversal and report tampered exports without creating a save', async t => {
  const { base, store, id } = await fixture(t);
  const directory = path.join(base, 'malicious'); await fs.mkdir(directory);
  await atomicJson(path.join(directory, 'collection.json'), { version: 1, type: 'savehub-collection', snapshots: ['../escape'] });
  await assert.rejects(store.importLegacy(id, directory));
  assert.equal((await store.snapshots(id)).length, 0);
  const snapshot = await save(store, id);
  const result = await store.exportSnapshots(id, [snapshot.id], directory);
  await fs.writeFile(path.join(result.folder, `SaveHub-${snapshot.id}`, 'payload', 'preferences'), 'tampered');
  const report = await store.importLegacy(id, result.folder);
  assert.equal(report.imported.length, 0);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].error, /完整性校验失败/);
  assert.equal((await store.snapshots(id)).length, 1);
});

test('relative paths reject traversal, absolute paths, overlaps, aliases and reserved names', () => {
  for (const items of [['../elsewhere'], ['/root'], ['C:\\save'], ['\\\\host\\share'], ['a//b'], ['a', 'a/b'], ['Save', 'save'], ['a/..'], ['file:stream'], ['CON'], ['aux.txt'], ['a.'], ['file?'], []]) assert.throws(() => cleanItems(items));
  assert.deepEqual(cleanItems(['saves\\角色 一', 'preferences']), ['saves/角色 一', 'preferences']);
});

test('script reader translates Git Bash paths without executing shell code', () => {
  const parsed = readLiteralScript("source='/c/Users/Limbo/Desktop/SlayTheSpire'\ntarget='/d/Steam/steamapps/common/SlayTheSpire'\narray=('betaPreferences' 'preferences' 'saves')\nrm -rf /", 'win32');
  assert.equal(parsed.root, 'D:/Steam/steamapps/common/SlayTheSpire');
  assert.equal(parsed.legacyRoot, 'C:/Users/Limbo/Desktop/SlayTheSpire');
  assert.deepEqual(parsed.items, ['betaPreferences', 'preferences', 'saves']);
});

test('snapshot preserves file bytes, empty folders, timestamps and independent game identity', async t => {
  const { source, store, id, input } = await fixture(t);
  const date = new Date('2020-01-02T12:00:00Z');
  await fs.utimes(path.join(source, 'saves', '角色 1.sl2'), date, date);
  const snapshot = await save(store, id);
  assert.equal(snapshot.fileCount, 2);
  const payload = path.join(store.snapshotDir(id, snapshot.id), 'payload');
  assert.equal(await read(path.join(payload, 'saves', '角色 1.sl2')), 'original-data');
  assert((await fs.stat(path.join(payload, 'saves', '空目录'))).isDirectory());
  assert.equal((await fs.stat(path.join(payload, 'saves', '角色 1.sl2'))).mtimeMs, date.getTime());
  await store.verifySnapshot(id, snapshot.id);
  const second = await store.upsertGame({ ...input, name: '另一个游戏' });
  assert.deepEqual(await store.snapshots(second), []);
  await assert.rejects(store.restoreSnapshot(second, snapshot.id));
});

test('restore replaces complete selected content, protects current progress and supports undo', async t => {
  const { source, store, id } = await fixture(t);
  const snapshot = await save(store, id);
  await fs.writeFile(path.join(source, 'saves', '角色 1.sl2'), 'new-progress');
  await fs.writeFile(path.join(source, 'saves', 'extra.tmp'), 'new-file');
  await fs.writeFile(path.join(source, 'preferences'), 'setting-B');
  const { safetyId } = await store.restoreSnapshot(id, snapshot.id);
  assert.equal(await read(path.join(source, 'saves', '角色 1.sl2')), 'original-data');
  assert.equal(await read(path.join(source, 'preferences')), 'setting-A');
  await assert.rejects(fs.stat(path.join(source, 'saves', 'extra.tmp')), { code: 'ENOENT' });
  assert.equal(await read(path.join(source, 'unmanaged.txt')), 'never touch');
  assert.equal((await store.readSnapshot(id, safetyId)).kind, 'safety');
  await store.restoreSnapshot(id, safetyId);
  assert.equal(await read(path.join(source, 'saves', '角色 1.sl2')), 'new-progress');
  assert.equal(await read(path.join(source, 'saves', 'extra.tmp')), 'new-file');
  assert.equal(await read(path.join(source, 'preferences')), 'setting-B');
});

test('safety snapshots remember absent paths and can restore that absence', async t => {
  const { source, store, id } = await fixture(t);
  const snapshot = await save(store, id);
  const preferences = path.join(source, 'preferences');
  assert(within(source, preferences)); await fs.rm(preferences);
  const { safetyId } = await store.restoreSnapshot(id, snapshot.id);
  assert.equal(await read(preferences), 'setting-A');
  assert.deepEqual((await store.readSnapshot(id, safetyId)).absent, ['preferences']);
  await store.restoreSnapshot(id, safetyId);
  await assert.rejects(fs.stat(preferences), { code: 'ENOENT' });
});

test('corrupted snapshot fails before changing game files or creating a safety copy', async t => {
  const { source, store, id } = await fixture(t);
  const snapshot = await save(store, id);
  await fs.writeFile(path.join(store.snapshotDir(id, snapshot.id), 'payload', 'preferences'), 'tampered');
  await fs.writeFile(path.join(source, 'preferences'), 'current-live');
  await assert.rejects(store.restoreSnapshot(id, snapshot.id), /完整性校验失败/);
  assert.equal(await read(path.join(source, 'preferences')), 'current-live');
  assert.equal((await store.snapshots(id)).length, 1);
});

test('partial multi-entry restore failure rolls back every modified target', async t => {
  const { source, store, id } = await fixture(t, { fault: async phase => { if (phase === 'after-install') throw new Error('模拟磁盘错误'); } });
  const snapshot = await save(store, id);
  await fs.writeFile(path.join(source, 'saves', '角色 1.sl2'), 'before-restore');
  await fs.writeFile(path.join(source, 'preferences'), 'before-preferences');
  await assert.rejects(store.restoreSnapshot(id, snapshot.id), /原存档已保留或恢复/);
  assert.equal(await read(path.join(source, 'saves', '角色 1.sl2')), 'before-restore');
  assert.equal(await read(path.join(source, 'preferences')), 'before-preferences');
  const reopened = await new SaveStore(store.dataDir).init();
  assert.equal((await reopened.snapshots(id)).length, 2);
});

test('startup recovers a journal left between rename and completion', async t => {
  const { source, store, id } = await fixture(t);
  const transactionId = randomUUID();
  const stage = path.join(source, `.savehub-restore-${transactionId}`);
  await fs.mkdir(path.join(stage, 'previous'), { recursive: true });
  await fs.rename(path.join(source, 'saves'), path.join(stage, 'previous', 'saves'));
  await fs.mkdir(path.join(source, 'saves'));
  await fs.writeFile(path.join(source, 'saves', '角色 1.sl2'), 'half-restored');
  await atomicJson(path.join(store.dataDir, 'transactions', `${transactionId}.json`), { version: 1, id: transactionId, gameId: id, root: source, stage, entries: ['saves', 'preferences'], operations: [{ entry: 'saves', hadTarget: true }], status: 'applying' });
  const recovered = await new SaveStore(store.dataDir).init();
  assert.equal(await read(path.join(source, 'saves', '角色 1.sl2')), 'original-data');
  assert.equal(recovered.recoveryMessages.length, 1);
  assert.equal(await read(path.join(stage, 'failed', 'saves', '角色 1.sl2')), 'half-restored');
});

test('directory junctions cannot be followed into another location', async t => {
  const { source, store, id, base } = await fixture(t);
  const outside = path.join(base, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret'), 'outside');
  await fs.symlink(outside, path.join(source, 'saves', 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(save(store, id), /符号链接|目录联接/);
  assert.equal(await read(path.join(outside, 'secret')), 'outside');
  assert.equal((await store.snapshots(id)).length, 0);
});

test('overlap with application storage is rejected', async t => {
  const { store, id, input, base } = await fixture(t);
  await store.upsertGame({ ...input, id, locations: { ...input.locations, [store.platform]: { root: base, items: ['data'] } } });
  await assert.rejects(save(store, id), /重叠/);
});

test('missing source files cannot produce a misleading successful backup', async t => {
  const { source, store, id } = await fixture(t);
  await fs.rm(path.join(source, 'preferences'));
  await assert.rejects(save(store, id), /找不到存档路径/);
  assert.deepEqual(await store.snapshots(id), []);
});

test('files changing during backup cause it to fail without a committed snapshot', async t => {
  const { source, store, id } = await fixture(t);
  let mutated = false;
  store.onProgress = progress => {
    if (!mutated && progress?.phase === 'copying') { mutated = true; writeFileSync(path.join(source, 'preferences'), 'changed-while-copying'); }
  };
  await assert.rejects(save(store, id), /发生变化|校验失败/);
  assert.equal((await store.snapshots(id)).length, 0);
});

test('legacy import accepts arbitrary ArchiveFile suffixes, reports failures and deduplicates', async t => {
  const { source, base, store, id } = await fixture(t);
  const legacy = path.join(base, 'legacy');
  for (const name of ['ArchiveFile0', 'ArchiveFile10th-DLC-1st-1level']) await fs.cp(source, path.join(legacy, name), { recursive: true });
  await fs.mkdir(path.join(legacy, 'ArchiveFileBroken'));
  const report = await store.importLegacy(id, legacy);
  assert.equal(report.imported.length, 2); assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].name, 'ArchiveFileBroken');
  const again = await store.importLegacy(id, legacy);
  assert.equal(again.imported.length, 0); assert.equal(again.skipped.length, 2);
  assert.equal(await read(path.join(legacy, 'ArchiveFile0', 'preferences')), 'setting-A');
});

test('snapshot export can be verified and imported into an independent library', async t => {
  const { base, store, id, input } = await fixture(t);
  const snapshot = await save(store, id);
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  const exported = await store.exportSnapshot(id, snapshot.id, destination);
  const other = await new SaveStore(path.join(base, 'other')).init();
  const gameId = await other.upsertGame(input);
  const report = await other.importLegacy(gameId, exported);
  assert.equal(report.imported.length, 1);
  await other.verifySnapshot(gameId, (await other.snapshots(gameId))[0].id);
  await assert.rejects(store.exportSnapshot(id, snapshot.id, destination), /已存在/);
});

test('game removal, snapshot trash, favorites and theme choices persist and are reversible', async t => {
  const { store, id } = await fixture(t);
  const snapshot = await save(store, id);
  await store.updateSnapshot(id, snapshot.id, { label: '新名字', note: '备注', favorite: true, deleted: true });
  assert.equal((await store.snapshots(id)).length, 0);
  await assert.rejects(store.restoreSnapshot(id, snapshot.id), /回收站/);
  await store.updateSnapshot(id, snapshot.id, { deleted: false });
  await store.removeGame(id);
  await store.setTheme('glass');
  const reopened = await new SaveStore(store.dataDir).init();
  assert.equal((await reopened.state()).theme, 'glass');
  assert.throws(() => reopened.game(id), /找不到/);
  await reopened.removeGame(id, true);
  const restored = (await reopened.snapshots(id))[0];
  assert.equal(restored.label, '新名字'); assert.equal(restored.favorite, true);
});

test('corrupt configuration is not silently replaced with an empty library', async t => {
  const { store } = await fixture(t);
  await fs.writeFile(store.configFile, '{broken');
  await assert.rejects(new SaveStore(store.dataDir).init(), /原文件已保留/);
  assert.equal(await read(store.configFile), '{broken');
});

test('malicious manifest paths cannot escape the snapshot', async t => {
  const { store, id, source } = await fixture(t);
  const snapshot = await save(store, id);
  const file = path.join(store.snapshotDir(id, snapshot.id), 'manifest.json');
  const meta = JSON.parse(await read(file));
  meta.records[0].path = '../../unmanaged.txt'; await atomicJson(file, meta);
  await assert.rejects(store.restoreSnapshot(id, snapshot.id), /不安全/);
  assert.equal(await read(path.join(source, 'unmanaged.txt')), 'never touch');
});

test('separate platform locations are selected for macOS without hardcoded Windows operations', async t => {
  const { store, id, input } = await fixture(t, { platform: 'darwin' });
  await store.upsertGame({ ...input, id, locations: { ...input.locations, win32: { root: 'Z:\\Not-a-real-folder', items: ['other'] } } });
  const snapshot = await save(store, id);
  assert.equal(snapshot.platform, 'darwin');
  assert.equal(snapshot.fileCount, 2);
});

test('restoring with a changed entry configuration is refused', async t => {
  const { store, id, input } = await fixture(t);
  const snapshot = await save(store, id);
  await store.upsertGame({ ...input, id, locations: { ...input.locations, [store.platform]: { ...input.locations[store.platform], items: ['preferences'] } } });
  await assert.rejects(store.restoreSnapshot(id, snapshot.id), /不一致/);
});

test('simultaneous writes are refused until the restore completes', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let reached;
  const signal = new Promise(resolve => { reached = resolve; });
  const { store, id } = await fixture(t, { fault: async () => { reached(); await gate; } });
  const snapshot = await save(store, id);
  const restoring = store.restoreSnapshot(id, snapshot.id);
  await signal;
  await assert.rejects(store.setTheme('tech'), /正在进行/);
  release(); await restoring;
  assert.equal(store.busy, false);
});
