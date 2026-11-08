import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 读取真实 Windows 身份，避免把可继承或残留的环境变量当作当前沙箱状态。 */
async function windowsIdentity() {
  const { stdout } = await execFileAsync(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'),
    ['/groups', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 },
  );
  return { username: userInfo().username, groups: stdout };
}

/**
 * 在启动原生进程前拦截本机已知不兼容的 Codex Windows 沙箱账户。
 * Electron 的原生目录访问检查早于应用 JS 执行，不能在 main.mjs 中捕获。
 * 这只是启动兼容性检查，不修改系统权限，也不代替 Electron 自身的沙箱。
 *
 * @param {{ platform?: string; inspectIdentity?: () => Promise<{ username: string; groups: string }> }} [options]
 */
export async function assertDesktopLaunchAllowed({
  platform = process.platform,
  inspectIdentity = windowsIdentity,
} = {}) {
  if (platform !== 'win32') return;
  let identity;
  try {
    identity = await inspectIdentity();
  } catch (cause) {
    throw Object.assign(
      new Error('无法检查 Windows 桌面启动身份，Electron 尚未启动。请在正常桌面终端重试。', { cause }),
      { code: 'DESKTOP_ENVIRONMENT_CHECK_FAILED' },
    );
  }
  const sandboxAccount = /^(?:.*\\)?codexsandbox(?:offline|online)$/i.test(identity.username);
  const sandboxGroup = /^"[^"\r\n]*\\CodexSandboxUsers",/im.test(identity.groups);
  if (sandboxAccount || sandboxGroup) {
    throw Object.assign(
      new Error(
        '检测到 Codex Windows 沙箱账户，已在创建 Electron 进程前停止启动，以避免 0x80000003 / install_dir_access 崩溃弹窗。\n' +
          '请通过 Codex 的沙箱外执行权限（sandbox_permissions: require_escalated）重跑当前命令，或在正常桌面终端运行。\n' +
          '无需管理员权限；不要使用 --no-sandbox、关闭 Electron sandbox 或批量修改目录 ACL。',
      ),
      { code: 'DESKTOP_LAUNCH_REQUIRES_HOST' },
    );
  }
}

/** 清除宿主工具遗留的 Node 模式标记，不修改调用方的进程环境。 */
export function desktopEnvironment(/** @type {NodeJS.ProcessEnv} */ values = process.env) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  return env;
}
