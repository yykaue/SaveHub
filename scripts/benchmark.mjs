import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { SaveStore, atomicJson } from '../electron/storage.mjs';

const root = path.resolve('.test-data');
await fsp.mkdir(root, { recursive: true });
const base = await fsp.mkdtemp(path.join(root, 'benchmark-'));
const source = path.join(base, 'live');
await fsp.mkdir(source);
await fsp.writeFile(path.join(source, 'save.dat'), 'benchmark');
const store = await new SaveStore(path.join(base, 'data')).init();
const id = await store.upsertGame({
  name: 'Benchmark',
  locations: { win32: { root: source, items: ['save.dat'] }, darwin: { root: source, items: ['save.dat'] } },
});
const seed = await store.capture(store.game(id), source, ['save.dat'], { label: 'seed' });
const percentiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  };
};
const summary = [];
let made = 1;
for (const count of [100, 1000, 10000]) {
  while (made < count) {
    const snapshotId = randomUUID();
    await atomicJson(path.join(store.snapshotDir(id, snapshotId), 'manifest.json'), {
      ...seed,
      id: snapshotId,
      label: `record-${made++}`,
    });
  }
  store.invalidateGameCache(id);
  const coldStart = performance.now();
  const state = await store.state();
  const coldMs = performance.now() - coldStart;
  const warm = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    await store.state();
    warm.push(performance.now() - start);
  }
  summary.push({
    count,
    coldApplicationCacheMs: coldMs,
    warmApplicationCacheMs: percentiles(warm),
    ipcBytes: Buffer.byteLength(JSON.stringify(state)),
    cacheBytes: store.manifestCache.bytes,
    rss: process.memoryUsage().rss,
  });
}
// Count bytes delivered by real read streams and bytes passed to FileHandle writes.
let reading = 0,
  writing = 0,
  peak = 0;
const stream = fs.createReadStream,
  open = fsp.open;
fs.createReadStream = function (...args) {
  const result = stream.apply(this, args);
  result.on('data', (chunk) => (reading += chunk.length));
  return result;
};
fsp.open = async function (...args) {
  const handle = await open.apply(this, args);
  const readStream = handle.createReadStream,
    write = handle.writeFile;
  handle.createReadStream = function (...args) {
    const result = readStream.apply(this, args);
    result.on('data', (chunk) => (reading += chunk.length));
    return result;
  };
  handle.writeFile = async function (data, ...args) {
    writing += Buffer.byteLength(data);
    return write.call(this, data, ...args);
  };
  return handle;
};
syncBuiltinESMExports();
const captures = [];
try {
  for (const [scenario, files, bytes] of [
    ['large-file', 1, 32 * 1024 * 1024],
    ['small-files', 1000, 4096],
  ]) {
    const live = path.join(base, scenario);
    await fsp.mkdir(path.join(live, 'saves'), { recursive: true });
    for (let i = 0; i < files; i++) await fsp.writeFile(path.join(live, 'saves', `${i}.dat`), Buffer.alloc(bytes, 65));
    const entries = ['saves'];
    const gameId = await store.upsertGame({
      name: scenario,
      locations: { win32: { root: live, items: entries }, darwin: { root: live, items: entries } },
    });
    const runs = [];
    for (let i = 0; i < 5; i++) {
      reading = 0;
      writing = 0;
      peak = process.memoryUsage().rss;
      const monitor = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
      const start = performance.now();
      try {
        await store.createSnapshot(gameId, { label: `run-${i}` });
      } finally {
        clearInterval(monitor);
      }
      runs.push({ ms: performance.now() - start, readBytes: reading, writtenBytes: writing, peakRss: peak });
    }
    captures.push({
      scenario,
      files,
      payloadBytes: files * bytes,
      timing: percentiles(runs.map((run) => run.ms)),
      runs,
    });
  }
} finally {
  fs.createReadStream = stream;
  fsp.open = open;
  syncBuiltinESMExports();
}
const result = {
  date: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  fixture: base,
  notes: [
    'State fixtures contain valid manifests; only the seed has payload. State does not read payload.',
    'Cold/warm describe application summary cache, not an OS disk-cache flush.',
    'Capture fixtures contain real payload; all five runs preserve full source-after and destination hash verification.',
    'Read counters measure bytes delivered to JavaScript, not physical disk traffic.',
  ],
  summary,
  captures,
};
await fsp.mkdir('test-results', { recursive: true });
await atomicJson('test-results/benchmark.json', result);
console.log(JSON.stringify(result, null, 2));
