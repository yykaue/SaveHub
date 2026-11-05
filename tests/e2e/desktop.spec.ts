import { test } from '@playwright/test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
const suites = [
  'smoke',
  'interactions',
  'deletion-interactions',
  'import-interactions',
  'game-interactions',
  'retention-interactions',
  'optimization-interactions',
];
for (const suite of suites)
  test(suite, async ({ browserName: _browserName }, info) => {
    const artifacts = info.outputPath('artifacts');
    let output = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [`scripts/${suite}.mjs`], {
          windowsHide: true,
          env: { ...process.env, SAVEHUB_ARTIFACT_ROOT: artifacts },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (data) => {
          output += data;
          process.stdout.write(data);
        });
        child.stderr.on('data', (data) => {
          output += data;
          process.stderr.write(data);
        });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${suite} exited ${code}`))));
      });
    } finally {
      await info.attach('process-log', { body: output, contentType: 'text/plain' });
      for (const directory of await fs.readdir(artifacts).catch(() => []))
        for (const filename of await fs.readdir(path.join(artifacts, directory))) {
          if (filename === 'run.json' || filename.endsWith('.zip') || filename.startsWith('failure-'))
            await info.attach(`${directory}/${filename}`, { path: path.join(artifacts, directory, filename) });
        }
    }
  });
