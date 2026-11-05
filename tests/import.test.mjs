import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SaveStore, within } from '../electron/storage.mjs';

const root = path.resolve('.test-data');
const read = (file) => fs.readFile(file, 'utf8');
async function fixture(t, count = 3) {
  await fs.mkdir(root, { recursive: true });
  const base = await fs.mkdtemp(path.join(root, 'import-'));
  t.after(async () => {
    assert(within(root, base) && base !== root);
    await fs.rm(base, { recursive: true, force: true });
  });
  const source = path.join(base, 'live'),
    legacy = path.join(base, 'legacy');
  await fs.mkdir(path.join(source, 'saves'), { recursive: true });
  await fs.writeFile(path.join(source, 'saves/progress.dat'), 'live-game-untouched');
  const store = await new SaveStore(path.join(base, 'data')).init();
  const location = { root: source, items: ['saves'] };
  const gameId = await store.upsertGame({
    name: '导入测试',
    subtitle: '',
    icon: 'ring',
    color: '#8a9270',
    legacyRoot: legacy,
    locations: { win32: location, darwin: location },
  });
  const addSource = async (name, value = name) => {
    const directory = path.join(legacy, name);
    await fs.mkdir(path.join(directory, 'saves/empty'), { recursive: true });
    await fs.writeFile(path.join(directory, 'saves/progress.dat'), value);
    return directory;
  };
  for (let index = 1; index <= count; index++) await addSource(`ArchiveFile${index}`, `original-${index}`);
  assert.equal((await store.importLegacy(gameId, legacy)).imported.length, count);
  const originals = (await store.snapshots(gameId)).sort((a, b) => a.label.localeCompare(b.label));
  const payload = (snapshot) => path.join(store.snapshotDir(gameId, snapshot.id), 'payload/saves/progress.dat');
  const sourceFile = (name) => path.join(legacy, name, 'saves/progress.dat');
  return { base, store, gameId, legacy, source, originals, addSource, payload, sourceFile };
}
const decide = (plan, action = 'skip') =>
  plan.items
    .filter((item) => item.matches.length)
    .map((item) => ({ itemId: item.id, action, targetId: item.matches[0].id }));

test('one import plan defers all writes, then mixes overwrite, skip, keep-both and new saves', async (t) => {
  const { store, gameId, legacy, source, originals, addSource, payload, sourceFile } = await fixture(t);
  const [overwritten, skipped, kept] = originals;
  await store.updateSnapshot(gameId, overwritten.id, { favorite: true, note: 'original local note' });
  const beforeOverwrite = await store.readSnapshot(gameId, overwritten.id);
  const beforeSkip = await store.readSnapshot(gameId, skipped.id);
  const beforeKeep = await store.readSnapshot(gameId, kept.id);
  for (const name of originals.map((item) => item.label)) await fs.writeFile(sourceFile(name), `new-${name}`);
  await addSource('ArchiveFile4', 'new-four');
  await fs.mkdir(path.join(legacy, 'ArchiveFileBroken'));
  const before = await store.snapshots(gameId, true);
  const plan = await store.prepareImport(gameId, legacy);
  assert.equal(plan.items.length, 4);
  assert.equal(plan.failed.length, 1);
  assert.equal(plan.items.filter((item) => item.matches.length).length, 3);
  assert.deepEqual(await store.snapshots(gameId, true), before);
  assert.equal(await read(payload(overwritten)), 'original-1');
  const choices = decide(plan);
  choices[0].action = 'overwrite';
  choices[2].action = 'keep-both';
  const report = await store.executeImport(plan.id, choices);
  assert.deepEqual(report.imported, ['ArchiveFile4']);
  assert.deepEqual(report.overwritten, ['ArchiveFile1']);
  assert.deepEqual(report.skipped, ['ArchiveFile2']);
  assert.deepEqual(report.keptBoth, ['ArchiveFile3 (2)']);
  assert.equal(report.failed[0].name, 'ArchiveFileBroken');
  const after = await store.readSnapshot(gameId, overwritten.id);
  assert.equal(after.id, beforeOverwrite.id);
  assert.equal(after.createdAt, beforeOverwrite.createdAt);
  assert(after.favorite);
  assert.equal(await read(payload(overwritten)), 'new-ArchiveFile1');
  assert.deepEqual(await store.readSnapshot(gameId, skipped.id), beforeSkip);
  assert.deepEqual(await store.readSnapshot(gameId, kept.id), beforeKeep);
  assert.equal(await read(payload(skipped)), 'original-2');
  assert.equal(await read(payload(kept)), 'original-3');
  const saves = await store.snapshots(gameId);
  assert.equal(saves.length, 5);
  const copy = saves.find((item) => item.label === 'ArchiveFile3 (2)');
  assert.notEqual(copy.id, kept.id);
  assert.equal(await read(payload(copy)), 'new-ArchiveFile3');
  for (const save of saves) await store.verifySnapshot(gameId, save.id);
  for (const item of originals) assert.equal(await read(sourceFile(item.label)), `new-${item.label}`);
  assert.equal(await read(path.join(source, 'saves/progress.dat')), 'live-game-untouched');
  await assert.rejects(store.executeImport(plan.id, choices), /失效/);
});

test('cancel, incomplete or forged decisions and stale library state cannot partially import a batch', async (t) => {
  const { store, gameId, legacy, originals, addSource } = await fixture(t);
  await addSource('ArchiveFile4');
  const before = await store.snapshots(gameId, true);
  let plan = await store.prepareImport(gameId, legacy);
  const choices = decide(plan);
  for (const invalid of [
    undefined,
    [],
    [null, choices[1], choices[2]],
    [choices[0], choices[0], choices[2]],
    choices.map((choice, index) => (index ? choice : { ...choice, action: 'unknown' })),
    choices.map((choice, index) => (index ? choice : { ...choice, action: 'overwrite', targetId: originals[1].id })),
  ]) {
    await assert.rejects(store.executeImport(plan.id, invalid));
    assert.deepEqual(await store.snapshots(gameId, true), before);
  }
  store.cancelImport(plan.id);
  await assert.rejects(store.executeImport(plan.id, choices), /失效/);
  assert.deepEqual(await store.snapshots(gameId, true), before);
  plan = await store.prepareImport(gameId, legacy);
  await store.updateSnapshot(gameId, originals[0].id, { protected: true });
  await assert.rejects(store.executeImport(plan.id, decide(plan)), /状态已变化/);
  assert.equal((await store.snapshots(gameId)).length, before.length);
});

test('protected conflicts reject overwrite for the whole batch but allow coexistence alongside trash', async (t) => {
  const { store, gameId, legacy, originals, addSource } = await fixture(t, 2);
  await store.updateSnapshot(gameId, originals[0].id, { protected: true });
  await store.updateSnapshot(gameId, originals[1].id, { deleted: true });
  await addSource('ArchiveFile3');
  const before = await store.snapshots(gameId, true);
  const plan = await store.prepareImport(gameId, legacy);
  await assert.rejects(store.executeImport(plan.id, decide(plan, 'overwrite')), /不能被导入覆盖/);
  assert.deepEqual(await store.snapshots(gameId, true), before);
  const report = await store.executeImport(plan.id, decide(plan, 'keep-both'));
  assert.equal(report.keptBoth.length, 2);
  assert.equal(report.imported.length, 1);
  assert.equal(report.failed.length, 0);
  assert((await store.readSnapshot(gameId, originals[0].id)).protected);
  assert((await store.readSnapshot(gameId, originals[1].id)).deletedAt);
});

test('a source change after confirmation fails that item without overwriting the existing save', async (t) => {
  const { store, gameId, legacy, originals, addSource, sourceFile, payload } = await fixture(t, 1);
  await addSource('ArchiveFile2');
  const original = await store.readSnapshot(gameId, originals[0].id);
  const plan = await store.prepareImport(gameId, legacy);
  await fs.writeFile(sourceFile('ArchiveFile1'), 'changed-after-preview');
  const report = await store.executeImport(plan.id, decide(plan, 'overwrite'));
  assert.deepEqual(report.overwritten, []);
  assert.deepEqual(report.imported, ['ArchiveFile2']);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].error, /确认后发生变化/);
  assert.deepEqual(await store.readSnapshot(gameId, original.id), original);
  assert.equal(await read(payload(original)), 'original-1');
});

test('keep-both uses unique suffixes and overwrite targets only the explicitly selected copy', async (t) => {
  const { store, gameId, legacy, originals, sourceFile, payload } = await fixture(t, 1);
  let plan = await store.prepareImport(gameId, legacy);
  assert.deepEqual((await store.executeImport(plan.id, decide(plan, 'keep-both'))).keptBoth, ['ArchiveFile1 (2)']);
  plan = await store.prepareImport(gameId, legacy);
  assert.equal(plan.items[0].matches.length, 2);
  assert.deepEqual((await store.executeImport(plan.id, decide(plan, 'keep-both'))).keptBoth, ['ArchiveFile1 (3)']);
  const copies = await store.snapshots(gameId);
  const chosen = copies.find((item) => item.label.endsWith('(2)'));
  await fs.writeFile(sourceFile('ArchiveFile1'), 'replace-only-chosen');
  plan = await store.prepareImport(gameId, legacy);
  const report = await store.executeImport(plan.id, [
    { itemId: plan.items[0].id, action: 'overwrite', targetId: chosen.id },
  ]);
  assert.deepEqual(report.overwritten, ['ArchiveFile1']);
  assert.equal(report.failed.length, 0);
  assert.equal((await store.snapshots(gameId)).length, 3);
  assert.equal(await read(payload(chosen)), 'replace-only-chosen');
  assert.equal(await read(payload(originals[0])), 'original-1');
  assert.equal(await read(payload(copies.find((item) => item.label.endsWith('(3)')))), 'original-1');
});

test('named exports retain metadata when kept alongside an existing import and replace information only on confirmation', async (t) => {
  const { base, store, gameId } = await fixture(t, 1);
  const manual = await store.createSnapshot(gameId, { label: '命名存档', note: '导出备注' });
  await store.updateSnapshot(gameId, manual.id, { favorite: true });
  const destination = path.join(base, 'exports');
  await fs.mkdir(destination);
  const folder = await store.exportSnapshot(gameId, manual.id, destination);
  assert.equal((await store.importLegacy(gameId, folder)).imported.length, 1);
  const imported = (await store.snapshots(gameId)).find(
    (item) => item.label === manual.label && item.kind === 'imported',
  );
  await store.updateSnapshot(gameId, imported.id, { label: '本地修改名称', note: '本地修改备注' });
  const plan = await store.prepareImport(gameId, path.join(folder, manual.label));
  assert.equal(plan.items[0].matches[0].id, imported.id);
  // Renderer-visible objects cannot rewrite the server-owned plan or source paths.
  plan.items[0].source = path.join(base, 'forged-source');
  plan.items[0].name = '伪造名称';
  const report = await store.executeImport(plan.id, decide(plan, 'overwrite'));
  assert.deepEqual(report.overwritten, [manual.label]);
  assert.deepEqual(report.failed, []);
  const replaced = await store.readSnapshot(gameId, imported.id);
  assert.equal(replaced.label, manual.label);
  assert.equal(replaced.note, '导出备注');
  assert(replaced.favorite);
  assert.equal(replaced.createdAt, imported.createdAt);
  await store.verifySnapshot(gameId, imported.id);
});

test('copying failure and failures around both replacement renames preserve the original save', async (t) => {
  for (const phase of ['copying', 'before-import-replace', 'after-import-backup', 'after-import-install']) {
    await t.test(phase, async (t) => {
      const { store, gameId, legacy, originals, sourceFile, payload } = await fixture(t, 1);
      const original = await store.readSnapshot(gameId, originals[0].id);
      await fs.writeFile(sourceFile('ArchiveFile1'), 'replacement');
      const plan = await store.prepareImport(gameId, legacy);
      store.fault = async (step) => {
        if (step === phase) throw new Error(`simulated-${phase}`);
      };
      store.onProgress = (progress) => {
        if (phase === 'copying' && progress?.phase === 'copying') throw new Error('simulated-copying');
      };
      const report = await store.executeImport(plan.id, decide(plan, 'overwrite'));
      assert.equal(report.overwritten.length, 0);
      assert.equal(report.failed.length, 1);
      assert.match(report.failed[0].error, /simulated/);
      assert.deepEqual(await store.readSnapshot(gameId, original.id), original);
      assert.equal(await read(payload(original)), 'original-1');
      assert.deepEqual(await fs.readdir(path.dirname(store.snapshotDir(gameId, original.id))), [original.id]);
      await new SaveStore(store.dataDir).init();
      assert.equal(await read(payload(original)), 'original-1');
    });
  }
});

test('startup recovers actual process interruptions before and after installation of a replacement', async (t) => {
  for (const phase of ['after-import-backup', 'after-import-install']) {
    await t.test(phase, async (t) => {
      const { store, gameId, legacy, originals, sourceFile, payload } = await fixture(t, 1);
      const original = await store.readSnapshot(gameId, originals[0].id);
      await fs.writeFile(sourceFile('ArchiveFile1'), 'replacement-before-crash');
      const code = `
        import { SaveStore } from './electron/storage.mjs';
        const [dataDir, gameId, directory, phase] = process.argv.slice(1);
        const store = await new SaveStore(dataDir, { fault: async step => { if (step === phase) process.exit(86); } }).init();
        const plan = await store.prepareImport(gameId, directory);
        await store.executeImport(plan.id, [{ itemId: plan.items[0].id, action: 'overwrite', targetId: plan.items[0].matches[0].id }]);
      `;
      const child = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', code, store.dataDir, gameId, legacy, phase],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      );
      assert.equal(child.status, 86, child.stderr || child.error?.message);
      assert.equal((await fs.readdir(path.join(store.dataDir, 'import-transactions'))).length, 1);
      const reopened = await new SaveStore(store.dataDir).init();
      assert.deepEqual(await reopened.readSnapshot(gameId, original.id), original);
      assert.equal(await read(payload(original)), 'original-1');
      assert.equal(reopened.recoveryMessages.length, 1);
      assert.deepEqual(await fs.readdir(path.join(store.dataDir, 'import-transactions')), []);
      assert.deepEqual(await fs.readdir(path.dirname(store.snapshotDir(gameId, original.id))), [original.id]);
      await reopened.verifySnapshot(gameId, original.id);
    });
  }
});

test('a committed replacement survives deferred cleanup and startup preserves the new content', async (t) => {
  const { store, gameId, legacy, originals, sourceFile, payload } = await fixture(t, 1);
  await fs.writeFile(sourceFile('ArchiveFile1'), 'committed-new-content');
  const plan = await store.prepareImport(gameId, legacy);
  store.finishImportReplacement = async () => {
    throw new Error('simulated cleanup lock');
  };
  const report = await store.executeImport(plan.id, decide(plan, 'overwrite'));
  assert.deepEqual(report.overwritten, ['ArchiveFile1']);
  assert.deepEqual(report.failed, []);
  assert.equal((await fs.readdir(path.join(store.dataDir, 'import-transactions'))).length, 1);
  const reopened = await new SaveStore(store.dataDir).init();
  await reopened.verifySnapshot(gameId, originals[0].id);
  assert.equal(await read(payload(originals[0])), 'committed-new-content');
  assert.deepEqual(await fs.readdir(path.join(store.dataDir, 'import-transactions')), []);
  assert.deepEqual(await fs.readdir(path.dirname(store.snapshotDir(gameId, originals[0].id))), [originals[0].id]);
});
