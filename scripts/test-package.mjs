import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const executable = path.resolve(
  pkg.build.directories.output,
  process.platform === 'darwin' ? 'mac-arm64/SaveHub.app/Contents/MacOS/SaveHub' : 'win-unpacked/SaveHub.exe',
);
await fs.access(executable);
const cli = path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
const child = spawn(process.execPath, [cli, 'test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, SAVEHUB_TEST_EXECUTABLE: executable, SAVEHUB_ARTIFACT_ROOT: 'test-results/package' },
});
child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
