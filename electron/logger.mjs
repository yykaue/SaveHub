import * as fs from 'node:fs/promises';
import path from 'node:path';

const MAX_LOG_BYTES = 1024 * 1024;

export class Logger {
  /**
   * @param {string} dataDir
   */
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.logDir = path.join(this.dataDir, 'logs');
    this.logFile = path.join(this.logDir, 'savehub.log');
    this.prevLogFile = path.join(this.logDir, 'savehub.1.log');
    /** @type {{ time: string; level: string; event: string; details?: Record<string, unknown> }[]} */
    this.entries = [];
  }

  /**
   * @param {'info' | 'warn' | 'error'} level
   * @param {string} event
   * @param {Record<string, unknown>} [details]
   */
  async write(level, event, details) {
    const entry = {
      time: new Date().toISOString(),
      level,
      event,
      ...(details ? { details } : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > 500) this.entries.shift();
    try {
      const rootStat = await fs.stat(this.dataDir).catch(() => null);
      if (!rootStat?.isDirectory()) return;
      await fs.mkdir(this.logDir, { recursive: true });
      const currentStat = await fs.stat(this.logFile).catch(() => null);
      if (currentStat && currentStat.size >= MAX_LOG_BYTES) {
        await fs.rename(this.logFile, this.prevLogFile).catch(() => {});
      }
      await fs.appendFile(this.logFile, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // Logging must never interrupt user save operations.
    }
  }

  /**
   * @param {string} event
   * @param {Record<string, unknown>} [details]
   */
  info(event, details) {
    return this.write('info', event, details);
  }

  /**
   * @param {string} event
   * @param {Record<string, unknown>} [details]
   */
  warn(event, details) {
    return this.write('warn', event, details);
  }

  /**
   * @param {string} event
   * @param {Record<string, unknown>} [details]
   */
  error(event, details) {
    return this.write('error', event, details);
  }
}

