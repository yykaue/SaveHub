import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SaveStore, cleanItems, within, atomicJson, commitSnapshotDirectory } from '../electron/storage.mjs';
import { readLiteralScript, makePresets } from '../electron/presets.mjs';

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

test('snapshot commit tolerates brief Windows directory locks and preserves exact content', async t => {
  const { base } = await fixture(t);
  const source = path.join(base, 'pending'), destination = path.join(base, 'committed');
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'save.dat'), 'verified-content');
  let attempts = 0;
  await commitSnapshotDirectory(source, destination, { platform: 'win32', rename: async (from, to) => {
    attempts++;
    if (attempts <= 2) throw Object.assign(new Error('temporary lock'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
    await fs.rename(from, to);
  } });
  assert(attempts >= 3 && attempts <= 5);
  assert.equal(await read(path.join(destination, 'save.dat')), 'verified-content');
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
});

test('snapshot commit bounds retries, preserves permanent errors and refuses retry over existing output', async t => {
  const { base } = await fixture(t);
  const source = path.join(base, 'pending'), destination = path.join(base, 'committed');
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'save.dat'), 'source');
  for (const [platform, code, expectedAttempts] of [['win32', 'EACCES', 5], ['win32', 'ENOENT', 1], ['darwin', 'EPERM', 1]]) {
    let attempts = 0; const waits = [];
    const error = Object.assign(new Error('persistent error'), { code });
    await assert.rejects(commitSnapshotDirectory(source, destination, { platform, rename: async () => { attempts++; throw error; }, pause: async ms => { waits.push(ms); } }), value => value === error);
    assert.equal(attempts, expectedAttempts);
    assert.deepEqual(waits, expectedAttempts === 5 ? [50, 100, 150, 200] : []);
    assert.equal(await read(path.join(source, 'save.dat')), 'source');
  }
  await fs.mkdir(destination); await fs.writeFile(path.join(destination, 'existing.dat'), 'keep');
  let attempts = 0;
  await assert.rejects(commitSnapshotDirectory(source, destination, { platform: 'win32', rename: async () => { attempts++; throw Object.assign(new Error('occupied'), { code: 'EPERM' }); } }), /occupied/);
  assert.equal(attempts, 1);
  assert.equal(await read(path.join(destination, 'existing.dat')), 'keep');
  assert.equal(await read(path.join(source, 'save.dat')), 'source');
});

test('favorite, protected and trash flags retain one original snapshot and unchanged payload', async t => {
  const { store, id } = await fixture(t);
  const snapshot = await save(store, id);
  const original = await store.verify(id, snapshot.id);
  await store.updateSnapshot(id, snapshot.id, { favorite: true, protected: true });
  await assert.rejects(store.updateSnapshots(id, [snapshot.id], { deleted: true }), /先取消保护/);
  await store.updateSnapshot(id, snapshot.id, { protected: false });
  await store.updateSnapshots(id, [snapshot.id], { deleted: true });
  let marked = await store.readSnapshot(id, snapshot.id);
  assert(marked.favorite && !marked.protected && marked.deletedAt);
  await store.updateSnapshots(id, [snapshot.id], { deleted: false });
  await store.updateSnapshots(id, [snapshot.id], { protected: true });
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

test('export all includes favorite and protected saves but excludes trash and recovery points', async t => {
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
  assert.equal(result.count, 4);
  assert.deepEqual(await fs.readdir(destination), [path.basename(result.folder)]);
  assert.equal(path.dirname(result.folder), destination);
  const collection = JSON.parse(await read(result.indexFile));
  assert.deepEqual(collection.snapshots.map(item => item.manifest.id).sort(), [ordinary.id, favorite.id, protectedSave.id, imported.id].sort());
  assert.equal((await fs.readdir(result.folder)).length, 5);
  for (const item of collection.snapshots) assert.equal(await read(path.join(result.folder, item.directory, 'preferences')), 'setting-A');
});

test('permanent deletion removes selected trash and removed restore point files without touching live saves', async t => {
  const { source, store, id } = await fixture(t);
  const kept = await save(store, id, '保留'), favorite = await save(store, id, '收藏');
  await store.updateSnapshot(id, favorite.id, { favorite: true });
  const { safetyId } = await store.restoreSnapshot(id, kept.id);
  await store.updateSnapshots(id, [favorite.id, safetyId], { deleted: true });
  const report = await store.deleteSnapshots(id, [favorite.id, safetyId]);
  assert.deepEqual(report, { updated: [favorite.id, safetyId], failed: [] });
  assert.deepEqual(await fs.readdir(path.dirname(store.snapshotDir(id, kept.id))), [kept.id]);
  for (const deleted of [favorite.id, safetyId]) {
    await assert.rejects(fs.stat(store.snapshotDir(id, deleted)), { code: 'ENOENT' });
    await assert.rejects(store.updateSnapshot(id, deleted, { deleted: false }), { code: 'ENOENT' });
  }
  assert.equal((await store.snapshots(id, true)).length, 1);
  await store.verify(id, kept.id);
  assert.equal(await read(path.join(source, 'preferences')), 'setting-A');
  assert.equal(await read(path.join(source, 'unmanaged.txt')), 'never touch');
});

test('permanent deletion preflights all records and refuses active, protected, duplicate or foreign selections', async t => {
  const { store, id, input } = await fixture(t);
  const trash = await save(store, id, '待删除'), active = await save(store, id, '仍在使用'), protectedSave = await save(store, id, '保护');
  await store.updateSnapshots(id, [trash.id, protectedSave.id], { deleted: true });
  // Simulate a protected trash record created by an older version.
  await atomicJson(path.join(store.snapshotDir(id, protectedSave.id), 'manifest.json'), { ...await store.readSnapshot(id, protectedSave.id), protected: true, favorite: true });
  const otherId = await store.upsertGame({ ...input, name: '另一个游戏' });
  const foreign = await save(store, otherId);
  for (const ids of [[trash.id, active.id], [trash.id, protectedSave.id], [trash.id, trash.id], [trash.id, foreign.id], [trash.id, '../escape'], []]) {
    await assert.rejects(store.deleteSnapshots(id, ids));
    assert.equal((await store.readSnapshot(id, trash.id)).purgePending, undefined);
    await store.verify(id, trash.id);
  }
  await assert.rejects(store.deleteSnapshots(id, 'all'));
  assert.equal((await store.readSnapshot(id, protectedSave.id)).protected, true);
  await assert.rejects(store.updateSnapshot(id, protectedSave.id, { protected: false }), /先.*找回/);
  await store.updateSnapshot(id, protectedSave.id, { deleted: false });
  await store.updateSnapshot(id, protectedSave.id, { protected: false });
  await store.updateSnapshot(id, protectedSave.id, { deleted: true });
  assert.deepEqual((await store.deleteSnapshots(id, [protectedSave.id])).updated, [protectedSave.id]);
  await store.verify(otherId, foreign.id);
});

test('permanent deletion refuses nested junctions before deleting any selected record', async t => {
  const { base, store, id } = await fixture(t);
  const first = await save(store, id), linked = await save(store, id);
  await store.updateSnapshots(id, [first.id, linked.id], { deleted: true });
  const outside = path.join(base, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep'), 'untouched');
  const junction = path.join(store.snapshotDir(id, linked.id), 'payload', 'junction');
  await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.deleteSnapshots(id, [first.id, linked.id]), /符号链接|目录联接/);
  assert.equal(await read(path.join(outside, 'keep')), 'untouched');
  assert.equal((await store.readSnapshot(id, first.id)).purgePending, undefined);
  await store.verify(id, first.id);
  await fs.unlink(junction);
});

test('permanent deletion reports individual failures and leaves untouched records recoverable', async t => {
  let failedId;
  const { store, id } = await fixture(t, { fault: async (phase, meta) => { if (phase === 'before-purge' && meta.id === failedId) throw new Error('模拟拒绝访问'); } });
  const a = await save(store, id, '成功 A'), b = await save(store, id, '失败'), c = await save(store, id, '成功 C');
  failedId = b.id;
  await store.updateSnapshots(id, [a.id, b.id, c.id], { deleted: true });
  assert.deepEqual(await store.deleteSnapshots(id, [a.id, b.id, c.id]), { updated: [a.id, c.id], failed: [{ id: b.id, label: b.label, error: '模拟拒绝访问' }] });
  assert.equal((await store.readSnapshot(id, b.id)).purgePending, undefined);
  await store.updateSnapshot(id, b.id, { deleted: false });
  await store.verify(id, b.id);
  assert.deepEqual((await store.snapshots(id, true)).map(item => item.id), [b.id]);
});

test('partially deleted saves and restore points survive restart as retry-only records', async t => {
  const pendingIds = new Set();
  const { base, store, id } = await fixture(t, { fault: async (phase, item) => {
    if (phase === 'before-purge-remove' && pendingIds.has(item.id)) {
      await fs.rm(path.join(item.stage, 'manifest.json'));
      await fs.rm(path.join(item.stage, 'payload', 'preferences'));
      throw new Error('模拟永久删除中断');
    }
  } });
  const kept = await save(store, id, '保留'), trash = await save(store, id, '待清理');
  const { safetyId } = await store.restoreSnapshot(id, kept.id);
  for (const item of [trash.id, safetyId]) pendingIds.add(item);
  await store.updateSnapshots(id, [...pendingIds], { deleted: true });
  const report = await store.deleteSnapshots(id, [...pendingIds]);
  assert.deepEqual(report.updated, []); assert.equal(report.failed.length, 2);
  const reopened = await new SaveStore(store.dataDir).init();
  const game = (await reopened.state()).games.find(game => game.id === id);
  assert.equal(game.snapshots.find(item => item.id === trash.id).purgePending, true);
  assert.equal(game.restorePoints.find(item => item.id === safetyId).purgePending, true);
  for (const item of pendingIds) {
    await assert.rejects(reopened.updateSnapshot(id, item, { deleted: false }), /永久删除/);
    await assert.rejects(reopened.updateSnapshot(id, item, { protected: true }), /永久删除/);
    await assert.rejects(reopened.updateSnapshots(id, [item], { deleted: false }), /永久删除/);
    await assert.rejects(reopened.verify(id, item), /永久删除/);
  }
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  await assert.rejects(reopened.exportSnapshots(id, [trash.id], destination), /永久删除/);
  assert.deepEqual(await fs.readdir(destination), []);
  assert.deepEqual(await reopened.deleteSnapshots(id, [...pendingIds]), { updated: [...pendingIds], failed: [] });
  assert.deepEqual(await fs.readdir(path.dirname(store.snapshotDir(id, kept.id))), [kept.id]);
  await reopened.verify(id, kept.id);
});

test('a purge interrupted after all payload files disappeared still completes on retry', async t => {
  const { store, id } = await fixture(t, { fault: async (phase, item) => {
    if (phase === 'before-purge-remove') { await fs.rm(item.stage, { recursive: true }); throw new Error('模拟清理结束前中断'); }
  } });
  const snapshot = await save(store, id);
  await store.updateSnapshot(id, snapshot.id, { deleted: true });
  assert.equal((await store.deleteSnapshots(id, [snapshot.id])).failed.length, 1);
  const reopened = await new SaveStore(store.dataDir).init();
  assert.equal((await reopened.snapshots(id, true))[0].purgePending, true);
  assert.deepEqual(await reopened.deleteSnapshots(id, [snapshot.id]), { updated: [snapshot.id], failed: [] });
  assert.deepEqual(await fs.readdir(path.dirname(store.snapshotDir(id, snapshot.id))), []);
});

test('batch removing and recovering restore points preserves IDs and exact original bytes', async t => {
  const { store, id } = await fixture(t);
  const snapshot = await save(store, id);
  const ids = [(await store.restoreSnapshot(id, snapshot.id)).safetyId, (await store.restoreSnapshot(id, snapshot.id)).safetyId];
  const original = await Promise.all(ids.map(item => store.verify(id, item)));
  assert.deepEqual((await store.updateSnapshots(id, ids, { deleted: true })).updated, ids);
  assert((await store.state()).games.find(game => game.id === id).restorePoints.every(item => item.deletedAt));
  assert.deepEqual((await store.updateSnapshots(id, ids, { deleted: false })).updated, ids);
  for (const [index, item] of ids.entries()) assert.deepEqual(await store.verify(id, item), original[index]);
  assert.equal((await store.state()).games.find(game => game.id === id).snapshots.length, 1);
});

test('selected exports preserve original flags and import as one collection without duplicating imports', async t => {
  const { base, store, id, input } = await fixture(t);
  const protectedSave = await save(store, id, '收藏与保护'), trashed = await save(store, id, '待找回');
  await store.updateSnapshot(id, protectedSave.id, { favorite: true, protected: true });
  await store.updateSnapshot(id, trashed.id, { deleted: true });
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  const result = await store.exportSnapshots(id, [protectedSave.id, trashed.id], destination);
  assert.equal(result.count, 2);
  assert.equal(path.dirname(result.folder), destination);
  assert.deepEqual(await fs.readdir(destination), [path.basename(result.folder)]);
  const exportedTrash = JSON.parse(await read(result.indexFile)).snapshots.find(item => item.manifest.id === trashed.id).manifest;
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
  await fs.writeFile(path.join(result.folder, result.directories[0], 'preferences'), 'tampered');
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

test('protection blocks single, mixed batch and combined unprotect/delete requests regardless of favorite', async t => {
  const { store, id } = await fixture(t);
  const normal = await save(store, id, '已收藏'), protectedSave = await save(store, id, '保护');
  await store.updateSnapshot(id, normal.id, { favorite: true });
  await store.updateSnapshot(id, protectedSave.id, { protected: true });
  for (const favorite of [false, true]) {
    await store.updateSnapshot(id, protectedSave.id, { favorite });
    const original = await store.readSnapshot(id, protectedSave.id);
    await assert.rejects(store.updateSnapshot(id, protectedSave.id, { deleted: true }), /先取消保护/);
    await assert.rejects(store.updateSnapshot(id, protectedSave.id, { protected: false, deleted: true }), /先取消保护/);
    await assert.rejects(store.updateSnapshots(id, [normal.id, protectedSave.id], { deleted: true }), /先取消保护/);
    assert.deepEqual(await store.readSnapshot(id, protectedSave.id), original);
  }
  assert.equal((await store.readSnapshot(id, normal.id)).deletedAt, undefined);
  await assert.rejects(store.updateSnapshot(id, normal.id, { protected: true, deleted: true }), /先取消保护/);
  await store.updateSnapshots(id, [protectedSave.id], { protected: false });
  const report = await store.updateSnapshots(id, [normal.id, protectedSave.id], { deleted: true });
  assert.equal(report.updated.length, 2);
  assert.deepEqual(report.failed, []);
});

test('favorites allow single and mixed batch deletion and keep their flag when recovered', async t => {
  const { store, id } = await fixture(t);
  const favorite = await save(store, id, '收藏'), normal = await save(store, id, '普通');
  await store.updateSnapshot(id, favorite.id, { favorite: true });
  await store.updateSnapshot(id, favorite.id, { deleted: true });
  assert((await store.readSnapshot(id, favorite.id)).deletedAt);
  await store.updateSnapshot(id, favorite.id, { deleted: false });
  const report = await store.updateSnapshots(id, [normal.id, favorite.id], { deleted: true });
  assert.deepEqual(report.updated, [normal.id, favorite.id]); assert.deepEqual(report.failed, []);
  await store.updateSnapshots(id, [favorite.id, normal.id], { deleted: false });
  const recovered = await store.verify(id, favorite.id);
  assert(recovered.favorite && !recovered.deletedAt);
});

test('bulk protection selects explicit records or all active game records without changing identity, favorites or other games', async t => {
  const { store, id, input } = await fixture(t);
  const a = await save(store, id, 'A'), b = await save(store, id, 'B'), trash = await save(store, id, '回收');
  await store.updateSnapshot(id, b.id, { favorite: true });
  await store.updateSnapshot(id, trash.id, { deleted: true });
  const { safetyId } = await store.restoreSnapshot(id, a.id);
  const otherId = await store.upsertGame({ ...input, name: '另一游戏' });
  const other = await save(store, otherId);
  const before = await store.verify(id, b.id);
  await store.updateSnapshots(id, [a.id], { protected: true });
  assert.equal((await store.readSnapshot(id, b.id)).protected, false);
  const report = await store.updateSnapshots(id, 'all', { protected: true });
  assert.deepEqual(report.updated.sort(), [a.id, b.id].sort());
  assert.deepEqual(report.failed, []);
  const after = await store.verify(id, b.id);
  assert(after.favorite && after.protected);
  assert.deepEqual(after.records, before.records);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal((await store.readSnapshot(id, trash.id)).protected, false);
  assert.equal((await store.readSnapshot(id, safetyId)).protected, false);
  assert.equal((await store.readSnapshot(otherId, other.id)).protected, false);
  await store.updateSnapshots(id, 'all', { protected: false });
  assert((await store.snapshots(id, true)).every(meta => !meta.protected));
  assert.equal((await store.readSnapshot(id, b.id)).favorite, true);
  await assert.rejects(store.updateSnapshots(id, 'all', { deleted: true }), /仅支持/);
  await assert.rejects(store.updateSnapshots(id, [a.id], { protected: true, deleted: true }), /不支持/);
});

test('trash protection requires recovery first and rejects mixed batches without partial changes', async t => {
  const { store, id } = await fixture(t);
  const active = await save(store, id, '正常存档'), trash = await save(store, id, '回收存档');
  await store.updateSnapshot(id, trash.id, { favorite: true, deleted: true });
  const originals = await Promise.all([active.id, trash.id].map(item => store.readSnapshot(id, item)));
  for (const protectedTag of [true, false]) {
    await assert.rejects(store.updateSnapshot(id, trash.id, { protected: protectedTag }), /先.*找回/);
    await assert.rejects(store.updateSnapshot(id, trash.id, { deleted: false, protected: protectedTag, label: '不能修改' }), /先.*找回/);
    await assert.rejects(store.updateSnapshots(id, [trash.id], { protected: protectedTag }), /先.*找回/);
    await assert.rejects(store.updateSnapshots(id, [active.id, trash.id], { protected: protectedTag }), /先.*找回/);
    assert.deepEqual(await store.verify(id, active.id), originals[0]);
    assert.deepEqual(await store.verify(id, trash.id), originals[1]);
  }
  await store.updateSnapshot(id, trash.id, { deleted: false });
  await store.updateSnapshot(id, trash.id, { protected: true });
  assert((await store.readSnapshot(id, trash.id)).protected);
  await store.updateSnapshot(id, trash.id, { protected: false });
  await store.updateSnapshot(id, trash.id, { deleted: true });
  await store.updateSnapshots(id, [trash.id], { deleted: false });
  assert.deepEqual((await store.updateSnapshots(id, [active.id, trash.id], { protected: true })).updated, [active.id, trash.id]);
  const recovered = await store.verify(id, trash.id);
  assert(recovered.protected && recovered.favorite && !recovered.deletedAt);
  assert.deepEqual(recovered.records, originals[1].records);
});

test('bulk protection rejects automatic restore points before changing any record', async t => {
  const { store, id } = await fixture(t);
  const snapshot = await save(store, id);
  const { safetyId } = await store.restoreSnapshot(id, snapshot.id);
  for (const protectedTag of [true, false]) {
    await assert.rejects(store.updateSnapshots(id, [snapshot.id, safetyId], { protected: protectedTag }), /自动恢复点/);
    assert.equal((await store.readSnapshot(id, snapshot.id)).protected, false);
    assert.equal((await store.readSnapshot(id, safetyId)).protected, false);
  }
});

test('bulk protection reports individual disk failures without changing failed records', async t => {
  let failedId;
  const { store, id } = await fixture(t, { fault: async (phase, meta) => { if (phase === 'before-batch-mark' && meta.id === failedId) throw new Error('磁盘错误'); } });
  const a = await save(store, id, 'A'), b = await save(store, id, 'B'); failedId = b.id;
  const report = await store.updateSnapshots(id, [a.id, b.id], { protected: true });
  assert.deepEqual(report.updated, [a.id]);
  assert.deepEqual(report.failed, [{ id: b.id, label: 'B', error: '磁盘错误' }]);
  assert.equal((await store.readSnapshot(id, a.id)).protected, true);
  assert.equal((await store.readSnapshot(id, b.id)).protected, false);
});

test('exports A B C inside one bundle with named raw content and reimportable metadata', async t => {
  const { base, source, store, id, input } = await fixture(t);
  const snapshots = [];
  for (const label of ['A', 'B', 'C']) {
    await fs.writeFile(path.join(source, 'preferences'), label);
    snapshots.push(await save(store, id, label));
  }
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  const result = await store.exportSnapshots(id, snapshots.map(meta => meta.id), destination);
  assert.equal(result.folder, path.join(destination, '测试游戏-存档导出'));
  assert.deepEqual(await fs.readdir(destination), ['测试游戏-存档导出']);
  assert.deepEqual(result.directories, ['A', 'B', 'C']);
  assert.deepEqual((await fs.readdir(result.folder)).sort(), ['.savehub-exports', 'A', 'B', 'C']);
  for (const label of result.directories) {
    assert.deepEqual((await fs.readdir(path.join(result.folder, label))).sort(), ['preferences', 'saves']);
    assert.equal(await read(path.join(result.folder, label, 'preferences')), label);
    assert((await fs.stat(path.join(result.folder, label, 'saves', '空目录'))).isDirectory());
  }
  const other = await new SaveStore(path.join(base, 'other')).init();
  const otherId = await other.upsertGame(input);
  const report = await other.importLegacy(otherId, result.folder);
  assert.deepEqual(report.imported, ['A', 'B', 'C']);
  assert.deepEqual(report.failed, []);
  for (const meta of await other.snapshots(otherId)) await other.verify(otherId, meta.id);
});

test('export names handle unsafe characters, duplicate names, reserved names and existing folders without overwrites', async t => {
  const { base, store, id } = await fixture(t);
  const labels = ['A', 'A', 'a', '../A:B*?', 'CON', 'NUL.txt', '...', '.savehub-exports', '游'.repeat(100)];
  const snapshots = [];
  for (const label of labels) snapshots.push(await save(store, id, label));
  const destination = path.join(base, 'exports'); await fs.mkdir(path.join(destination, 'A'), { recursive: true });
  await fs.writeFile(path.join(destination, 'A', 'keep.txt'), 'unchanged');
  await fs.mkdir(path.join(destination, '测试游戏-存档导出'));
  await fs.writeFile(path.join(destination, '测试游戏-存档导出 (2)'), 'keep-existing-file');
  const result = await store.exportSnapshots(id, snapshots.map(meta => meta.id), destination);
  assert.equal(path.basename(result.folder), '测试游戏-存档导出 (3)');
  assert.deepEqual(result.directories.slice(0, 3), ['A', 'A (2)', 'a (3)']);
  assert.equal(new Set(result.directories.map(name => name.toLowerCase())).size, labels.length);
  for (const name of result.directories) {
    assert(!name.includes('/') && !name.includes('\\'));
    assert(Buffer.byteLength(name) <= 200);
    cleanItems([name]);
    assert.equal(await read(path.join(result.folder, name, 'preferences')), 'setting-A');
  }
  assert.equal(await read(path.join(destination, 'A', 'keep.txt')), 'unchanged');
  assert.deepEqual(await fs.readdir(path.join(destination, '测试游戏-存档导出')), []);
  assert.equal(await read(path.join(destination, '测试游戏-存档导出 (2)')), 'keep-existing-file');
  const index = JSON.parse(await read(result.indexFile));
  assert.deepEqual(index.snapshots.map(item => item.manifest.label), labels);
});

test('export publication failure rolls back only this batch and keeps existing output', async t => {
  const { base, store, id } = await fixture(t, { fault: async (phase, item) => { if (phase === 'before-export-publish' && item.directory === 'B') throw new Error('发布失败'); } });
  const a = await save(store, id, 'A'), b = await save(store, id, 'B');
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'keep.txt'), 'original');
  await assert.rejects(store.exportSnapshots(id, [a.id, b.id], destination), /发布失败/);
  assert.deepEqual(await fs.readdir(destination), ['keep.txt']);
  assert.equal(await read(path.join(destination, 'keep.txt')), 'original');
});

test('legacy single and collection exports still import with original labels and flags', async t => {
  const { base, store, id, input } = await fixture(t);
  const snapshot = await save(store, id, '旧版存档');
  await store.updateSnapshot(id, snapshot.id, { favorite: true, protected: true });
  const destination = path.join(base, 'legacy-export'); await fs.mkdir(destination);
  await fs.cp(store.snapshotDir(id, snapshot.id), path.join(destination, `SaveHub-${snapshot.id}`), { recursive: true });
  await atomicJson(path.join(destination, 'collection.json'), { version: 1, type: 'savehub-collection', snapshots: [snapshot.id] });
  const other = await new SaveStore(path.join(base, 'other')).init();
  const otherId = await other.upsertGame(input);
  const report = await other.importLegacy(otherId, destination);
  assert.deepEqual(report.imported, ['旧版存档']); assert.deepEqual(report.failed, []);
  const [copy] = await other.snapshots(otherId);
  assert(copy.favorite && copy.protected); await other.verify(otherId, copy.id);
  const repeat = await other.importLegacy(otherId, path.join(destination, `SaveHub-${snapshot.id}`));
  assert.deepEqual(repeat.skipped, ['旧版存档']);
});

test('previous unwrapped named exports still import from their root and individual folder', async t => {
  const { base, store, id, input } = await fixture(t);
  const snapshot = await save(store, id, '旧版名称目录');
  await store.updateSnapshot(id, snapshot.id, { favorite: true, protected: true });
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  const bundle = await store.exportSnapshot(id, snapshot.id, destination);
  // Reproduce the previous layout with the named folder and index at the chosen root.
  for (const child of await fs.readdir(bundle)) await fs.rename(path.join(bundle, child), path.join(destination, child));
  await fs.rmdir(bundle);
  const other = await new SaveStore(path.join(base, 'other')).init();
  const otherId = await other.upsertGame(input);
  const report = await other.importLegacy(otherId, destination);
  assert.deepEqual(report.imported, [snapshot.label]);
  assert.deepEqual(report.failed, []);
  const [copy] = await other.snapshots(otherId);
  assert(copy.favorite && copy.protected);
  await other.verify(otherId, copy.id);
  assert.deepEqual((await other.importLegacy(otherId, path.join(destination, snapshot.label))).skipped, [snapshot.label]);
});

test('single restore point exports are wrapped and preserve missing entries on reimport', async t => {
  const { base, source, store, id, input } = await fixture(t);
  const snapshot = await save(store, id);
  await fs.rm(path.join(source, 'preferences'));
  const { safetyId } = await store.restoreSnapshot(id, snapshot.id);
  const point = await store.readSnapshot(id, safetyId);
  assert.deepEqual(point.absent, ['preferences']);
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  const folder = await store.exportSnapshot(id, safetyId, destination);
  assert.deepEqual(await fs.readdir(destination), [path.basename(folder)]);
  const [indexFile] = await fs.readdir(path.join(folder, '.savehub-exports'));
  const index = JSON.parse(await read(path.join(folder, '.savehub-exports', indexFile)));
  const [item] = index.snapshots;
  assert.equal(item.manifest.kind, 'safety');
  assert.deepEqual((await fs.readdir(folder)).sort(), ['.savehub-exports', item.directory].sort());
  assert.deepEqual(await fs.readdir(path.join(folder, item.directory)), ['saves']);
  const other = await new SaveStore(path.join(base, 'other')).init();
  const otherId = await other.upsertGame(input);
  const report = await other.importLegacy(otherId, folder);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.imported, [point.label]);
  const [copy] = await other.snapshots(otherId);
  assert.deepEqual((await other.verify(otherId, copy.id)).absent, point.absent);
});

test('bundle names do not reuse stale mappings from previous unwrapped exports', async t => {
  const { base, store, id } = await fixture(t);
  const snapshot = await save(store, id, '测试游戏-存档导出');
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  await atomicJson(path.join(destination, '.savehub-exports', 'old.json'), {
    version: 2, type: 'savehub-collection', snapshots: [{ directory: snapshot.label, manifest: await store.readSnapshot(id, snapshot.id) }],
  });
  const folder = await store.exportSnapshot(id, snapshot.id, destination);
  assert.equal(path.basename(folder), '测试游戏-存档导出 (2)');
  const report = await store.importLegacy(id, folder);
  assert.deepEqual(report.imported, [snapshot.label]);
  assert.deepEqual(report.failed, []);
});

test('export bundle names sanitize game names and preserve the original metadata', async t => {
  const { base, store, id, input } = await fixture(t);
  const gameName = 'CON: 游戏/冒险?';
  await store.upsertGame({ ...input, id, name: gameName });
  const snapshot = await save(store, id);
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  const result = await store.exportSnapshots(id, [snapshot.id], destination);
  assert.equal(path.dirname(result.folder), destination);
  cleanItems([path.basename(result.folder)]);
  assert.equal(JSON.parse(await read(result.indexFile)).gameName, gameName);
});

test('moving a whole export bundle keeps metadata portable and repeated exports independent', async t => {
  const { base, store, id } = await fixture(t);
  const snapshot = await save(store, id, 'A');
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  const first = await store.exportSnapshot(id, snapshot.id, destination);
  const moved = path.join(base, 'moved-bundle');
  await fs.rename(first, moved);
  const second = await store.exportSnapshot(id, snapshot.id, destination);
  assert.equal(path.basename(second), '测试游戏-存档导出');
  for (const folder of [moved, second]) {
    assert.deepEqual((await fs.readdir(folder)).sort(), ['.savehub-exports', 'A']);
    const report = await store.importLegacy(id, folder);
    assert.deepEqual(report.imported, ['A']);
    assert.deepEqual(report.failed, []);
  }
});

test('raw game files named manifest.json and collection.json survive named export and import', async t => {
  const { base, source, store, id, input } = await fixture(t);
  for (const file of ['manifest.json', 'collection.json']) await fs.writeFile(path.join(source, file), `game-content-${file}`);
  const modified = { ...input, id, locations: { ...input.locations, [store.platform]: { root: source, items: ['manifest.json', 'collection.json', 'saves'] } } };
  await store.upsertGame(modified);
  const snapshot = await save(store, id, '原始游戏文件');
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  const exported = await store.exportSnapshot(id, snapshot.id, destination);
  const namedFolder = path.join(exported, snapshot.label);
  for (const file of ['manifest.json', 'collection.json']) assert.equal(await read(path.join(namedFolder, file)), `game-content-${file}`);
  const report = await store.importLegacy(id, namedFolder);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.imported, ['原始游戏文件']);
});

test('a directory appearing inside the bundle during publication is never overwritten or removed', async t => {
  const { base, store, id } = await fixture(t);
  const a = await save(store, id, 'A'), b = await save(store, id, 'B');
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  store.fault = async (phase, item) => {
    if (phase === 'before-export-publish' && item.directory === 'B') {
      await fs.mkdir(path.join(item.folder, 'B'));
      await fs.writeFile(path.join(item.folder, 'B', 'external.txt'), 'keep-external');
    }
  };
  await assert.rejects(store.exportSnapshots(id, [a.id, b.id], destination), { code: 'EEXIST' });
  assert.deepEqual(await fs.readdir(destination), ['测试游戏-存档导出']);
  const folder = path.join(destination, '测试游戏-存档导出');
  assert.deepEqual(await fs.readdir(folder), ['B']);
  assert.equal(await read(path.join(folder, 'B', 'external.txt')), 'keep-external');
});

test('an outer folder appearing after export preflight is never overwritten or removed', async t => {
  const { base, store, id } = await fixture(t);
  const snapshot = await save(store, id);
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  store.fault = async (phase, item) => {
    if (phase === 'before-export-bundle-publish') {
      await fs.mkdir(item.folder);
      await fs.writeFile(path.join(item.folder, 'external.txt'), 'keep-external');
    }
  };
  await assert.rejects(store.exportSnapshot(id, snapshot.id, destination), { code: 'EEXIST' });
  assert.deepEqual(await fs.readdir(destination), ['测试游戏-存档导出']);
  assert.equal(await read(path.join(destination, '测试游戏-存档导出', 'external.txt')), 'keep-external');
});

test('named export indexes reject traversal, duplicate directories and symlinks', async t => {
  const { base, store, id } = await fixture(t);
  const snapshot = await save(store, id, 'A');
  const destination = path.join(base, 'exports'); await fs.mkdir(destination);
  const result = await store.exportSnapshots(id, [snapshot.id], destination);
  const index = JSON.parse(await read(result.indexFile));
  for (const name of ['../outside', 'nested/folder', 'C:\\outside', '.savehub-exports']) {
    await atomicJson(result.indexFile, { ...index, snapshots: [{ ...index.snapshots[0], directory: name }] });
    await assert.rejects(store.importLegacy(id, result.folder));
  }
  await atomicJson(result.indexFile, { ...index, snapshots: [index.snapshots[0], index.snapshots[0]] });
  await assert.rejects(store.importLegacy(id, result.folder), /重复/);
  await atomicJson(result.indexFile, index);
  await fs.rename(path.join(result.folder, 'A'), path.join(base, 'outside'));
  await fs.symlink(path.join(base, 'outside'), path.join(result.folder, 'A'), process.platform === 'win32' ? 'junction' : 'dir');
  const report = await store.importLegacy(id, result.folder);
  assert.equal(report.imported.length, 0);
  assert.match(report.failed[0].error, /符号链接|目录联接/);
});

test('script reader translates Git Bash paths without executing shell code', () => {
  const parsed = readLiteralScript("source='/c/Users/Limbo/Desktop/SlayTheSpire'\ntarget='/d/Steam/steamapps/common/SlayTheSpire'\narray=('betaPreferences' 'preferences' 'saves')\nrm -rf /", 'win32');
  assert.equal(parsed.root, 'D:/Steam/steamapps/common/SlayTheSpire');
  assert.equal(parsed.legacyRoot, 'C:/Users/Limbo/Desktop/SlayTheSpire');
  assert.deepEqual(parsed.items, ['betaPreferences', 'preferences', 'saves']);
});

test('presets only derive Windows home paths on Windows', async () => {
  const mac = await makePresets('darwin', '/Users/example');
  const elden = mac.find(game => game.id === 'elden-ring');
  assert.equal(elden.locations.win32.root, '');
  assert.equal(elden.locations.darwin.root, '');
  assert.equal(elden.legacyRoot, '');
  assert(mac.every(game => !game.locations.win32.root.startsWith('/Users/')));
  const windows = await makePresets('win32', 'C:\\Users\\Example');
  assert.equal(windows.find(game => game.id === 'elden-ring').locations.win32.root, 'C:\\Users\\Example\\AppData\\Roaming\\EldenRing');
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

test('current progress is fully saved and verified before the first restore replacement', async t => {
  const { source, store, id } = await fixture(t);
  const snapshot = await save(store, id);
  await fs.writeFile(path.join(source, 'preferences'), 'current-before-restore');
  let checked = false;
  store.fault = async (phase, { journal }) => {
    if (phase !== 'after-install' || checked) return;
    checked = true;
    const safety = await store.verify(id, journal.safetyId);
    assert.equal(safety.kind, 'safety');
    assert.equal(await read(path.join(store.snapshotDir(id, safety.id), 'payload', 'preferences')), 'current-before-restore');
  };
  await store.restoreSnapshot(id, snapshot.id);
  assert(checked);
  assert.equal(await read(path.join(source, 'preferences')), 'setting-A');
});

test('failure while automatically saving current progress stops restore before any replacement', async t => {
  const { source, store, id } = await fixture(t);
  const snapshot = await save(store, id);
  await fs.writeFile(path.join(source, 'saves', '角色 1.sl2'), 'current-progress');
  await fs.writeFile(path.join(source, 'preferences'), 'current-settings');
  let mutated = false;
  store.onProgress = progress => {
    if (!mutated && progress?.phase === 'copying') { mutated = true; writeFileSync(path.join(source, 'preferences'), 'current-settings-updated'); }
  };
  await assert.rejects(store.restoreSnapshot(id, snapshot.id), /发生变化|校验失败/);
  assert(mutated);
  assert.equal(await read(path.join(source, 'saves', '角色 1.sl2')), 'current-progress');
  assert.equal(await read(path.join(source, 'preferences')), 'current-settings-updated');
  assert.equal((await store.snapshots(id)).length, 1);
  assert(!(await fs.readdir(source)).some(name => name.startsWith('.savehub-restore-')));
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
  const repeated = await store.exportSnapshot(id, snapshot.id, destination);
  assert.equal(path.basename(repeated), '测试游戏-存档导出 (2)');
  assert.deepEqual((await fs.readdir(destination)).sort(), ['测试游戏-存档导出', '测试游戏-存档导出 (2)']);
  for (const folder of [exported, repeated]) {
    assert.deepEqual((await fs.readdir(folder)).sort(), ['.savehub-exports', snapshot.label]);
    assert.equal(await read(path.join(folder, snapshot.label, 'preferences')), 'setting-A');
  }
});

test('game removal, snapshot trash, favorites and theme choices persist and are reversible', async t => {
  const { store, id } = await fixture(t);
  const snapshot = await save(store, id);
  await store.updateSnapshot(id, snapshot.id, { label: '新名字', note: '备注', deleted: true });
  assert.equal((await store.snapshots(id)).length, 0);
  await assert.rejects(store.restoreSnapshot(id, snapshot.id), /回收站/);
  await store.updateSnapshot(id, snapshot.id, { deleted: false });
  await store.updateSnapshot(id, snapshot.id, { favorite: true });
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
