import path from 'node:path';
import os from 'node:os';
import templates from '../shared/game-templates.json' with { type: 'json' };

/**
 * 静态解析旧版备份脚本中的字面量路径与条目配置，绝不执行任何 Shell 代码。
 * @param {string} text
 * @param {string} [platform]
 */
export function readLiteralScript(text, platform = process.platform) {
  const variable = (/** @type {string} */ name) =>
    text.match(new RegExp(`^${name}=['"]([^'"\\r\\n]+)['"]\\s*$`, 'm'))?.[1];
  const array = text.match(/^array=\(([^\r\n]*)\)\s*$/m)?.[1];
  const items = [...(array || '').matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
  const convert = (/** @type {string | undefined} */ value) =>
    platform === 'win32' ? value?.replace(/^\/([a-z])\//i, (_, drive) => `${drive.toUpperCase()}:/`) : value;
  return { root: convert(variable('target')), legacyRoot: convert(variable('source')), items };
}

/**
 * @param {string} [platform]
 * @param {string} [home]
 */
export async function makePresets(platform = process.platform, home = os.homedir()) {
  // 只有在 Windows 上才知道 Windows 用户目录；其他系统留空，避免生成 /Users/x/AppData 这类无效路径。
  const windowsHome = (/** @type {string[]} */ ...parts) =>
    platform === 'win32' ? path.win32.join(home, ...parts) : '';
  const specs = templates.map((template) => ({
    ...template,
    root:
      template.id === 'elden-ring'
        ? windowsHome('AppData', 'Roaming', 'EldenRing')
        : template.id === 'dark-souls-2'
          ? windowsHome('AppData', 'Roaming', 'DarkSoulsII')
          : '',
  }));
  return Promise.all(
    specs.map(async (spec) => {
      return {
        id: spec.id,
        name: spec.name,
        subtitle: spec.subtitle,
        icon: spec.icon,
        color: spec.color,
        locations: {
          win32: { root: spec.root, items: spec.items },
          darwin: { root: '', items: spec.icon === 'spire' ? spec.items : [] },
        },
        legacyRoot: '',
        createdAt: new Date().toISOString(),
      };
    }),
  );
}
