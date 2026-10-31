import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export const THEMES = ['ink', 'tech', 'cyber', 'glass'];
const ID = /^[a-z0-9-]{1,64}$/;
const MAX_FILES = 100000;
const EXPORT_INDEX = '.savehub-exports';
const missing = error => error?.code === 'ENOENT';
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function safeId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('无效的项目或存档标识。');
  return value;
}

export function cleanItems(values, { allowEmpty = false } = {}) {
  if (!Array.isArray(values) || values.length > 128) throw new Error('请配置 1–128 个存档文件或目录。');
  const items = values.map(value => {
    if (typeof value !== 'string') throw new Error('存档路径必须是文本。');
    const item = value.trim().replaceAll('\\', '/');
    if (!item || item.length > 1024 || item.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error(`路径不安全或无法跨平台使用：${value}。请填写根目录下的相对路径。`);
    }
    return item;
  });
  if (!allowEmpty && !items.length) throw new Error('至少指定一个需要备份的文件或目录。');
  const folded = items.map(item => item.toLowerCase());
  if (folded.some((item, i) => folded.some((other, j) => i !== j && (item === other || item.startsWith(`${other}/`))))) {
    throw new Error('存档路径不能重复，也不能同时包含父目录和它的子路径。');
  }
  return items;
}

export function within(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function statMaybe(file) { try { return await fs.lstat(file); } catch (error) { if (missing(error)) return null; throw error; } }

async function assertTreeNoLinks(directory) {
  await assertNoLinks(directory);
  if (!(await statMaybe(directory))) return;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('永久删除前发现符号链接或目录联接，操作已停止。');
    if (entry.isDirectory()) await assertTreeNoLinks(file);
  }
}

export async function commitSnapshotDirectory(source, destination, { platform = process.platform, rename = fs.rename, pause = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      // Windows can briefly hold a newly written backup directory open. Retry only
      // this final commit, with a bounded delay; do not retry over an existing target.
      if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 4 || await statMaybe(destination)) throw error;
      await pause(50 * (attempt + 1));
    }
  }
}

export async function assertNoLinks(file) {
  const resolved = path.resolve(file);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await statMaybe(cursor);
    if (stat?.isSymbolicLink()) throw new Error(`为避免操作到其他目录，不支持符号链接或目录联接：${cursor}`);
  }
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(JSON.stringify(value, null, 2), 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

export async function inventory(root, entries, { allowMissing = false, progress = () => {} } = {}) {
  const records = [], absent = [];
  const walk = async relative => {
    if (records.length >= MAX_FILES) throw new Error('单份存档超过 100,000 个文件或目录，请缩小备份范围。');
    const file = path.join(root, ...relative.split('/'));
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`不支持符号链接或目录联接：${relative}`);
    if (stat.isDirectory()) {
      records.push({ path: relative, type: 'directory', mtimeMs: stat.mtimeMs });
      const names = (await fs.readdir(file)).sort();
      for (const name of names) {
        // Validate filenames too, so a backup made on one OS is safe on the other.
        cleanItems([name]);
        await walk(`${relative}/${name}`);
      }
    } else if (stat.isFile()) {
      const sha256 = await hashFile(file);
      const after = await fs.lstat(file);
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error(`文件正在变化，请先关闭游戏：${relative}`);
      records.push({ path: relative, type: 'file', size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
      progress({ phase: 'checking', detail: relative, completed: records.length });
    } else throw new Error(`不支持的文件类型：${relative}`);
  };
  for (const entry of entries) {
    await assertNoLinks(path.join(root, entry));
    if (!(await statMaybe(path.join(root, entry)))) {
      if (!allowMissing) throw new Error(`找不到存档路径：${entry}。请检查游戏配置，或先在游戏中创建一次存档。`);
      absent.push(entry);
    } else await walk(entry);
  }
  records.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { records, absent };
}

const signature = value => JSON.stringify({ absent: value.absent, records: value.records.map(({ path: file, type, size, sha256 }) => ({ path: file, type, size, sha256 })) });
const fingerprint = value => createHash('sha256').update(signature(value)).digest('hex');

async function copyRecords(source, target, records, progress = () => {}) {
  await fs.mkdir(target, { recursive: true });
  const dirs = records.filter(record => record.type === 'directory').sort((a, b) => a.path.length - b.path.length);
  for (const record of dirs) await fs.mkdir(path.join(target, record.path), { recursive: true });
  const files = records.filter(record => record.type === 'file');
  let completed = 0;
  for (const record of files) {
    const dest = path.join(target, record.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(source, record.path), dest, fs.constants.COPYFILE_EXCL);
    const date = new Date(record.mtimeMs);
    await fs.utimes(dest, date, date);
    progress({ phase: 'copying', completed: ++completed, total: files.length, detail: record.path });
  }
  for (const record of dirs.reverse()) {
    const date = new Date(record.mtimeMs);
    await fs.utimes(path.join(target, record.path), date, date);
  }
}

function validateManifest(meta) {
  safeId(meta.id); safeId(meta.gameId);
  if (meta.version !== 1 || typeof meta.label !== 'string' || !Array.isArray(meta.records) || meta.records.length > MAX_FILES) throw new Error('存档清单格式无效。');
  const entries = cleanItems(meta.entries);
  if (!Array.isArray(meta.absent) || meta.absent.some(item => !entries.includes(item))) throw new Error('存档清单缺少有效的路径信息。');
  const seen = new Set();
  for (const record of meta.records) {
    cleanItems([record.path]);
    if (!entries.some(entry => record.path === entry || record.path.startsWith(`${entry}/`)) || meta.absent.some(entry => record.path === entry || record.path.startsWith(`${entry}/`))) throw new Error('存档清单包含范围外的文件。');
    if (seen.has(record.path.toLowerCase())) throw new Error('存档包含重复或大小写冲突的文件。');
    seen.add(record.path.toLowerCase());
    if (!['file', 'directory'].includes(record.type) || !Number.isFinite(record.mtimeMs)) throw new Error('存档文件信息无效。');
    if (record.type === 'file' && (!/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size < 0)) throw new Error('存档校验信息无效。');
  }
  return meta;
}

const publicSnapshot = ({ records, ...snapshot }) => snapshot;

function exportName(label) {
  let name = label.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/g, '');
  // Leave room for collision suffixes on filesystems with a 255-byte name limit.
  while (Buffer.byteLength(name, 'utf8') > 180) name = Array.from(name).slice(0, -1).join('');
  name = name.replace(/[. ]+$/g, '') || '未命名存档';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name.toLowerCase().startsWith('.savehub-export')) name = `_${name}`;
  return name;
}

const foldedName = name => name.normalize('NFC').toLowerCase();

function uniqueExportName(base, taken) {
  let name = base, suffix = 2;
  while (taken.has(foldedName(name))) name = `${base} (${suffix++})`;
  taken.add(foldedName(name));
  return name;
}

export class SaveStore {
  constructor(dataDir, { platform = process.platform, onProgress = () => {}, fault = async () => {} } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.vault = path.join(this.dataDir, 'vault');
    this.configFile = path.join(this.dataDir, 'library.json');
    this.platform = platform;
    this.onProgress = onProgress;
    this.fault = fault;
    this.busy = false;
    this.recoveryMessages = [];
  }

  async init(presets = []) {
    await assertNoLinks(this.dataDir);
    await fs.mkdir(this.vault, { recursive: true });
    try {
      this.config = JSON.parse(await fs.readFile(this.configFile, 'utf8'));
      if (this.config.version !== 1 || !Array.isArray(this.config.games)) throw new Error('配置格式无效');
      this.config.games.forEach(game => safeId(game.id));
    } catch (error) {
      if (!missing(error)) throw new Error(`无法读取游戏库。原文件已保留，请检查 ${this.configFile}：${error.message}`);
      this.config = { version: 1, theme: 'ink', games: presets };
      await this.saveConfig();
    }
    await this.recoverTransactions();
    return this;
  }

  async exclusive(action) {
    if (this.busy) throw new Error('另一个存档操作正在进行，请稍候。');
    this.busy = true;
    try { return await action(); } finally { this.busy = false; this.onProgress(null); }
  }

  game(id, includeDeleted = false) {
    safeId(id);
    const game = this.config.games.find(item => item.id === id && (includeDeleted || !item.deletedAt));
    if (!game) throw new Error('找不到这个游戏项目。');
    return game;
  }

  gameDir(id) { return path.join(this.vault, safeId(id)); }
  snapshotDir(gameId, id) { return path.join(this.gameDir(gameId), 'snapshots', safeId(id)); }
  async saveConfig() {
    if (await statMaybe(this.configFile)) await fs.copyFile(this.configFile, `${this.configFile}.previous`);
    await atomicJson(this.configFile, this.config);
  }

  async snapshots(gameId, includeDeleted = false) {
    const directory = path.join(this.gameDir(gameId), 'snapshots');
    const result = [];
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (missing(error)) return []; throw error; }
    const ids = new Set(entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name));
    for (const entry of entries) {
      const match = entry.name.match(/^\.purge-([a-z0-9-]{1,64})\.json$/);
      if (match && entry.isFile()) ids.add(match[1]);
    }
    for (const id of ids) {
      try {
        const meta = await this.readSnapshot(gameId, id);
        if (includeDeleted || !meta.deletedAt) result.push(publicSnapshot(meta));
      } catch (error) {
        result.push({ id, gameId, label: `损坏的存档 · ${id.slice(0, 8)}`, kind: 'manual', corrupted: true, error: error.message, createdAt: '', bytes: 0, fileCount: 0, entries: [] });
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async state() {
    const games = await Promise.all(this.config.games.map(async game => {
      const location = game.locations[this.platform];
      let pathStatus = 'unconfigured';
      if (location?.root && location?.items.length) {
        try { await this.location(game); pathStatus = 'ready'; } catch { pathStatus = 'missing'; }
      }
      let legacyCount = 0;
      if (game.legacyRoot) {
        try { legacyCount = (await fs.readdir(game.legacyRoot, { withFileTypes: true })).filter(item => item.isDirectory() && item.name.startsWith('ArchiveFile')).length; } catch { /* Optional legacy folder. */ }
      }
      const stored = await this.snapshots(game.id, true);
      return { ...game, snapshots: stored.filter(snapshot => snapshot.kind !== 'safety'), restorePoints: stored.filter(snapshot => snapshot.kind === 'safety'), pathStatus, legacyCount };
    }));
    return { games, theme: this.config.theme, platform: this.platform, dataDir: this.dataDir, recoveryMessages: this.recoveryMessages };
  }

  async setTheme(theme) {
    return this.exclusive(async () => {
      if (!THEMES.includes(theme)) throw new Error('未知主题。');
      this.config.theme = theme;
      await this.saveConfig();
    });
  }

  async upsertGame(input) {
    return this.exclusive(async () => {
      if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new Error('游戏名称需要 1–80 个字符。');
      const existing = input.id ? this.game(input.id) : null;
      const locations = {};
      for (const platform of ['win32', 'darwin']) {
        const location = input.locations?.[platform] || { root: '', items: [] };
        if (typeof location.root !== 'string' || location.root.length > 4096) throw new Error('游戏根目录无效。');
        locations[platform] = { root: location.root.trim(), items: cleanItems(location.items, { allowEmpty: true }) };
      }
      const icon = typeof input.icon === 'string' ? input.icon : 'gamepad';
      if (!['ring', 'spire', 'flame', 'gamepad', 'swords', 'gem', 'ghost', 'rocket'].includes(icon) && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(icon)) throw new Error('请使用 PNG、JPEG 或 WebP 图标。');
      if (icon.length > 3_000_000) throw new Error('图标过大，请选择小于 2 MB 的图片。');
      const game = {
        ...existing, id: existing?.id || randomUUID(), name: input.name.trim(),
        subtitle: typeof input.subtitle === 'string' ? input.subtitle.trim().slice(0, 80) : '',
        icon, color: /^#[a-f0-9]{6}$/i.test(input.color) ? input.color : '#8a9270', locations,
        legacyRoot: typeof input.legacyRoot === 'string' ? input.legacyRoot.trim().slice(0, 4096) : '',
        createdAt: existing?.createdAt || new Date().toISOString(),
      };
      if (existing) this.config.games[this.config.games.findIndex(item => item.id === game.id)] = game;
      else this.config.games.push(game);
      await this.saveConfig();
      await atomicJson(path.join(this.gameDir(game.id), 'game.json'), game);
      return game.id;
    });
  }

  async removeGame(id, undo = false) {
    return this.exclusive(async () => {
      const game = this.game(id, undo);
      if (undo) delete game.deletedAt; else game.deletedAt = new Date().toISOString();
      await this.saveConfig();
    });
  }

  async location(game, entriesOverride) {
    const location = game.locations[this.platform];
    if (!location?.root || !path.isAbsolute(location.root)) throw new Error('请先配置当前系统的游戏存档根目录（绝对路径）。');
    const root = path.resolve(location.root);
    if (root === path.parse(root).root) throw new Error('不能将磁盘根目录设为游戏存档目录。');
    await assertNoLinks(root);
    const rootStat = await statMaybe(root);
    if (!rootStat?.isDirectory()) throw new Error(`游戏目录不存在：${root}`);
    const entries = cleanItems(entriesOverride || location.items);
    for (const entry of entries) {
      const target = path.join(root, entry);
      if (within(target, this.dataDir) || within(this.dataDir, target)) throw new Error('游戏存档路径与 SaveHub 资料库重叠，请重新选择目录。');
      await assertNoLinks(target);
    }
    return { root, entries };
  }

  async createSnapshot(gameId, options = {}) {
    return this.exclusive(async () => {
      const game = this.game(gameId);
      const { root, entries } = await this.location(game);
      return publicSnapshot(await this.capture(game, root, entries, { label: options.label, note: options.note, kind: 'manual' }));
    });
  }

  async capture(game, root, entries, { label, note = '', kind = 'manual', allowMissing = false, origin, favorite = false, protected: protectedTag = false } = {}) {
    if (typeof label !== 'string' || !label.trim() || label.length > 100) throw new Error('请填写 1–100 个字符的存档名称。');
    if (typeof note !== 'string' || note.length > 2000) throw new Error('存档备注不能超过 2,000 个字符。');
    await assertNoLinks(root);
    const source = await inventory(root, entries, { allowMissing, progress: this.onProgress });
    const id = randomUUID();
    const stage = path.join(this.gameDir(game.id), 'snapshots', `.pending-${id}`);
    const destination = this.snapshotDir(game.id, id);
    try {
      await copyRecords(root, path.join(stage, 'payload'), source.records, this.onProgress);
      const copied = await inventory(path.join(stage, 'payload'), entries, { allowMissing: true });
      const sourceAfter = await inventory(root, entries, { allowMissing });
      if (signature(source) !== signature(copied) || signature(source) !== signature(sourceAfter)) throw new Error('备份期间文件发生变化或复制校验失败。请关闭游戏后重试，本次备份未提交。');
      const meta = {
        version: 1, id, gameId: game.id, label: label.trim(), note: note.trim(), kind,
        createdAt: new Date().toISOString(), platform: this.platform, entries, favorite: Boolean(favorite), protected: Boolean(protectedTag),
        records: source.records, absent: source.absent, fingerprint: fingerprint(source),
        fileCount: source.records.filter(record => record.type === 'file').length,
        bytes: source.records.reduce((total, record) => total + (record.size || 0), 0),
        ...(origin ? { origin } : {}),
      };
      validateManifest(meta);
      await atomicJson(path.join(stage, 'manifest.json'), meta);
      await commitSnapshotDirectory(stage, destination);
      return meta;
    } finally { await fs.rm(stage, { recursive: true, force: true }).catch(() => {}); }
  }

  async readSnapshot(gameId, id) {
    const folder = this.snapshotDir(gameId, id);
    await assertNoLinks(folder);
    const marker = path.join(path.dirname(folder), `.purge-${id}.json`);
    await assertNoLinks(marker);
    const pending = Boolean(await statMaybe(marker));
    const file = pending ? marker : path.join(folder, 'manifest.json');
    await assertNoLinks(file);
    const meta = validateManifest(JSON.parse(await fs.readFile(file, 'utf8')));
    if (meta.id !== id || meta.gameId !== gameId) throw new Error('存档身份不一致，操作已停止。');
    if (pending && (!meta.deletedAt || !meta.purgePending)) throw new Error('永久删除记录无效，操作已停止。');
    return meta;
  }

  async verifySnapshot(gameId, id) {
    return this.exclusive(async () => {
      const meta = await this.verify(gameId, id);
      return { fileCount: meta.fileCount, bytes: meta.bytes };
    });
  }

  async verify(gameId, id) {
    const meta = await this.readSnapshot(gameId, id);
    if (meta.purgePending) throw new Error('这份记录已开始永久删除，只能继续清理，不能读取或导出。');
    const actual = await inventory(path.join(this.snapshotDir(gameId, id), 'payload'), meta.entries, { allowMissing: true, progress: this.onProgress });
    if (signature(actual) !== signature(meta)) throw new Error('存档完整性校验失败：文件缺失或内容已改变。游戏文件未被覆盖。');
    return meta;
  }

  async updateSnapshot(gameId, id, changes) {
    return this.exclusive(async () => {
      this.game(gameId);
      const meta = await this.readSnapshot(gameId, id);
      if (meta.purgePending) throw new Error('这份记录已开始永久删除，不能找回或修改，请继续永久删除。');
      if (changes.deleted && (meta.protected || changes.protected)) throw new Error('保护存档不可删除，请先取消保护标记。');
      if ('label' in changes) {
        if (typeof changes.label !== 'string' || !changes.label.trim() || changes.label.length > 100) throw new Error('存档名称需要 1–100 个字符。');
        meta.label = changes.label.trim();
      }
      if ('note' in changes) {
        if (typeof changes.note !== 'string' || changes.note.length > 2000) throw new Error('备注不能超过 2,000 个字符。');
        meta.note = changes.note;
      }
      if ('favorite' in changes) meta.favorite = Boolean(changes.favorite);
      if ('protected' in changes) {
        if (meta.kind === 'safety') throw new Error('自动恢复点不能作为普通存档标记。');
        if (meta.deletedAt) throw new Error('请先从回收站找回存档，再修改保护标记。');
        meta.protected = Boolean(changes.protected);
      }
      if ('deleted' in changes) { if (changes.deleted) meta.deletedAt = new Date().toISOString(); else delete meta.deletedAt; }
      await atomicJson(path.join(this.snapshotDir(gameId, id), 'manifest.json'), meta);
    });
  }

  validateSelection(ids) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 10000) throw new Error('请选择 1–10,000 份存档。');
    const unique = [...new Set(ids.map(safeId))];
    if (unique.length !== ids.length) throw new Error('选择的存档不能重复。');
    return unique;
  }

  async updateSnapshots(gameId, selection, changes) {
    return this.exclusive(async () => {
      this.game(gameId);
      const keys = Object.keys(changes || {});
      if (keys.length !== 1 || !['deleted', 'protected'].includes(keys[0]) || typeof changes[keys[0]] !== 'boolean') throw new Error('不支持的批量标记操作。');
      if (selection === 'all' && keys[0] !== 'protected') throw new Error('全部记录仅支持批量保护或取消保护。');
      const ids = selection === 'all' ? (await this.snapshots(gameId)).filter(meta => meta.kind !== 'safety').map(meta => meta.id) : selection;
      if (selection === 'all' && ids.length === 0) return { updated: [], failed: [] };
      const selected = this.validateSelection(ids);
      // Validate ownership and every manifest before changing the first item.
      const metas = [];
      for (const id of selected) metas.push(await this.readSnapshot(gameId, id));
      if (metas.some(meta => meta.purgePending)) throw new Error('所选记录包含尚未完成永久删除的项目，不能找回或修改。');
      if (changes.deleted && metas.some(meta => meta.protected)) throw new Error('所选记录中有保护存档，请先取消保护标记后再删除。');
      if ('protected' in changes && metas.some(meta => meta.kind === 'safety')) throw new Error('自动恢复点不能作为普通存档标记。');
      if ('protected' in changes && metas.some(meta => meta.deletedAt)) throw new Error('所选记录包含回收站存档，请先找回，再修改保护标记。');
      const report = { updated: [], failed: [] };
      const timestamp = new Date().toISOString();
      for (const meta of metas) {
        try {
          await this.fault('before-batch-mark', { gameId, id: meta.id, ...changes });
          if ('protected' in changes) meta.protected = changes.protected;
          else if (changes.deleted) meta.deletedAt = timestamp; else delete meta.deletedAt;
          await atomicJson(path.join(this.snapshotDir(gameId, meta.id), 'manifest.json'), meta);
          report.updated.push(meta.id);
        } catch (error) { report.failed.push({ id: meta.id, label: meta.label, error: error.message }); }
      }
      return report;
    });
  }

  async deleteSnapshots(gameId, ids) {
    return this.exclusive(async () => {
      this.game(gameId);
      const selected = this.validateSelection(ids);
      const root = path.resolve(this.gameDir(gameId), 'snapshots');
      const items = [];
      // Preflight the whole selection before marking or deleting any files.
      for (const id of selected) {
        const meta = await this.readSnapshot(gameId, id);
        if (!meta.deletedAt) throw new Error('只能永久删除回收站或已移除的恢复点中的记录。');
        if (meta.protected) throw new Error('保护存档不可删除，请先取消保护标记。');
        const folder = this.snapshotDir(gameId, id), stage = path.join(root, `.purging-${id}`), marker = path.join(root, `.purge-${id}.json`);
        for (const target of [folder, stage, marker]) {
          if (path.dirname(path.resolve(target)) !== root || !within(this.vault, target)) throw new Error('永久删除路径越界。');
          await assertNoLinks(target);
        }
        const original = await statMaybe(folder), staged = await statMaybe(stage);
        if (original && staged || staged && !meta.purgePending) throw new Error('永久删除暂存目录冲突，操作已停止。');
        await assertTreeNoLinks(folder); await assertTreeNoLinks(stage);
        items.push({ meta, folder, stage, marker });
      }
      const report = { updated: [], failed: [] };
      for (const { meta, folder, stage, marker } of items) {
        try {
          await this.fault('before-purge', { gameId, id: meta.id });
          // Keep the intent outside the directory being physically removed, so an
          // interrupted/partial deletion remains visible and can only be retried.
          await atomicJson(marker, { ...meta, purgePending: true });
          if (await statMaybe(folder)) await commitSnapshotDirectory(folder, stage);
          await assertTreeNoLinks(stage);
          await this.fault('before-purge-remove', { gameId, id: meta.id, stage });
          await fs.rm(stage, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
          await fs.rm(marker, { force: true });
          report.updated.push(meta.id);
          this.onProgress({ phase: 'deleting', completed: report.updated.length + report.failed.length, total: items.length, detail: meta.label });
        } catch (error) { report.failed.push({ id: meta.id, label: meta.label, error: error.message }); }
      }
      return report;
    });
  }

  async restoreSnapshot(gameId, id) {
    return this.exclusive(async () => {
      const game = this.game(gameId);
      const meta = await this.verify(gameId, id);
      if (meta.deletedAt) throw new Error('请先从回收站找回这份存档。');
      const { root, entries } = await this.location(game);
      if (!equal([...entries].sort(), [...meta.entries].sort())) throw new Error('当前游戏的备份项目与这份存档不一致。请在游戏设置中恢复对应的相对路径后再读档。');
      const safety = await this.capture(game, root, entries, { label: `读档前 · ${meta.label}`.slice(0, 100), note: '恢复前自动创建。可用这份存档撤销本次读档。', kind: 'safety', allowMissing: true });
      const transactionId = randomUUID();
      const stage = path.join(root, `.savehub-restore-${transactionId}`);
      const journalFile = path.join(this.dataDir, 'transactions', `${transactionId}.json`);
      const journal = { version: 1, id: transactionId, gameId, snapshotId: id, safetyId: safety.id, root, stage, entries, operations: [], status: 'preparing' };
      let journalWritten = false;
      try {
        await copyRecords(path.join(this.snapshotDir(gameId, id), 'payload'), path.join(stage, 'next'), meta.records, this.onProgress);
        const staged = await inventory(path.join(stage, 'next'), entries, { allowMissing: true });
        if (signature(staged) !== signature(meta)) throw new Error('恢复文件预校验失败，原存档未改动。');
        const current = await inventory(root, entries, { allowMissing: true });
        if (signature(current) !== signature(safety)) throw new Error('游戏存档在恢复前发生了变化，请先关闭游戏后重试。');
        journal.status = 'applying';
        await atomicJson(journalFile, journal); journalWritten = true;
        for (const entry of entries) {
          await assertNoLinks(path.join(root, entry));
          const target = path.join(root, entry), previous = path.join(stage, 'previous', entry), next = path.join(stage, 'next', entry);
          const hadTarget = Boolean(await statMaybe(target));
          journal.operations.push({ entry, hadTarget });
          await atomicJson(journalFile, journal);
          if (hadTarget) { await fs.mkdir(path.dirname(previous), { recursive: true }); await fs.rename(target, previous); }
          if (await statMaybe(next)) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.rename(next, target); }
          this.onProgress({ phase: 'restoring', completed: journal.operations.length, total: entries.length, detail: entry });
          await this.fault('after-install', { entry, journal });
        }
        const restored = await inventory(root, entries, { allowMissing: true });
        if (signature(restored) !== signature(meta)) throw new Error('读档后的内容校验失败，正在回滚。');
        journal.status = 'committed';
        await atomicJson(journalFile, journal);
        // Once committed, cleanup failures must not turn a successful restore into a rollback.
        try {
          await fs.rm(stage, { recursive: true, force: true });
          await fs.rm(journalFile, { force: true });
        } catch { /* Retain committed journal so the next startup can finish cleanup. */ }
        return { safetyId: safety.id, label: meta.label };
      } catch (error) {
        if (journalWritten) {
          try { await this.rollback(journal, journalFile); } catch (rollbackError) { throw new Error(`读档失败，自动回滚尚未完成：${rollbackError.message}。请保留游戏目录，下次启动将继续恢复。读档恢复点：${safety.id}`); }
        } else await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
        throw new Error(`读档未完成，原存档已保留或恢复。${error.message}`);
      }
    });
  }

  async rollback(journal, journalFile) {
    safeId(journal.id); safeId(journal.gameId);
    const expectedStage = path.join(journal.root, `.savehub-restore-${journal.id}`);
    if (journal.version !== 1 || !path.isAbsolute(journal.root) || path.resolve(journal.stage) !== expectedStage || !Array.isArray(journal.operations)) throw new Error('恢复日志路径无效，未操作任何游戏文件');
    const entries = cleanItems(journal.entries);
    await assertNoLinks(journal.root); await assertNoLinks(journal.stage);
    for (const operation of [...journal.operations].reverse()) {
      if (!entries.includes(operation.entry) || typeof operation.hadTarget !== 'boolean') throw new Error('恢复日志项目无效');
      const target = path.join(journal.root, operation.entry);
      const previous = path.join(journal.stage, 'previous', operation.entry);
      const next = path.join(journal.stage, 'next', operation.entry);
      await assertNoLinks(target); await assertNoLinks(previous);
      if (await statMaybe(previous)) {
        if (await statMaybe(target)) {
          const failed = path.join(journal.stage, 'failed', operation.entry);
          await fs.mkdir(path.dirname(failed), { recursive: true });
          await fs.rename(target, failed);
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(previous, target);
      } else if (!operation.hadTarget && !(await statMaybe(next)) && await statMaybe(target)) {
        const failed = path.join(journal.stage, 'failed', operation.entry);
        await fs.mkdir(path.dirname(failed), { recursive: true });
        await fs.rename(target, failed);
      }
    }
    journal.status = 'rolled-back';
    await atomicJson(journalFile, journal);
    // Keep the failed payload and journal for diagnosis; the original game files are restored.
  }

  async recoverTransactions() {
    const directory = path.join(this.dataDir, 'transactions');
    let names;
    try { names = await fs.readdir(directory); } catch (error) { if (missing(error)) return; throw error; }
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const journalFile = path.join(directory, name);
      const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
      if (journal.status === 'rolled-back') continue;
      if (journal.status === 'committed') {
        safeId(journal.id);
        if (journal.stage !== path.join(journal.root, `.savehub-restore-${journal.id}`)) throw new Error('事务目录无效');
        await assertNoLinks(journal.stage);
        await fs.rm(journal.stage, { recursive: true, force: true });
        await fs.rm(journalFile, { force: true });
      } else {
        await this.rollback(journal, journalFile);
        this.recoveryMessages.push('已恢复上次意外中断的读档操作，原游戏存档已还原。');
      }
    }
  }

  async importLegacy(gameId, directory) {
    return this.exclusive(async () => {
      const game = this.game(gameId);
      const entries = cleanItems(game.locations[this.platform]?.items || []);
      if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('请选择旧存档目录。');
      await assertNoLinks(directory);
      if (within(this.dataDir, directory) || within(directory, this.dataDir)) throw new Error('不能从 SaveHub 资料库本身导入。');
      const manifestFile = path.join(directory, 'manifest.json');
      const collectionFile = path.join(directory, 'collection.json');
      const report = { imported: [], skipped: [], failed: [] };
      const existing = await this.snapshots(gameId, true);
      let candidates;
      const namedExports = await this.namedExportCandidates(directory);
      if (namedExports) {
        candidates = namedExports;
      } else if (await statMaybe(collectionFile)) {
        await assertNoLinks(collectionFile);
        const collection = JSON.parse(await fs.readFile(collectionFile, 'utf8'));
        if (collection.version !== 1 || collection.type !== 'savehub-collection') throw new Error('批量导出清单格式无效。');
        const ids = this.validateSelection(collection.snapshots);
        candidates = ids.map(id => ({ name: id, id, exported: path.join(directory, `SaveHub-${id}`) }));
      } else if (await statMaybe(manifestFile)) {
        candidates = [{ name: path.basename(directory), exported: directory }];
      } else {
        const children = await fs.readdir(directory, { withFileTypes: true });
        candidates = children.filter(item => item.isDirectory() && item.name.startsWith('ArchiveFile')).map(item => ({ name: item.name, source: path.join(directory, item.name) }));
        if (!candidates.length) candidates = [{ name: path.basename(directory), source: directory }];
      }
      for (const [index, candidate] of candidates.entries()) {
        this.onProgress({ phase: 'importing', completed: index, total: candidates.length, detail: candidate.name });
        try {
          if (candidate.exported) {
            const manifest = path.join(candidate.exported, 'manifest.json');
            if (!candidate.meta) await assertNoLinks(manifest);
            const meta = candidate.meta || validateManifest(JSON.parse(await fs.readFile(manifest, 'utf8')));
            if (candidate.id && candidate.id !== meta.id) throw new Error('导出存档的身份与批量清单不一致。');
            candidate.name = meta.label;
            if (!equal([...meta.entries].sort(), [...entries].sort())) throw new Error('导出存档的相对路径与当前游戏配置不一致。');
            candidate.source = candidate.meta ? candidate.exported : path.join(candidate.exported, 'payload');
            const actual = await inventory(candidate.source, entries, { allowMissing: true });
            if (signature(actual) !== signature(meta)) throw new Error('导出存档的完整性校验失败。');
            candidate.allowMissing = meta.absent.length > 0;
            candidate.note = meta.note;
            candidate.favorite = meta.favorite;
            candidate.protected = meta.protected;
          }
          const data = await inventory(candidate.source, entries, { allowMissing: Boolean(candidate.allowMissing) });
          const digest = fingerprint(data);
          if (existing.some(snapshot => snapshot.origin?.path === candidate.source && snapshot.fingerprint === digest)) { report.skipped.push(candidate.name); continue; }
          const snapshot = await this.capture(game, candidate.source, entries, { label: candidate.name.slice(0, 100), note: candidate.note || `导入自 ${candidate.source}`, kind: 'imported', allowMissing: Boolean(candidate.allowMissing), origin: { path: candidate.source }, favorite: candidate.favorite, protected: candidate.protected });
          report.imported.push(candidate.name); existing.push(publicSnapshot(snapshot));
        } catch (error) { report.failed.push({ name: candidate.name, error: error.message }); }
      }
      return report;
    });
  }

  async exportSnapshot(gameId, id, destination) {
    const result = await this.exportSnapshots(gameId, [id], destination);
    return result.folder;
  }

  async exportIndexCandidates(root, onlyFolder) {
    const indexDir = path.join(root, EXPORT_INDEX);
    await assertNoLinks(indexDir);
    if (!(await statMaybe(indexDir))?.isDirectory()) return null;
    const candidates = [];
    const seen = new Set();
    for (const file of (await fs.readdir(indexDir)).filter(file => file.endsWith('.json')).sort()) {
      await assertNoLinks(path.join(indexDir, file));
      const index = JSON.parse(await fs.readFile(path.join(indexDir, file), 'utf8'));
      if (index.version !== 2 || index.type !== 'savehub-collection' || !Array.isArray(index.snapshots) || !index.snapshots.length || index.snapshots.length > 10000) throw new Error('命名导出清单格式无效。');
      for (const item of index.snapshots) {
        const [name] = cleanItems([item.directory]);
        if (name.includes('/') || foldedName(name) === EXPORT_INDEX || seen.has(foldedName(name))) throw new Error('导出清单包含无效或重复的存档目录。');
        seen.add(foldedName(name));
        if (onlyFolder && name !== onlyFolder) continue;
        const meta = validateManifest(item.manifest);
        candidates.push({ name: meta.label, id: meta.id, meta, exported: path.join(root, name) });
      }
    }
    return candidates.length ? candidates : null;
  }

  async namedExportCandidates(directory) {
    // A single named folder can contain arbitrary game files named manifest.json or collection.json.
    return await this.exportIndexCandidates(path.dirname(directory), path.basename(directory)) || await this.exportIndexCandidates(directory);
  }

  async writeExport(gameId, meta, folder) {
    await copyRecords(path.join(this.snapshotDir(gameId, meta.id), 'payload'), folder, meta.records, this.onProgress);
    const copy = await inventory(folder, meta.entries, { allowMissing: true });
    if (signature(copy) !== signature(meta)) throw new Error('导出文件校验失败。');
  }

  async exportSnapshots(gameId, selection, destination) {
    return this.exclusive(async () => {
      const game = this.game(gameId);
      const ids = selection === 'all'
        ? (await this.snapshots(gameId)).filter(meta => ['manual', 'imported'].includes(meta.kind)).map(meta => meta.id)
        : selection;
      const selected = this.validateSelection(ids);
      if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('请选择导出目录。');
      await assertNoLinks(destination);
      if (within(this.dataDir, destination)) throw new Error('请选择 SaveHub 资料库以外的导出目录。');
      const metas = [];
      for (const id of selected) metas.push(await this.verify(gameId, id));
      const batchId = randomUUID();
      const stage = path.join(destination, `.savehub-export-${batchId}`);
      const existing = new Set((await fs.readdir(destination)).map(foldedName));
      // Old unwrapped exports may retain index entries after a named folder is moved.
      // Reserve those names so importing the new bundle cannot resolve to an old entry.
      for (const candidate of await this.exportIndexCandidates(destination) || []) existing.add(foldedName(path.basename(candidate.exported)));
      const folder = path.join(destination, uniqueExportName(`${exportName(game.name)}-存档导出`, existing));
      const indexDir = path.join(folder, EXPORT_INDEX);
      const taken = new Set([EXPORT_INDEX]);
      const directories = metas.map(meta => uniqueExportName(exportName(meta.label), taken));
      const published = [];
      const indexFile = path.join(indexDir, `${batchId}.json`);
      let folderCreated = false;
      await fs.mkdir(stage);
      try {
        for (const [index, meta] of metas.entries()) {
          this.onProgress({ phase: 'exporting', completed: index, total: metas.length, detail: meta.label });
          await this.writeExport(gameId, meta, path.join(stage, directories[index]));
        }
        // Claim a fresh bundle only after all payloads are verified. Never replace
        // a folder created by another process after our name preflight.
        await this.fault('before-export-bundle-publish', { folder });
        await fs.mkdir(folder);
        folderCreated = true;
        await fs.mkdir(indexDir);
        for (const name of directories) {
          const target = path.join(folder, name), source = path.join(stage, name);
          await this.fault('before-export-publish', { directory: name, folder });
          await fs.mkdir(target);
          published.push(target);
          for (const child of await fs.readdir(source)) await fs.rename(path.join(source, child), path.join(target, child));
        }
        await atomicJson(indexFile, { version: 2, type: 'savehub-collection', gameId, gameName: game.name, exportedAt: new Date().toISOString(), snapshots: metas.map((manifest, index) => ({ directory: directories[index], manifest })) });
        return { folder, count: metas.length, directories, indexFile };
      } catch (error) {
        for (const target of published) {
          if (!within(destination, folder) || folder === destination || !within(folder, target) || target === folder) throw new Error('导出清理目录越界。');
          await fs.rm(target, { recursive: true, force: true });
        }
        if (folderCreated) {
          // Remove only empty containers so concurrent, unrelated files survive.
          await fs.rmdir(indexDir).catch(() => {});
          await fs.rmdir(folder).catch(() => {});
        }
        throw error;
      } finally {
        // This uniquely named, owned staging folder is always inside the chosen destination.
        if (!within(destination, stage)) throw new Error('导出暂存目录越界。');
        await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
      }
    });
  }
}
