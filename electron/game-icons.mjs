import { createHash } from 'node:crypto';

const MAX_ICON_CACHE = 64;
/** @type {Map<string, { hash: string; mime: string | null; buffer: Buffer | null }>} */
const iconCache = new Map();

/** @param {string} dataUrl */
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

/** Persisted data URLs remain portable; state sends only a stable, independently fetched resource URL.
 * @param {{id:string; icon:string}} game
 */
export function publicIcon(game) {
  return game.icon.startsWith('data:image/')
    ? `savehub-icon://game/${game.id}?v=${parseAndHashIcon(game.icon).hash}`
    : game.icon;
}

/** @param {import('./storage.mjs').SaveStore} store @param {string} url */
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
