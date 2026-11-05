/** Byte-bounded LRU for list summaries; never stores manifest file records. */
export class SummaryCache extends Map {
  /** @param {number} [maxBytes] */
  constructor(maxBytes = 8 * 1024 * 1024) {
    super();
    this.maxBytes = maxBytes;
    this.bytes = 0;
    /** @type {Map<string, number>} */
    this.sizes = new Map();
  }
  /** @param {string} key */
  get(key) {
    const value = super.get(key);
    if (value !== undefined) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }
  /** @param {string} key @param {any} value */
  set(key, value) {
    this.delete(key);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxBytes) return this;
    while (this.bytes + bytes > this.maxBytes && this.size) this.delete(this.keys().next().value);
    super.set(key, value);
    this.sizes.set(key, bytes);
    this.bytes += bytes;
    return this;
  }
  /** @param {string} key */
  delete(key) {
    this.bytes -= this.sizes.get(key) || 0;
    this.sizes.delete(key);
    return super.delete(key);
  }
  clear() {
    super.clear();
    this.sizes.clear();
    this.bytes = 0;
  }
}
