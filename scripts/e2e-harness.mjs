import { _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** @param {string} suite @param {(harness: Awaited<ReturnType<typeof createHarness>>) => Promise<void>} action */
export async function runE2E(suite, action) {
  const harness = await createHarness(suite);
  let failure;
  try {
    await action(harness);
  } catch (error) {
    failure = error;
  }
  try {
    await harness.finish(failure);
  } catch (cleanupError) {
    if (!failure) throw cleanupError;
    console.error('Secondary evidence/cleanup failure:', cleanupError);
  }
  if (failure) throw failure;
}

/** @param {string} suite */
export async function createHarness(suite) {
  const root = path.resolve('.test-data');
  await fs.mkdir(root, { recursive: true });
  const base = await fs.mkdtemp(path.join(root, `${suite}-`));
  const artifactRoot = path.resolve(process.env.SAVEHUB_ARTIFACT_ROOT || 'test-results/e2e');
  const screenshots = path.join(artifactRoot, path.basename(base));
  await fs.mkdir(screenshots, { recursive: true });
  const executable = path.resolve(process.env.SAVEHUB_TEST_EXECUTABLE || String(electronPath));
  /** @type {string[]} */ const errors = [];
  /** @type {string[]} */ const checks = [];
  /** @type {string[]} */ const cleanupErrors = [];
  /** @type {Set<import('@playwright/test').ElectronApplication>} */ const applications = new Set();
  /** @type {Record<string,unknown>[]} */ const targets = [];
  const done = (/** @type {string} */ message) => {
    checks.push(message);
    console.log(`PASS ${message}`);
  };
  async function close(/** @type {import('@playwright/test').ElectronApplication} */ application) {
    if (!applications.has(application)) return;
    await application
      .context()
      .tracing.stop({ path: path.join(screenshots, `trace-${targets.length}.zip`) })
      .catch((error) => cleanupErrors.push(`trace: ${error.message}`));
    const child = application.process();
    try {
      await Promise.race([
        application.close(),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Electron close timed out')), 10000);
          timer.unref();
        }),
      ]);
    } catch (error) {
      cleanupErrors.push(`close: ${String(error)}`);
      if (child.exitCode === null && child.pid) {
        if (process.platform === 'win32')
          await new Promise((resolve) => {
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
            killer.once('exit', resolve);
            killer.once('error', resolve);
          });
        else child.kill('SIGKILL');
      }
    }
    applications.delete(application);
  }
  return {
    root,
    base,
    screenshots,
    errors,
    checks,
    done,
    close,
    async launch(/** @type {string} */ dataDir) {
      await fs.access(executable); // An invalid requested package must never fall back to source.
      /** @type {Record<string,string>} */
      const env = { SAVEHUB_DATA_DIR: dataDir };
      for (const [key, value] of Object.entries(process.env))
        if (value !== undefined && key !== 'SAVEHUB_DATA_DIR') env[key] = value;
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.SAVEHUB_DEV_URL;
      const application = await electron.launch({
        executablePath: executable,
        args: process.env.SAVEHUB_TEST_EXECUTABLE ? [] : ['.'],
        env,
        timeout: 45000,
      });
      applications.add(application);
      await application.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
      const page = await application.firstWindow();
      page.on('pageerror', (error) => errors.push(error.message));
      targets.push(
        await application.evaluate(({ app }) => ({
          version: app.getVersion(),
          packaged: app.isPackaged,
          appPath: app.getAppPath(),
          platform: process.platform,
          arch: process.arch,
        })),
      );
      return application;
    },
    async finish(/** @type {unknown} */ failure) {
      for (const application of applications) {
        if (failure)
          for (const [i, page] of application.windows().entries())
            await page.screenshot({ path: path.join(screenshots, `failure-${i}.png`) }).catch(() => {});
        await close(application);
      }
      if (!failure && !cleanupErrors.length && !process.env.SAVEHUB_KEEP_TEST_DATA) {
        const relative = path.relative(root, path.resolve(base));
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
          cleanupErrors.push('Fixture cleanup escaped test root');
        else
          await fs
            .rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
            .catch((error) => cleanupErrors.push(`fixture retained: ${error.message}`));
      }
      const report = {
        suite,
        success: !failure && !errors.length && !cleanupErrors.length,
        date: new Date().toISOString(),
        executable,
        targets,
        fixture: base,
        checks,
        rendererErrors: errors,
        error: failure instanceof Error ? { message: failure.message, stack: failure.stack } : failure,
        cleanupErrors,
      };
      await fs.writeFile(path.join(screenshots, 'run.json'), JSON.stringify(report, null, 2));
      console.log(`E2E_REPORT=${path.join(screenshots, 'run.json')}`);
      if (!failure && (errors.length || cleanupErrors.length))
        throw new Error([...errors, ...cleanupErrors].join('\n'));
    },
  };
}

/** @param {import('@playwright/test').ElectronApplication} application @param {string|null} directory */
export async function mockDirectory(application, directory) {
  await application.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: !folder, filePaths: folder ? [folder] : [] });
  }, directory);
}
