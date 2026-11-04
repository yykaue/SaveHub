import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';

/**
 * Read the small, literal subset used by the reference scripts. Never execute shell code.
 * @param {string} text
 * @param {string} [platform]
 */
export function readLiteralScript(text, platform = process.platform) {
  const variable = (/** @type {string} */ name) => text.match(new RegExp(`^${name}=['"]([^'"\\r\\n]+)['"]\\s*$`, 'm'))?.[1];
  const array = text.match(/^array=\(([^\r\n]*)\)\s*$/m)?.[1];
  const items = [...(array || '').matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
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
  const windowsHome = (/** @type {string[]} */ ...parts) => (platform === 'win32' ? path.win32.join(home, ...parts) : '');
  const specs = [
    {
      id: 'elden-ring',
      name: '艾尔登法环',
      subtitle: 'ELDEN RING',
      icon: 'ring',
      color: '#8a9270',
      folder: 'EldenRing',
      root: windowsHome('AppData', 'Roaming', 'EldenRing'),
      items: /** @type {string[]} */ ([]),
    },
    {
      id: 'slay-the-spire',
      name: '杀戮尖塔',
      subtitle: 'SLAY THE SPIRE',
      icon: 'spire',
      color: '#729486',
      folder: 'SlayTheSpire',
      root: platform === 'win32' ? 'D:\\Steam\\steamapps\\common\\SlayTheSpire' : '',
      items: ['betaPreferences', 'preferences', 'saves'],
    },
    {
      id: 'dark-souls-2',
      name: '黑暗之魂 II',
      subtitle: 'DARK SOULS II',
      icon: 'flame',
      color: '#a28167',
      folder: 'DarkSouls2',
      root: windowsHome('AppData', 'Roaming', 'DarkSoulsII'),
      items: /** @type {string[]} */ ([]),
    },
  ];
  return Promise.all(
    specs.map(async spec => {
      const legacyRoot = path.join(home, 'Desktop', spec.folder);
      /** @type {{ root: string | undefined; legacyRoot: string | undefined; items: string[] }} */
      let values = { root: spec.root, legacyRoot, items: spec.items };
      if (platform === 'win32') {
        try {
          const parsed = readLiteralScript(await readFile(path.join(legacyRoot, 'save.sh'), 'utf8'), platform);
          if (parsed.root && parsed.items.length) values = { ...values, ...parsed };
        } catch {
          /* A missing script does not prevent manual setup. */
        }
      }
      return {
        id: spec.id,
        name: spec.name,
        subtitle: spec.subtitle,
        icon: spec.icon,
        color: spec.color,
        locations: {
          win32: { root: values.root || '', items: values.items },
          darwin: { root: '', items: spec.icon === 'spire' ? spec.items : [] },
        },
        legacyRoot: platform === 'win32' ? values.legacyRoot || '' : '',
        createdAt: new Date().toISOString(),
      };
    }),
  );
}
