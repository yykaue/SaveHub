import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';

// Read the small, literal subset used by the reference scripts. Never execute shell code.
export function readLiteralScript(text, platform = process.platform) {
  const variable = name => text.match(new RegExp(`^${name}=['"]([^'"\\r\\n]+)['"]\\s*$`, 'm'))?.[1];
  const array = text.match(/^array=\(([^\r\n]*)\)\s*$/m)?.[1];
  const items = [...(array || '').matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
  const convert = value => platform === 'win32' ? value?.replace(/^\/([a-z])\//i, (_, drive) => `${drive.toUpperCase()}:/`) : value;
  return { root: convert(variable('target')), legacyRoot: convert(variable('source')), items };
}

export async function makePresets(platform = process.platform, home = os.homedir()) {
  const specs = [
    { id: 'elden-ring', name: '艾尔登法环', subtitle: 'ELDEN RING', icon: 'ring', color: '#8a9270', folder: 'EldenRing', root: path.join(home, 'AppData', 'Roaming', 'EldenRing'), items: ['76561198132913813'] },
    { id: 'slay-the-spire', name: '杀戮尖塔', subtitle: 'SLAY THE SPIRE', icon: 'spire', color: '#729486', folder: 'SlayTheSpire', root: 'D:\\Steam\\steamapps\\common\\SlayTheSpire', items: ['betaPreferences', 'preferences', 'saves'] },
    { id: 'dark-souls-2', name: '黑暗之魂 II', subtitle: 'DARK SOULS II', icon: 'flame', color: '#a28167', folder: 'DarkSouls2', root: path.join(home, 'AppData', 'Roaming', 'DarkSoulsII'), items: ['011000010a4a6695'] },
  ];
  return Promise.all(specs.map(async spec => {
    const legacyRoot = path.join(home, 'Desktop', spec.folder);
    let values = { root: spec.root, legacyRoot, items: spec.items };
    if (platform === 'win32') {
      try {
        const parsed = readLiteralScript(await readFile(path.join(legacyRoot, 'save.sh'), 'utf8'), platform);
        if (parsed.root && parsed.items.length) values = { ...values, ...parsed };
      } catch { /* A missing script does not prevent manual setup. */ }
    }
    return {
      id: spec.id, name: spec.name, subtitle: spec.subtitle, icon: spec.icon, color: spec.color,
      locations: { win32: { root: values.root, items: values.items }, darwin: { root: '', items: spec.icon === 'spire' ? spec.items : [] } },
      legacyRoot: platform === 'win32' ? values.legacyRoot : '', createdAt: new Date().toISOString(),
    };
  }));
}
