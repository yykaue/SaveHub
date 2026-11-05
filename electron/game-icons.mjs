import { createHash } from 'node:crypto';

/** Persisted data URLs remain portable; state sends only a stable, independently fetched resource URL.
 * @param {{id:string; icon:string}} game
 */
export function publicIcon(game) {
  return game.icon.startsWith('data:image/')
    ? `savehub-icon://game/${game.id}?v=${createHash('sha256').update(game.icon).digest('hex')}`
    : game.icon;
}

/** @param {import('./storage.mjs').SaveStore} store @param {string} url */
export function iconResponse(store, url) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'game' || !/^\/[a-zA-Z0-9-]+$/.test(parsed.pathname))
    return new Response(null, { status: 404 });
  const game = store.config.games.find((game) => game.id === parsed.pathname.slice(1));
  if (!game || publicIcon(game) !== url) return new Response(null, { status: 404 });
  const match = game.icon.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return new Response(null, { status: 404 });
  return new Response(Buffer.from(match[2], 'base64'), {
    headers: { 'Content-Type': match[1], 'Cache-Control': 'private, max-age=31536000, immutable' },
  });
}
