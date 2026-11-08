import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDesktopLaunchAllowed, desktopEnvironment } from '../scripts/desktop-environment.mjs';

for (const username of ['CodexSandboxOffline', 'codexsandboxonline', 'MACHINE\\CodexSandboxOffline']) {
  test(`blocks known Windows sandbox account ${username} before Electron launch`, async () => {
    await assert.rejects(
      assertDesktopLaunchAllowed({
        platform: 'win32',
        inspectIdentity: async () => ({ username, groups: '' }),
      }),
      { code: 'DESKTOP_LAUNCH_REQUIRES_HOST', message: /require_escalated/ },
    );
  });
}

test('detects a sandbox group even when the account has a different name', async () => {
  await assert.rejects(
    assertDesktopLaunchAllowed({
      platform: 'win32',
      inspectIdentity: async () => ({
        username: 'worker',
        groups:
          '"Everyone","Well-known group","S-1-1-0","Enabled"\r\n"PC\\codexsandboxusers","Alias","S-1-5-21-1002","Enabled"\r\n',
      }),
    }),
    { code: 'DESKTOP_LAUNCH_REQUIRES_HOST' },
  );
});

test('allows ordinary Windows users and similarly named unrelated groups', async () => {
  await assertDesktopLaunchAllowed({
    platform: 'win32',
    inspectIdentity: async () => ({
      username: 'Limbo',
      groups:
        '"PC\\CodexSandboxUsersBackup","Alias","S-1-5-21-1005","Enabled"\r\n"BUILTIN\\Users","Alias","S-1-5-32-545","Enabled"',
    }),
  });
});

test('stops with an actionable diagnostic if Windows identity inspection fails', async () => {
  const cause = new Error('whoami unavailable');
  await assert.rejects(
    assertDesktopLaunchAllowed({
      platform: 'win32',
      inspectIdentity: async () => {
        throw cause;
      },
    }),
    { code: 'DESKTOP_ENVIRONMENT_CHECK_FAILED', cause },
  );
});

for (const platform of ['darwin', 'linux']) {
  test(`${platform} does not run Windows identity commands`, async () => {
    await assertDesktopLaunchAllowed({
      platform,
      inspectIdentity: async () => {
        throw new Error('Unexpected Windows command');
      },
    });
  });
}

test('clears inherited Electron Node mode while preserving the caller environment and isolated data path', () => {
  const original = {
    ELECTRON_RUN_AS_NODE: '1',
    SAVEHUB_DATA_DIR: 'isolated-fixture',
    CODEX_SANDBOX_NETWORK_DISABLED: '1',
  };
  const env = desktopEnvironment(original);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.SAVEHUB_DATA_DIR, 'isolated-fixture');
  assert.equal(env.CODEX_SANDBOX_NETWORK_DISABLED, '1');
  assert.equal(original.ELECTRON_RUN_AS_NODE, '1');
});
