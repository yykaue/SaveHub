import { AppError } from './errors.mjs';
import { translate } from './i18n.mjs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export const ID = /^[a-z0-9-]{1,64}$/;
export const MAX_FILES = 100000;
export const EXPORT_INDEX = '.savehub-exports';

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export const missing = (error) => /** @type {{ code?: string }} */ (error)?.code === 'ENOENT';

/**
 * 与对象属性顺序无关的深度相等性判断，忽略值为 undefined 的属性（与 JSON 序列化语义保持一致）。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
    return true;
  }
  const objA = /** @type {Record<string, unknown>} */ (a);
  const objB = /** @type {Record<string, unknown>} */ (b);
  const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined);
  const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key) || !equal(objA[key], objB[key])) return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @param {string} [lang]
 * @returns {string}
 */
export function safeId(value, lang) {
  if (typeof value !== 'string' || !ID.test(value)) throw new AppError('storage.invalidId', undefined, lang);
  return value;
}

/**
 * 清理并校验备份条目相对路径：
 * 禁止空路径、`.`/`..` 路径穿越、非法文件名字符、末尾点/空格、Windows 保留设备名，以及重复或父子嵌套重叠路径。
 * @param {unknown} values
 * @param {{ allowEmpty?: boolean; lang?: string }} [options]
 * @returns {string[]}
 */
export function cleanItems(values, { allowEmpty = false, lang } = {}) {
  if (!Array.isArray(values) || values.length > 128) throw new AppError('storage.itemCountRange', undefined, lang);
  const items = values.map((value) => {
    if (typeof value !== 'string') throw new AppError('storage.itemMustBeString', undefined, lang);
    const item = value.trim().replaceAll('\\', '/');
    if (
      !item ||
      item.length > 1024 ||
      item
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            /[<>:"|?*\x00-\x1f]/.test(part) ||
            /[. ]$/.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        )
    ) {
      throw new AppError('storage.unsafeRelativePath', { value }, lang);
    }
    return item;
  });
  if (!allowEmpty && !items.length) throw new AppError('storage.atLeastOneItem', undefined, lang);
  const folded = items.map((item) => item.toLowerCase());
  if (
    folded.some((item, i) => folded.some((other, j) => i !== j && (item === other || item.startsWith(`${other}/`))))
  ) {
    throw new AppError('storage.duplicateOrNestedItems', undefined, lang);
  }
  return items;
}

/**
 * 纯词法层面的路径包含判断（在 Windows 与 macOS 上默认按不区分大小写折叠比较）。
 * @param {string} root
 * @param {string} target
 * @param {string} [platform]
 * @returns {boolean}
 */
export function within(root, target, platform = process.platform) {
  const normalize = /** @param {string} value */ (value) => {
    const resolved = path.resolve(value).normalize('NFC');
    return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
  };
  const relative = path.relative(normalize(root), normalize(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * 向上回溯目标路径，解析最深层已存在的磁盘祖先目录（含其 stat）及尚未创建的剩余相对路径段。
 * @param {string} target
 */
async function resolveExistingAncestor(target) {
  let current = path.resolve(target).normalize('NFC');
  /** @type {string[]} */
  const tail = [];
  while (true) {
    const stat = await statMaybe(current);
    if (stat) return { dir: current, stat, tail };
    const parent = path.dirname(current);
    if (parent === current) return { dir: current, stat: null, tail };
    tail.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * 探测指定已存在目录所在的文件系统卷是否不区分大小写（避免在 macOS 大小写敏感 APFS 卷上误判别名）。
 * @param {string} dirPath
 * @param {import('node:fs').Stats} dirStat
 * @param {string} platform
 */
async function isCaseInsensitiveDir(dirPath, dirStat, platform) {
  if (platform === 'win32') return true;
  if (platform !== 'darwin') return false;
  let current = dirPath;
  let currentStat = dirStat;
  while (true) {
    const base = path.basename(current);
    const flipped = base !== base.toLowerCase() ? base.toLowerCase() : base.toUpperCase();
    if (flipped !== base) {
      const alt = await statMaybe(path.join(path.dirname(current), flipped));
      return Boolean(alt && alt.dev === currentStat.dev && alt.ino === currentStat.ino);
    }
    const parent = path.dirname(current);
    if (parent === current) return true;
    const parentStat = await statMaybe(parent);
    if (!parentStat) return true;
    current = parent;
    currentStat = parentStat;
  }
}

/**
 * 基于真实磁盘卷身份（dev + ino）判定 target 是否位于 root 目录内（含大小写别名与尚未创建的子路径）。
 * @param {string} root @param {string} target @param {string} [platform]
 */
export async function withinOnDisk(root, target, platform = process.platform) {
  const rootStat = await statMaybe(root);
  if (rootStat) {
    let current = path.resolve(target);
    while (true) {
      const stat = await statMaybe(current);
      if (
        stat &&
        rootStat.ino > 0 &&
        stat.ino > 0 &&
        stat.dev === rootStat.dev &&
        stat.ino === rootStat.ino
      )
        return true;
      const parent = path.dirname(current);
      if (parent === current) return within(root, target, platform);
      current = parent;
    }
  }
  const rootResolved = await resolveExistingAncestor(root);
  const targetResolved = await resolveExistingAncestor(target);
  if (!rootResolved.stat || !targetResolved.stat) return within(root, target, platform);
  if (
    targetResolved.stat.dev !== rootResolved.stat.dev ||
    targetResolved.stat.ino !== rootResolved.stat.ino ||
    targetResolved.tail.length < rootResolved.tail.length
  ) {
    return false;
  }
  const fold = await isCaseInsensitiveDir(rootResolved.dir, rootResolved.stat, platform);
  const norm = /** @param {string} seg */ (seg) => (fold ? seg.normalize('NFC').toLowerCase() : seg.normalize('NFC'));
  return rootResolved.tail.every((segment, index) => norm(segment) === norm(targetResolved.tail[index] || ''));
}

/**
 * 按真实磁盘卷（stat.dev）聚合多个写入目录的空间需求，防止同卷多路写入叠加后超出可用磁盘空间。
 * @param {{ directory: string; bytes: number }[]} budgets @param {string} [lang]
 */
export async function assertDiskBudgets(budgets, lang) {
  /** @type {Map<number, { directory: string; bytes: number }>} */
  const volumes = new Map();
  for (const budget of budgets) {
    let directory = path.resolve(budget.directory);
    let stat = await statMaybe(directory);
    while (!stat && directory !== path.dirname(directory)) {
      directory = path.dirname(directory);
      stat = await statMaybe(directory);
    }
    if (!stat) throw new AppError('storage.diskSpaceUnavailable', { error: directory }, lang);
    const current = volumes.get(stat.dev);
    volumes.set(stat.dev, { directory, bytes: budget.bytes + (current?.bytes || 0) });
  }
  for (const budget of volumes.values()) await assertDiskSpace(budget.directory, budget.bytes, lang);
}

/**
 * @param {string} file
 */
export async function statMaybe(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/**
 * @param {string} file
 */
export async function statBigIntMaybe(file) {
  try {
    return await fs.lstat(file, { bigint: true });
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/**
 * 从文件系统根部逐级校验目标路径上的每一层组件，拒绝任何符号链接或 Windows 目录联接（Junction），防止越界读写。
 * @param {string} file
 * @param {string} [lang]
 */
export async function assertNoLinks(file, lang) {
  const resolved = path.resolve(file);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await statMaybe(cursor);
    if (stat?.isSymbolicLink()) throw new AppError('storage.symlinkNotSupported', { path: cursor }, lang);
  }
}

/**
 * 递归校验整个目录树（含祖先路径与所有后代条目）不存在任何符号链接或目录联接，用于物理删除前的安全预检。
 * @param {string} directory
 * @param {string} [lang]
 */
export async function assertTreeNoLinks(directory, lang) {
  await assertNoLinks(directory, lang);
  if (!(await statMaybe(directory))) return;
  const walk = async (/** @type {string} */ current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new AppError('storage.symlinkOnPurge', undefined, lang);
      if (entry.isDirectory()) await walk(file);
    }
  };
  await walk(directory);
}

/**
 * 原子提交快照目录重命名：在 Windows 下容忍杀毒软件或索引服务短暂持有新目录句柄导致的 EPERM/EBUSY/EACCES，
 * 进行有界退避重试；若目标目录已存在则立即报错，绝不覆盖已有目录。
 * @param {string} source
 * @param {string} destination
 * @param {{ platform?: string; rename?: typeof fs.rename; pause?: typeof delay }} [options]
 */
export async function commitSnapshotDirectory(
  source,
  destination,
  { platform = process.platform, rename = fs.rename, pause = delay } = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code || '';
      // Windows 可能短暂占用刚写入的备份目录；仅在目标不存在时对最终重命名做有界延迟重试。
      if (
        platform !== 'win32' ||
        !['EPERM', 'EBUSY', 'EACCES'].includes(code) ||
        attempt >= 4 ||
        (await statMaybe(destination))
      )
        throw error;
      await pause(50 * (attempt + 1));
    }
  }
}

/**
 * 流式计算单个文件的 SHA-256 十六进制摘要。
 * @param {string} file
 * @returns {Promise<string>}
 */
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * 原子写入 JSON 文件：先以排他模式（wx）写入同目录临时文件并 fsync 落盘，再通过 rename 原子替换目标文件。
 * @param {string} file
 * @param {unknown} value
 */
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx');
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytesSimple(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/**
 * 在写入大体积载荷前检查目标目录所在卷的可用磁盘空间（要求至少满足 1.05 倍载荷大小 + 64KB 事务元数据余量）。
 * @param {string} targetDir
 * @param {number} requiredBytes
 * @param {string} [lang]
 */
export async function assertDiskSpace(targetDir, requiredBytes, lang) {
  if (!Number.isFinite(requiredBytes) || requiredBytes < 0 || typeof fs.statfs !== 'function') return;
  let probe = path.resolve(targetDir);
  while (probe !== path.dirname(probe) && !(await statMaybe(probe))) {
    probe = path.dirname(probe);
  }
  let stats;
  try {
    stats = await fs.statfs(probe);
  } catch (error) {
    throw new AppError('storage.diskSpaceUnavailable', { error: /** @type {Error} */ (error).message }, lang);
  }
  const available = Number(BigInt(stats.bavail) * BigInt(stats.bsize));
  const needed = Math.ceil(requiredBytes * 1.05) + 65536;
  if (Number.isFinite(available) && available >= 0 && available < needed) {
    throw new AppError(
      'storage.insufficientDiskSpace',
      {
        required: formatBytesSimple(needed),
        available: formatBytesSimple(available),
      },
      lang,
    );
  }
}

/**
 * 扫描并生成指定根目录与相对路径条目的文件清单（Inventory）：
 * 校验符号链接、跨平台文件名合法性，并在计算文件哈希前后比对 size/mtimeMs 以拦截并发写入中的半成品文件。
 * @param {string} root
 * @param {string[]} entries
 * @param {{ allowMissing?: boolean; progress?: (p: any) => void; lang?: string; hash?: boolean }} [options]
 */
export async function inventory(root, entries, { allowMissing = false, progress = () => {}, lang, hash = true } = {}) {
  /** @type {any[]} */
  const records = [];
  /** @type {string[]} */
  const absent = [];
  const walk = async (/** @type {string} */ relative) => {
    if (records.length >= MAX_FILES) throw new AppError('storage.maxFilesExceeded', undefined, lang);
    const file = path.join(root, ...relative.split('/'));
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new AppError('storage.symlinkInInventory', { path: relative }, lang);
    if (stat.isDirectory()) {
      records.push({ path: relative, type: 'directory', mtimeMs: stat.mtimeMs });
      const names = (await fs.readdir(file)).sort();
      for (const name of names) {
        // 同时校验子文件名，确保在一个操作系统上创建的备份可在另一个操作系统上安全恢复。
        cleanItems([name], { lang });
        await walk(`${relative}/${name}`);
      }
    } else if (stat.isFile()) {
      const sha256 = hash ? await hashFile(file) : undefined;
      const after = await fs.lstat(file);
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) {
        throw new AppError('storage.fileChanging', { path: relative }, lang);
      }
      records.push({ path: relative, type: 'file', size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
      progress({ phase: 'checking', detail: relative, completed: records.length });
    } else {
      throw new AppError('storage.unsupportedFileType', { path: relative }, lang);
    }
  };
  for (const entry of entries) {
    await assertNoLinks(path.join(root, entry), lang);
    if (!(await statMaybe(path.join(root, entry)))) {
      if (!allowMissing) throw new AppError('storage.missingSavePath', { entry }, lang);
      absent.push(entry);
    } else {
      await walk(entry);
    }
  }
  records.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { records, absent };
}

/**
 * 生成清单的内容完整性签名字符串（含缺失路径列表与各条目的路径、类型、字节数与 SHA-256）。
 * @param {{ absent: string[]; records: any[] }} value
 */
export const signature = (value) =>
  JSON.stringify({
    absent: value.absent,
    records: value.records.map(({ path: file, type, size, sha256 }) => ({ path: file, type, size, sha256 })),
  });

/**
 * 计算清单内容签名的 SHA-256 指纹，用于快速判断两个快照或待导入目录的内容是否完全一致。
 * @param {{ absent: string[]; records: any[] }} value
 */
export const fingerprint = (value) => createHash('sha256').update(signature(value)).digest('hex');

/**
 * 按清单记录流式复制文件与空目录到目标位置：
 * 在复制过程中流式计算 SHA-256，并在复制前后比对源文件 inode/size/mtimeMs 与预期哈希，
 * 防止源文件在备份期间被并发篡改或替换；复制完成后还原文件与目录的修改时间戳。
 * @param {string} source
 * @param {string} target
 * @param {import('./models').FileRecord[]} records
 * @param {(p: any) => void} [progress]
 * @param {string} [lang]
 */
export async function copyRecords(source, target, records, progress = () => {}, lang) {
  const copied = records.map((record) => ({ ...record }));
  const resolvedSource = path.resolve(source);
  const resolvedTarget = path.resolve(target);
  await assertNoLinks(resolvedSource, lang);
  await assertNoLinks(resolvedTarget, lang);
  await fs.mkdir(resolvedTarget, { recursive: true });
  const createdDirs = new Set([resolvedTarget]);
  const checkedSourceDirs = new Set([resolvedSource]);
  const dirs = records.filter((record) => record.type === 'directory').sort((a, b) => a.path.length - b.path.length);
  for (const record of dirs) {
    const dir = path.resolve(resolvedTarget, record.path);
    await fs.mkdir(dir, { recursive: true });
    createdDirs.add(dir);
  }
  const files = copied.filter((record) => record.type === 'file');
  const totalBytes = files.reduce((sum, record) => sum + (record.size || 0), 0);
  let copiedBytes = 0;
  let completed = 0;
  for (const record of files) {
    const dest = path.join(resolvedTarget, record.path);
    const destDir = path.dirname(dest);
    if (!createdDirs.has(destDir)) {
      await fs.mkdir(destDir, { recursive: true });
      createdDirs.add(destDir);
    }
    const origin = path.join(resolvedSource, record.path);
    const originDir = path.dirname(origin);
    if (!checkedSourceDirs.has(originDir)) {
      await assertNoLinks(originDir, lang);
      let currentDir = originDir;
      while (currentDir !== resolvedSource && currentDir !== path.dirname(currentDir)) {
        checkedSourceDirs.add(currentDir);
        currentDir = path.dirname(currentDir);
      }
    }
    const originStat = await statMaybe(origin);
    if (originStat?.isSymbolicLink()) throw new AppError('storage.symlinkNotSupported', { path: origin }, lang);
    const input = await fs.open(origin, 'r');
    try {
      const before = await input.stat();
      if (!before.isFile() || before.size !== record.size) {
        throw new AppError('storage.fileChanging', { path: record.path }, lang);
      }
      const output = await fs.open(dest, 'wx');
      const hash = createHash('sha256');
      try {
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          hash.update(chunk);
          await output.writeFile(chunk);
          copiedBytes += chunk.length;
          progress({
            phase: 'copying',
            completed,
            total: files.length,
            detail: record.path,
            percent: totalBytes ? (100 * copiedBytes) / totalBytes : 0,
          });
        }
      } finally {
        await output.close();
      }
      const after = await input.stat();
      const current = await fs.lstat(origin);
      const digest = hash.digest('hex');
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        current.isSymbolicLink() ||
        before.ino !== current.ino ||
        before.size !== current.size ||
        before.mtimeMs !== current.mtimeMs ||
        (record.sha256 && record.sha256 !== digest)
      ) {
        throw new AppError('storage.fileChanging', { path: record.path }, lang);
      }
      record.sha256 = digest;
    } finally {
      await input.close();
    }
    const date = new Date(record.mtimeMs);
    await fs.utimes(dest, date, date);
    progress({
      phase: 'copying',
      completed: ++completed,
      total: files.length,
      detail: record.path,
      percent: totalBytes ? (100 * copiedBytes) / totalBytes : (100 * completed) / files.length,
    });
  }
  for (const record of dirs.reverse()) {
    const date = new Date(record.mtimeMs);
    await fs.utimes(path.join(resolvedTarget, record.path), date, date);
  }
  return copied;
}

/**
 * 严格校验快照 manifest.json 的结构、字段范围、路径作用域及文件总数/总字节数一致性。
 * @param {any} meta
 * @param {string} [lang]
 * @returns {import('./models').Manifest}
 */
export function validateManifest(meta, lang) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta))
    throw new AppError('storage.invalidManifestFormat', undefined, lang);
  safeId(meta.id, lang);
  safeId(meta.gameId, lang);
  if (
    meta.version !== 1 ||
    typeof meta.label !== 'string' ||
    !Array.isArray(meta.records) ||
    meta.records.length > MAX_FILES
  ) {
    throw new AppError('storage.invalidManifestFormat', undefined, lang);
  }
  const entries = cleanItems(meta.entries, { lang });
  const validDate = (/** @type {unknown} */ value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (
    !validDate(meta.createdAt) ||
    (meta.updatedAt !== undefined && !validDate(meta.updatedAt)) ||
    (meta.deletedAt !== undefined && !validDate(meta.deletedAt)) ||
    !['manual', 'imported', 'safety'].includes(meta.kind) ||
    !['win32', 'darwin'].includes(meta.platform) ||
    !Number.isSafeInteger(meta.bytes) ||
    meta.bytes < 0 ||
    !Number.isSafeInteger(meta.fileCount) ||
    meta.fileCount < 0 ||
    (meta.note !== undefined && typeof meta.note !== 'string') ||
    ['favorite', 'protected', 'purgePending'].some((key) => meta[key] !== undefined && typeof meta[key] !== 'boolean')
  ) {
    throw new AppError('storage.invalidManifestFormat', undefined, lang);
  }
  // 兼容旧版未记录 updatedAt 的快照：固定回退到 createdAt 并在下次写入时持久化，绝不使用当前读取时间。
  meta.updatedAt ??= meta.createdAt;
  if (!Array.isArray(meta.absent) || meta.absent.some((/** @type {string} */ item) => !entries.includes(item))) {
    throw new AppError('storage.invalidManifestPaths', undefined, lang);
  }
  const seen = new Set();
  for (const record of meta.records) {
    if (!record || typeof record !== 'object') throw new AppError('storage.invalidManifestFileInfo', undefined, lang);
    cleanItems([record.path], { lang });
    if (
      !entries.some((entry) => record.path === entry || record.path.startsWith(`${entry}/`)) ||
      meta.absent.some((/** @type {string} */ entry) => record.path === entry || record.path.startsWith(`${entry}/`))
    ) {
      throw new AppError('storage.manifestOutOfScope', undefined, lang);
    }
    if (seen.has(record.path.toLowerCase())) throw new AppError('storage.manifestDuplicateFiles', undefined, lang);
    seen.add(record.path.toLowerCase());
    if (!['file', 'directory'].includes(record.type) || !Number.isFinite(record.mtimeMs)) {
      throw new AppError('storage.invalidManifestFileInfo', undefined, lang);
    }
    if (
      record.type === 'file' &&
      (!/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size < 0)
    ) {
      throw new AppError('storage.invalidManifestChecksum', undefined, lang);
    }
  }
  const files = meta.records.filter((/** @type {any} */ record) => record.type === 'file');
  if (
    meta.bytes !== files.reduce((/** @type {number} */ sum, /** @type {any} */ record) => sum + record.size, 0) ||
    meta.fileCount !== files.length
  ) {
    throw new AppError('storage.invalidManifestFileInfo', undefined, lang);
  }
  return meta;
}

/**
 * 剥离内部文件级 records 明细，生成供前端渲染与缓存使用的公开快照摘要。
 * @param {any} meta
 */
export const publicSnapshot = ({ records, ...snapshot }) => snapshot;

/**
 * 将任意标签清洗为跨平台安全的导出目录名，并限制字节长度以预留冲突编号后缀空间。
 * @param {string} label
 * @param {string} [lang]
 */
export function exportName(label, lang) {
  let name = label
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '');
  // 为单文件名上限 255 字节的文件系统预留冲突编号后缀空间（控制在 180 UTF-8 字节以内）。
  while (Buffer.byteLength(name, 'utf8') > 180) name = Array.from(name).slice(0, -1).join('');
  name = name.replace(/[. ]+$/g, '') || translate(lang, 'storage.unnamedExport');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name.toLowerCase().startsWith('.savehub-export'))
    name = `_${name}`;
  return name;
}

/**
 * @param {string} name
 */
export const foldedName = (name) => name.normalize('NFC').toLowerCase();

/**
 * @param {string} base
 * @param {Set<string>} taken
 */
export function uniqueExportName(base, taken) {
  let name = base,
    suffix = 2;
  while (taken.has(foldedName(name))) name = `${base} (${suffix++})`;
  taken.add(foldedName(name));
  return name;
}
