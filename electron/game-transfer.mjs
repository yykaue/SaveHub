import path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { atomicJson, assertNoLinks, assertTreeNoLinks, cleanItems, safeId, within, statMaybe, exportName, uniqueExportName, foldedName, fingerprint, inventory, commitSnapshotDirectory } from './storage.mjs';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = text => createHash('sha256').update(text).digest('hex');
const emptyReport = () => ({ imported: [], overwritten: [], keptBoth: [], skipped: [], failed: [] });
const publicGame = game => structuredClone(game);
const publicSavePlan = plan => ({ id: plan.id, gameId: plan.gameId, directory: plan.directory, failed: plan.failed,
  items: plan.items.map(({ id, name, source, bytes, fileCount, matches }) => ({ id, name, source, bytes, fileCount, matches })) });

export function normalizeGame(input, existing = null) {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new Error('游戏名称需要 1–80 个字符。');
  const locations = {};
  for (const platform of ['win32', 'darwin']) {
    const location = input.locations?.[platform] || { root: '', items: [] };
    if (typeof location.root !== 'string' || location.root.length > 4096) throw new Error('游戏根目录无效。');
    locations[platform] = { root: location.root.trim(), items: cleanItems(location.items, { allowEmpty: true }) };
  }
  const icon = typeof input.icon === 'string' ? input.icon : 'gamepad';
  if (!['ring', 'spire', 'flame', 'gamepad', 'swords', 'gem', 'ghost', 'rocket'].includes(icon) && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(icon)) throw new Error('请使用 PNG、JPEG 或 WebP 图标。');
  if (icon.length > 3_000_000) throw new Error('图标过大，请选择小于 2 MB 的图片。');
  return { ...existing, id: existing?.id || randomUUID(), name: input.name.trim(),
    subtitle: typeof input.subtitle === 'string' ? input.subtitle.trim().slice(0, 80) : '', icon,
    color: /^#[a-f0-9]{6}$/i.test(input.color) ? input.color : '#8a9270', locations,
    legacyRoot: typeof input.legacyRoot === 'string' ? input.legacyRoot.trim().slice(0, 4096) : '',
    createdAt: existing?.createdAt || new Date().toISOString() };
}

export async function purgeGameSnapshots(store, id) {
  const game = store.game(id, true);
  if (!game.deletedAt || !game.purgeSnapshotsPending) throw new Error('游戏未确认永久清理存档。');
  const directory = path.resolve(store.gameDir(id), 'snapshots');
  if (!within(store.vault, directory) || directory === path.resolve(store.vault) || path.dirname(directory) !== path.resolve(store.gameDir(id))) throw new Error('游戏存档清理目录越界。');
  await assertTreeNoLinks(directory);
  const journals = await gameImportJournals(store, id);
  await store.fault('before-game-purge-remove', { gameId: id, directory });
  await fs.rm(directory, { recursive: true, force: true });
  for (const file of journals) await fs.rm(file, { force: true });
  const next = { ...game }; delete next.purgeSnapshotsPending;
  await store.commitGame(next);
}

export async function purgeGame(store, id) {
  const game = store.game(id, true);
  if (!game.deletedAt || !game.purgeGamePending) throw new Error('游戏未确认彻底删除。');
  const directory = path.resolve(store.gameDir(id));
  if (path.dirname(directory) !== path.resolve(store.vault) || directory === path.resolve(store.vault) || !within(store.vault, directory)) throw new Error('游戏清理目录越界。');
  await assertTreeNoLinks(directory);
  const journals = await gameImportJournals(store, id);
  await store.fault('before-game-purge-remove', { gameId: id, directory });
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  for (const file of journals) await fs.rm(file, { force: true });
  await store.fault('before-game-config-delete', { gameId: id });
  // Persist removal without writing game.json again into the deleted directory.
  await store.forgetGame(id);
}

async function gameImportJournals(store, gameId) {
  const directory = path.join(store.dataDir, 'import-transactions');
  await assertNoLinks(directory);
  if (!await statMaybe(directory)) return [];
  const result = [];
  for (const name of (await fs.readdir(directory)).filter(name => name.endsWith('.json'))) {
    const file = path.join(directory, name);
    await assertNoLinks(file);
    const journal = JSON.parse(await fs.readFile(file, 'utf8'));
    if (journal.gameId !== gameId) continue;
    if (store.importReplacementPaths(journal).file !== file) throw new Error('导入覆盖事务身份不一致。');
    result.push(file);
  }
  return result;
}

export async function removeGame(store, id, undo, deleteRecords) {
  if (typeof undo !== 'boolean' || typeof deleteRecords !== 'boolean' || (undo && deleteRecords)) throw new Error('游戏删除选项无效。');
  const game = store.game(id, true);
  const pending = game.purgeGamePending || game.purgeSnapshotsPending;
  if (undo && pending) throw new Error('此游戏的永久删除尚未完成，请先重试清理。');
  if (pending && !deleteRecords) throw new Error('此游戏的永久删除尚未完成，请重试清理。');
  if (deleteRecords && game.purgeGamePending) return purgeGame(store, id);
  const next = { ...game };
  if (undo) delete next.deletedAt;
  else next.deletedAt = next.deletedAt || new Date().toISOString();
  if (deleteRecords) {
    // Check links before committing intent; the journal flag makes partial removal retryable.
    await assertTreeNoLinks(store.gameDir(id));
    next.purgeGamePending = true;
    delete next.purgeSnapshotsPending;
  }
  await store.commitGame(next);
  if (deleteRecords) await purgeGame(store, id);
}

export async function exportGames(store, ids, destination, includeSnapshots) {
  if (typeof includeSnapshots !== 'boolean') throw new Error('游戏导出选项无效。');
  const selected = store.validateSelection(ids);
  if (selected.length > 1000) throw new Error('一次最多导出 1,000 个游戏。');
  const games = selected.map(id => store.game(id));
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('请选择导出目录。');
  destination = path.resolve(destination);
  await assertNoLinks(destination);
  if (within(store.dataDir, destination)) throw new Error('请选择 SaveHub 资料库以外的导出目录。');
  const names = new Set((await fs.readdir(destination)).map(foldedName));
  const folder = path.join(destination, uniqueExportName(`${games.length === 1 ? exportName(games[0].name) : 'SaveHub'}-游戏导出`, names));
  const stage = path.join(destination, `.savehub-games-${randomUUID()}`);
  const directories = [], taken = new Set(['games.json']), published = [];
  let owned = false, snapshotCount = 0;
  await fs.mkdir(stage);
  try {
    for (const game of games) {
      const directory = uniqueExportName(exportName(game.name), taken);
      directories.push(directory);
      const target = path.join(stage, directory);
      const config = normalizeGame(game, { id: game.id, createdAt: game.createdAt });
      const snapshots = includeSnapshots ? await store.snapshots(game.id, true) : [];
      if (snapshots.length > 10000) throw new Error('单个游戏一次最多导出 10,000 份存档记录。');
      await atomicJson(path.join(target, 'game.json'), { version: 1, type: 'savehub-game', game: config, includesSnapshots: includeSnapshots, snapshotCount: snapshots.length });
      if (includeSnapshots) {
        const records = [], used = new Set(['.savehub-exports']);
        for (const snapshot of snapshots) {
          const meta = await store.verify(game.id, snapshot.id);
          const name = uniqueExportName(exportName(meta.label), used);
          await store.writeExport(game.id, meta, path.join(target, 'snapshots', name));
          records.push({ directory: name, manifest: meta });
          snapshotCount++;
        }
        // An empty game remains a valid combined bundle without a fake save candidate.
        if (records.length) await atomicJson(path.join(target, 'snapshots', '.savehub-exports', 'collection.json'), {
          version: 2, type: 'savehub-collection', gameId: game.id, snapshots: records,
        });
      }
    }
    await atomicJson(path.join(stage, 'games.json'), { version: 1, type: 'savehub-games', exportedAt: new Date().toISOString(), games: directories });
    await store.fault('before-game-export-publish', { folder });
    await fs.mkdir(folder); owned = true;
    for (const name of await fs.readdir(stage)) {
      const target = path.join(folder, name);
      await store.fault('before-game-export-entry-publish', { folder, name, target });
      if ((await fs.lstat(path.join(stage, name))).isDirectory()) {
        await commitSnapshotDirectory(path.join(stage, name), target); published.push(target);
      } else {
        const handle = await fs.open(target, 'wx'); published.push(target);
        try { await handle.writeFile(await fs.readFile(path.join(stage, name))); await handle.sync(); }
        finally { await handle.close(); }
      }
    }
    return { folder, count: games.length, snapshotCount };
  } catch (error) {
    for (const target of published) {
      if (!within(folder, target) || target === folder || !within(destination, folder)) throw new Error('游戏导出清理目录越界。');
      await fs.rm(target, { recursive: true, force: true });
    }
    if (owned) await fs.rmdir(folder).catch(() => {});
    throw error;
  } finally {
    if (!within(destination, stage) || stage === destination) throw new Error('游戏导出暂存目录越界。');
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

function matches(store, item) {
  return store.config.games.filter(game => game.id === item.game.id || game.importOrigin?.id === item.game.id || foldedName(game.name.trim()) === foldedName(item.game.name.trim())).map(publicGame);
}

async function readBundle(directory) {
  const file = path.join(directory, 'game.json');
  await assertNoLinks(file);
  const text = await fs.readFile(file, 'utf8');
  if (Buffer.byteLength(text) > 4_000_000) throw new Error('游戏配置文件过大。');
  const data = JSON.parse(text);
  if (data.version !== 1 || data.type !== 'savehub-game' || typeof data.includesSnapshots !== 'boolean') throw new Error('游戏导出格式无效。');
  if (!Number.isSafeInteger(data.snapshotCount) || data.snapshotCount < 0 || data.snapshotCount > 10000 || (!data.includesSnapshots && data.snapshotCount !== 0)) throw new Error('游戏包的存档数量无效。');
  safeId(data.game?.id);
  const game = normalizeGame(data.game, { id: data.game.id, createdAt: data.game.createdAt });
  if (!Number.isFinite(Date.parse(game.createdAt))) throw new Error('游戏创建时间无效。');
  return { game, file, hash: digest(text), includesSnapshots: data.includesSnapshots, snapshotCount: data.snapshotCount };
}

export async function prepareGameImport(store, directory) {
  store.pendingGameImport = null;
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('请选择游戏导出文件夹。');
  directory = path.resolve(directory);
  await assertNoLinks(directory);
  if (within(store.dataDir, directory) || within(directory, store.dataDir)) throw new Error('不能从 SaveHub 资料库本身导入游戏。');
  let directories = [directory];
  const index = path.join(directory, 'games.json');
  if (await statMaybe(index)) {
    await assertNoLinks(index);
    const data = JSON.parse(await fs.readFile(index, 'utf8'));
    if (data.version !== 1 || data.type !== 'savehub-games' || !Array.isArray(data.games) || !data.games.length || data.games.length > 1000) throw new Error('游戏包清单格式无效。');
    const entries = data.games.map(name => cleanItems([name])[0]);
    if (entries.some(name => name.includes('/')) || new Set(entries.map(foldedName)).size !== entries.length) throw new Error('游戏包目录无效或重复。');
    directories = entries.map(name => path.join(directory, name));
  }
  const plan = { id: randomUUID(), directory, items: [], failed: [], review: null };
  const seen = new Set();
  for (const folder of directories) {
    try {
      const bundle = await readBundle(folder);
      if (seen.has(bundle.game.id) || seen.has(`name:${foldedName(bundle.game.name)}`)) throw new Error('同一游戏包中包含重复游戏，请分开导入。');
      seen.add(bundle.game.id); seen.add(`name:${foldedName(bundle.game.name)}`);
      const item = { ...bundle, id: randomUUID(), directory: folder };
      item.matches = matches(store, item);
      plan.items.push(item);
    } catch (error) { plan.failed.push({ name: path.basename(folder), error: error.message }); }
  }
  store.pendingGameImport = plan;
  return structuredClone({ id: plan.id, directory, failed: plan.failed, items: plan.items.map(item => ({
    id: item.id, game: item.game, source: item.directory, includesSnapshots: item.includesSnapshots, matches: item.matches,
  })) });
}

function requirePlan(store, id) {
  if (!store.pendingGameImport || store.pendingGameImport.id !== id) throw new Error('游戏导入检查已失效，请重新选择目录。');
  return store.pendingGameImport;
}

async function checkGames(store, plan) {
  for (const item of plan.items) {
    const data = await readBundle(item.directory);
    if (data.hash !== item.hash) throw new Error('游戏导入源已变化，请重新检查。');
    if (!equal(matches(store, item), item.matches)) throw new Error('游戏配置或重复项已变化，请重新检查。');
  }
}

export async function reviewGameImport(store, planId, decisions) {
  const plan = requirePlan(store, planId);
  plan.review = null;
  await checkGames(store, plan);
  const duplicates = plan.items.filter(item => item.matches.length);
  if (!Array.isArray(decisions) || decisions.length !== duplicates.length) throw new Error('请为每个重复游戏选择处理方式。');
  const choices = new Map(), targets = new Set();
  for (const choice of decisions) {
    const item = duplicates.find(item => item.id === choice?.itemId);
    if (!item || choices.has(item.id) || !['overwrite', 'skip', 'keep-both'].includes(choice.action)) throw new Error('重复游戏的处理方式无效。');
    if (choice.action === 'overwrite') {
      const target = item.matches.find(game => game.id === choice.targetId);
      if (!target || targets.has(target.id) || target.purgeGamePending || target.purgeSnapshotsPending) throw new Error('请选择唯一且已完成清理的游戏覆盖目标。');
      targets.add(target.id);
    }
    choices.set(item.id, structuredClone(choice));
  }
  const taken = new Set([...store.config.games.map(game => foldedName(game.name)), ...plan.items.map(item => foldedName(item.game.name))]);
  const resolved = [], failed = [...plan.failed];
  for (const item of plan.items) {
    const choice = choices.get(item.id);
    if (choice?.action === 'skip') { resolved.push({ item, action: 'skip' }); continue; }
    const target = choice?.action === 'overwrite' ? store.game(choice.targetId, true) : null;
    const game = normalizeGame(item.game, target || { id: randomUUID(), createdAt: item.game.createdAt });
    delete game.deletedAt;
    if (choice?.action === 'keep-both') {
      let number = 2, name;
      do { const suffix = ` (${number++})`; name = item.game.name.slice(0, 80 - suffix.length) + suffix; } while (taken.has(foldedName(name)));
      game.name = name;
    }
    taken.add(foldedName(game.name));
    game.importOrigin = { id: item.game.id };
    let snapshotPlan = null;
    const source = path.join(item.directory, 'snapshots');
    if (item.includesSnapshots && item.snapshotCount > 0) {
      // Only the named, verified export format is accepted inside a game bundle.
      if (!await store.exportIndexCandidates(source)) throw new Error('游戏包内缺少有效的存档导出清单。');
      snapshotPlan = await store.prepareImportPlan(game.id, source, { game, bundle: true });
      if (snapshotPlan.items.length + snapshotPlan.failed.length !== item.snapshotCount || snapshotPlan.items.some(save => save.meta.gameId !== item.game.id)) throw new Error('游戏包中的存档数量或所属游戏不一致。');
      // Keep the exact index bytes to reject metadata edits between review and execution.
      snapshotPlan.indexHash = await indexHash(source);
      failed.push(...snapshotPlan.failed.map(error => ({ ...error, name: `${game.name} / ${error.name}` })));
    }
    resolved.push({ item, action: choice?.action || 'import', game, snapshotPlan });
  }
  plan.review = { id: randomUUID(), resolved };
  return structuredClone({ id: plan.review.id, planId, failed, games: resolved.map(entry => ({
    itemId: entry.item.id, name: entry.game?.name || entry.item.game.name, action: entry.action,
    snapshots: entry.snapshotPlan ? publicSavePlan(entry.snapshotPlan) : null,
  })) });
}

async function indexHash(directory) {
  const root = path.join(directory, '.savehub-exports');
  await assertNoLinks(root);
  const parts = [];
  for (const file of (await fs.readdir(root)).filter(name => name.endsWith('.json')).sort()) {
    await assertNoLinks(path.join(root, file));
    parts.push([file, await fs.readFile(path.join(root, file), 'utf8')]);
  }
  return digest(JSON.stringify(parts));
}

export async function executeGameImport(store, reviewId, decisions) {
  const plan = store.pendingGameImport, review = plan?.review;
  if (!review || review.id !== reviewId) throw new Error('游戏导入检查已失效，请重新检查。');
  await checkGames(store, plan);
  const expected = review.resolved.filter(entry => entry.snapshotPlan);
  if (!Array.isArray(decisions) || decisions.length !== expected.length) throw new Error('请确认每个游戏的存档导入处理方式。');
  const saveChoices = new Map();
  for (const decision of decisions) {
    const entry = expected.find(entry => entry.item.id === decision?.itemId);
    if (!entry || saveChoices.has(entry.item.id)) throw new Error('游戏存档导入选项无效。');
    const snapshotPlan = entry.snapshotPlan;
    if (await indexHash(snapshotPlan.directory) !== snapshotPlan.indexHash) throw new Error('存档导入清单已变化，请重新检查。');
    const choices = await store.validateImportPlan(snapshotPlan, decision.decisions);
    for (const item of snapshotPlan.items) {
      if (choices.get(item.id)?.action === 'skip') continue;
      const data = await inventory(item.source, item.entries, { allowMissing: Boolean(item.allowMissing) });
      if (fingerprint(data) !== item.fingerprint) throw new Error('存档导入源已变化，请重新检查。');
    }
    saveChoices.set(entry.item.id, choices);
  }
  store.pendingGameImport = null;
  const report = { games: emptyReport(), snapshots: [] };
  report.games.failed.push(...plan.failed);
  for (const entry of review.resolved) {
    if (entry.action === 'skip') { report.games.skipped.push(entry.item.game.name); continue; }
    try {
      await store.commitGame(entry.game);
      report.games[entry.action === 'overwrite' ? 'overwritten' : entry.action === 'keep-both' ? 'keptBoth' : 'imported'].push(entry.game.name);
      if (entry.snapshotPlan) report.snapshots.push({ gameName: entry.game.name, report: await store.applyImportPlan(entry.snapshotPlan, saveChoices.get(entry.item.id), entry.game) });
    } catch (error) { report.games.failed.push({ name: entry.game.name, error: error.message }); }
  }
  return report;
}
