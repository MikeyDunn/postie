import type { WebClient } from '@slack/web-api';

let cache: { map: Record<string, string>; fetchedAt: number } | undefined;
const CACHE_MS = 5 * 60 * 1000;

/** Workspace custom emoji: name → image URL (or "alias:other-name"). */
export async function getCustomEmojiMap(client: WebClient): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.map;
  try {
    const res = await client.emoji.list();
    cache = { map: (res.emoji as Record<string, string>) ?? {}, fetchedAt: Date.now() };
  } catch (err) {
    console.warn('[postie] emoji.list failed, custom emoji will render as text:', err);
    cache = { map: {}, fetchedAt: Date.now() };
  }
  return cache.map;
}

/** Resolves alias chains ("alias:foo") to a final image URL, if any. */
export function resolveCustomEmojiUrl(
  map: Record<string, string>,
  name: string,
): string | undefined {
  let current = map[name];
  for (let hops = 0; current && hops < 5; hops++) {
    if (!current.startsWith('alias:')) return current;
    current = map[current.slice('alias:'.length)];
  }
  return undefined;
}

/** Strips skin-tone suffixes: "thumbsup::skin-tone-3" → "thumbsup". */
export function baseEmojiName(reaction: string): string {
  return reaction.split('::')[0];
}
