import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { assertNoLinks, missing } from './fs-utils.mjs';
import { DEFAULT_LOG_LIMIT_MB, BYTES_PER_MB } from '../shared/log-settings.mjs';

export const MAX_LOG_BYTES = DEFAULT_LOG_LIMIT_MB * BYTES_PER_MB;
const operations = new Set([
  'application',
  'startup',
  'capture',
  'restore',
  'import',
  'export',
  'recover',
  'prune',
  'settings',
  'recovery',
  'delete',
  'verify',
  'game',
]);
const levels = new Set(['info', 'warn', 'error']);

/** @param {string} event @param {unknown} explicit */
function operationOf(event, explicit) {
  if (typeof explicit === 'string' && operations.has(explicit)) return explicit;
  for (const [pattern, operation] of /** @type {[RegExp, string][]} */ ([
    [/prun|retention/i, 'prune'],
    [/recover|rollback|quarantin|corrupt/i, 'recovery'],
    [/restore/i, 'restore'],
    [/saveSnapshot|capture/i, 'capture'],
    [/import/i, 'import'],
    [/export/i, 'export'],
    [/delete|purge/i, 'delete'],
    [/theme|language|setting/i, 'settings'],
    [/game/i, 'game'],
    [/verify/i, 'verify'],
  ]))
    if (pattern.test(event)) return operation;
  return 'application';
}

export class Logger {
  /** @param {string} dataDir @param {{ maxBytes?: number; clock?: () => Date }} [options] */
  constructor(dataDir, { maxBytes = MAX_LOG_BYTES, clock = () => new Date() } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.logDir = path.join(this.dataDir, 'logs');
    this.maxBytes = maxBytes;
    this.clock = clock;
    /** @type {any[]} */
    this.entries = [];
    /** @type {{ line: string; bytes: number; file: string; time: string; sequence: number }[]} */
    this.records = [];
    this.totalBytes = 0;
    this.sequence = 0;
    this.loaded = false;
    this.queue = Promise.resolve();
    /** @type {AsyncLocalStorage<{ operation: string; operationId: string }>} */
    this.context = new AsyncLocalStorage();
    /** @type {string | null} */
    this.lastError = null;
  }

  /** @param {any} entry */
  appendRecord(entry) {
    const sequence = Number.isSafeInteger(entry.sequence) && entry.sequence >= 0 ? entry.sequence : this.sequence;
    this.sequence = Math.max(this.sequence, sequence + 1);
    entry = { ...entry, sequence };
    let line = JSON.stringify(entry) + '\n';
    if (Buffer.byteLength(line) > Math.min(64 * 1024, this.maxBytes)) {
      line = JSON.stringify({ ...entry, details: { truncated: true } }) + '\n';
    }
    const record = {
      line,
      bytes: Buffer.byteLength(line),
      time: entry.time,
      sequence,
      file: path.join(this.logDir, entry.level, `${entry.operation}.jsonl`),
    };
    this.records.push(record);
    this.totalBytes += record.bytes;
    return record;
  }

  async load() {
    if (this.loaded) return;
    await assertNoLinks(this.logDir);
    await fs.mkdir(this.logDir, { recursive: true });
    /** @type {string[]} */
    const legacy = [],
      files = [];
    for (const item of await fs.readdir(this.logDir, { withFileTypes: true })) {
      if (item.isDirectory() && levels.has(item.name)) {
        const directory = path.join(this.logDir, item.name);
        await assertNoLinks(directory);
        for (const name of await fs.readdir(directory))
          if (/^[a-z]+\.jsonl$/.test(name)) files.push(path.join(directory, name));
      } else if (item.isFile() && /^savehub(?:\.\d+)?\.log$/.test(item.name)) {
        const file = path.join(this.logDir, item.name);
        files.push(file);
        legacy.push(file);
      }
    }
    const migrated = new Set(files.filter((file) => !legacy.includes(file)));
    for (const file of files.sort()) {
      await assertNoLinks(file);
      for (const line of (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)) {
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          value = { event: 'legacy-unparsed', details: { text: line.slice(0, 8192) } };
        }
        const entry = {
          time:
            typeof value?.time === 'string' && Number.isFinite(Date.parse(value.time))
              ? new Date(value.time).toISOString()
              : new Date(0).toISOString(),
          level: levels.has(value?.level) ? value.level : 'warn',
          event: typeof value?.event === 'string' ? value.event.slice(0, 160) : 'legacy',
          operation: operationOf(value?.event || '', value?.operation || value?.details?.operation),
          operationId: typeof value?.operationId === 'string' ? value.operationId.slice(0, 64) : 'legacy',
          phase: typeof value?.phase === 'string' ? value.phase.slice(0, 32) : 'event',
          result: typeof value?.result === 'string' ? value.result.slice(0, 32) : 'recorded',
          ...(value?.gameId ? { gameId: value.gameId } : {}),
          ...(value?.snapshotId ? { snapshotId: value.snapshotId } : {}),
          ...(value?.code ? { code: value.code } : {}),
          details: value?.details,
          sequence: value?.sequence,
        };
        migrated.add(this.appendRecord(entry).file);
      }
    }
    this.trim(migrated);
    await this.rewrite(migrated);
    for (const file of legacy) await fs.rm(file, { force: true });
    this.loaded = true;
  }

  /** @param {Set<string>} affected */
  trim(affected) {
    this.records.sort((a, b) => a.time.localeCompare(b.time) || a.sequence - b.sequence);
    while (this.totalBytes > this.maxBytes && this.records.length) {
      const oldest = this.records.shift();
      if (!oldest) break;
      this.totalBytes -= oldest.bytes;
      affected.add(oldest.file);
    }
  }

  /** @param {Set<string>} files */
  async rewrite(files) {
    for (const file of files) {
      await assertNoLinks(file);
      const records = this.records.filter((record) => record.file === file);
      if (!records.length) {
        await fs.rm(file, { force: true });
        continue;
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, records.map((record) => record.line).join(''), { flag: 'wx' });
        await fs.rename(temp, file);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => {});
      }
    }
  }

  /** Apply a new shared budget in queue order, including clearing all retained logs at zero. @param {number} maxBytes */
  setMaxBytes(maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid log byte limit');
    const update = this.queue.then(async () => {
      this.maxBytes = maxBytes;
      if (!this.loaded) await this.load();
      else {
        const affected = new Set();
        this.trim(affected);
        await this.rewrite(affected);
      }
      if (maxBytes === 0) this.entries = [];
      this.lastError = null;
    });
    this.queue = update.catch((error) => {
      this.lastError = String(error);
      this.loaded = false;
      this.records = [];
      this.totalBytes = 0;
    });
    return update;
  }

  /** @param {'info' | 'warn' | 'error'} level @param {string} event @param {Record<string, unknown>} [details] */
  write(level, event, details) {
    const context = this.context.getStore();
    const entry = {
      time: this.clock().toISOString(),
      level,
      event: event.slice(0, 160),
      operation: operationOf(event, details?.operation || context?.operation),
      operationId: context?.operationId || randomUUID(),
      phase: typeof details?.phase === 'string' ? details.phase.slice(0, 32) : 'event',
      result: details?.result || (level === 'error' ? 'failure' : 'recorded'),
      ...(details?.gameId ? { gameId: details.gameId } : {}),
      ...(details?.snapshotId ? { snapshotId: details.snapshotId } : {}),
      ...(details?.code ? { code: details.code } : {}),
      details,
    };
    this.queue = this.queue.then(async () => {
      try {
        if (this.maxBytes === 0) return;
        if (!(await fs.stat(this.dataDir)).isDirectory()) return;
        await this.load();
        const record = this.appendRecord(entry);
        this.entries.push(JSON.parse(record.line));
        if (this.entries.length > 500) this.entries.shift();
        await assertNoLinks(record.file);
        await fs.mkdir(path.dirname(record.file), { recursive: true });
        await fs.appendFile(record.file, record.line, 'utf8');
        const affected = new Set();
        this.trim(affected);
        if (affected.size) await this.rewrite(affected);
      } catch (error) {
        if (!missing(error)) this.lastError = String(error);
        this.loaded = false;
        this.records = [];
        this.totalBytes = 0;
      }
    });
    return this.queue;
  }

  /** @template T @param {string} name @param {() => Promise<T>} action @param {Record<string, unknown>} [details] */
  async run(name, action, details = {}) {
    return this.context.run({ operation: operationOf(name, name), operationId: randomUUID() }, async () => {
      await this.info(name, { ...details, phase: 'started', result: 'pending' });
      try {
        const result = await action();
        await this.info(name, { ...details, phase: 'committed', result: 'success' });
        return result;
      } catch (error) {
        await this.error(name, {
          ...details,
          phase: 'failed',
          result: 'failure',
          error: String(error),
          code: /** @type {{code?:string}} */ (error)?.code || 'UNEXPECTED',
        });
        throw error;
      }
    });
  }

  /** @param {string} event @param {Record<string, unknown>} [details] */
  info(event, details) {
    return this.write('info', event, details);
  }
  /** @param {string} event @param {Record<string, unknown>} [details] */
  warn(event, details) {
    return this.write('warn', event, details);
  }
  /** @param {string} event @param {Record<string, unknown>} [details] */
  error(event, details) {
    return this.write('error', event, details);
  }
}
