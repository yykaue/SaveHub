import { AppError } from './errors.mjs';
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
 * Key-order-independent deep equality that ignores undefined object properties (matching JSON semantics).
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

/** Resolve existing path identity on the actual volume, including case aliases.
 * @param {string} root @param {string} target @param {string} [platform]
 */
export async function withinOnDisk(root, target, platform = process.platform) {
  const rootStat = await statMaybe(root);
  if (!rootStat) return within(root, target, platform);
  let current = path.resolve(target);
  while (true) {
    const stat = await statMaybe(current);
    if (stat && stat.dev === rootStat.dev && stat.ino === rootStat.ino) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** @param {{ directory: string; bytes: number }[]} budgets @param {string} [lang] */
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
      // Windows can briefly hold a newly written backup directory open. Retry only
      // this final commit, with a bounded delay; do not retry over an existing target.
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
 * @param {string} file
 * @returns {Promise<string>}
 */
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
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
 * Check available disk space before writing large payloads.
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
        // Validate filenames too, so a backup made on one OS is safe on the other.
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
 * @param {{ absent: string[]; records: any[] }} value
 */
export const signature = (value) =>
  JSON.stringify({
    absent: value.absent,
    records: value.records.map(({ path: file, type, size, sha256 }) => ({ path: file, type, size, sha256 })),
  });

/**
 * @param {{ absent: string[]; records: any[] }} value
 */
export const fingerprint = (value) => createHash('sha256').update(signature(value)).digest('hex');

/**
 * @param {string} source
 * @param {string} target
 * @param {import('./models').FileRecord[]} records
 * @param {(p: any) => void} [progress]
 */
export async function copyRecords(source, target, records, progress = () => {}) {
  const copied = records.map((record) => ({ ...record }));
  await fs.mkdir(target, { recursive: true });
  const dirs = records.filter((record) => record.type === 'directory').sort((a, b) => a.path.length - b.path.length);
  for (const record of dirs) await fs.mkdir(path.join(target, record.path), { recursive: true });
  const files = copied.filter((record) => record.type === 'file');
  let completed = 0;
  for (const record of files) {
    const dest = path.join(target, record.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const origin = path.join(source, record.path);
    await assertNoLinks(origin);
    const input = await fs.open(origin, 'r');
    try {
      const before = await input.stat();
      if (!before.isFile() || before.size !== record.size) {
        throw new AppError('storage.fileChanging', { path: record.path }, undefined);
      }
      const output = await fs.open(dest, 'wx');
      const hash = createHash('sha256');
      try {
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          hash.update(chunk);
          await output.writeFile(chunk);
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
        throw new AppError('storage.fileChanging', { path: record.path }, undefined);
      }
      record.sha256 = digest;
    } finally {
      await input.close();
    }
    const date = new Date(record.mtimeMs);
    await fs.utimes(dest, date, date);
    progress({ phase: 'copying', completed: ++completed, total: files.length, detail: record.path });
  }
  for (const record of dirs.reverse()) {
    const date = new Date(record.mtimeMs);
    await fs.utimes(path.join(target, record.path), date, date);
  }
  return copied;
}

/**
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
  // One compatibility default, persisted on the next write; never use read time.
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
 * @param {any} meta
 */
export const publicSnapshot = ({ records, ...snapshot }) => snapshot;

/**
 * @param {string} label
 */
export function exportName(label) {
  let name = label
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '');
  // Leave room for collision suffixes on filesystems with a 255-byte name limit.
  while (Buffer.byteLength(name, 'utf8') > 180) name = Array.from(name).slice(0, -1).join('');
  name = name.replace(/[. ]+$/g, '') || '未命名存档';
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
