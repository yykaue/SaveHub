import { createHash } from 'node:crypto';

const MAX_ICON_CACHE = 64;
/** @type {Map<string, { hash: string; mime: string | null; buffer: Buffer<ArrayBuffer> | null }>} */
const iconCache = new Map();

/**
 * 解析并缓存自定义图标的 SHA-256 摘要与二进制载荷（LRU 上限 64 条），
 * 避免每次构建 state() 或响应协议请求时对最大 3MB 的 Base64 Data URL 重复计算哈希与解码。
 * @param {string} dataUrl
 */
function parseAndHashIcon(dataUrl) {
  const cached = iconCache.get(dataUrl);
  if (cached) {
    iconCache.delete(dataUrl);
    iconCache.set(dataUrl, cached);
    return cached;
  }
  const hash = createHash('sha256').update(dataUrl).digest('hex');
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  const entry = {
    hash,
    mime: match ? match[1] : null,
    buffer: match ? Buffer.from(match[2], 'base64') : null,
  };
  if (iconCache.size >= MAX_ICON_CACHE) {
    const oldest = iconCache.keys().next().value;
    if (oldest !== undefined) iconCache.delete(oldest);
  }
  iconCache.set(dataUrl, entry);
  return entry;
}

/**
 * 配置文件中仍持久化完整的 Data URL 以保证跨设备导出的便携性；
 * 下发给前端的 state() 仅传递带内容哈希版本号的轻量协议 URL，由渲染进程按需独立拉取并长期缓存。
 * @param {{id:string; icon:string}} game
 */
export function publicIcon(game) {
  return game.icon.startsWith('data:image/')
    ? `savehub-icon://game/${game.id}?v=${parseAndHashIcon(game.icon).hash}`
    : game.icon;
}

/** 处理 savehub-icon:// 自定义协议请求，校验游戏身份与版本哈希匹配后返回解码后的图片字节流 @param {import('./storage.mjs').SaveStore} store @param {string} url */
export function iconResponse(store, url) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'game' || !/^\/[a-zA-Z0-9-]+$/.test(parsed.pathname))
    return new Response(null, { status: 404 });
  const game = store.config.games.find((game) => game.id === parsed.pathname.slice(1));
  if (!game || publicIcon(game) !== url) return new Response(null, { status: 404 });
  const entry = parseAndHashIcon(game.icon);
  if (!entry.mime || !entry.buffer) return new Response(null, { status: 404 });
  return new Response(entry.buffer, {
    headers: { 'Content-Type': entry.mime, 'Cache-Control': 'private, max-age=31536000, immutable' },
  });
}
