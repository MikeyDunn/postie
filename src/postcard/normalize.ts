import type { WebClient } from '@slack/web-api';
import * as nodeEmoji from 'node-emoji';
import { blocksToTokens } from './blocks';
import { getCustomEmojiMap, resolveCustomEmojiUrl } from './emoji';
import { type TextStyle, type Token, tokenize } from './mrkdwn';

/**
 * Renderer-facing segments: everything the tokenizer found, with Slack IDs
 * resolved to human names and emoji resolved to a unicode char or image URL.
 */
export type Segment =
  | { kind: 'text'; text: string; style?: TextStyle }
  | { kind: 'mention'; text: string }
  | { kind: 'link'; text: string; url: string }
  | { kind: 'emoji'; name: string; url?: string; char?: string }
  | { kind: 'codeblock'; text: string }
  | { kind: 'newline' };

export interface NormalizedMessage {
  teamId: string;
  channelId: string;
  channelName: string;
  messageTs: string;
  author: { id?: string; name: string; avatarUrl?: string };
  /**
   * The human a bot posted on behalf of. Slack convention: bots credit the
   * acting user FIRST in their context block — later mentions are usually
   * people named inside the user-supplied prompt the bot echoes back. So the
   * first user mention in a bot-authored message's chrome is who "I" refers
   * to, and the card attributes to them ("via <bot>"). Undefined for human
   * posts or mention-free chrome.
   */
  onBehalfOf?: { id: string; name: string; avatarUrl?: string };
  segments: Segment[];
  plainText: string;
  /**
   * First image on the message — from `files` (needs bot-token auth) or an
   * `image` block (bot posts, e.g. AI image generators; usually public URLs
   * that must NOT receive our bot token).
   */
  image?: { url: string; mimetype: string; title?: string; requiresAuth: boolean };
  postedAt: Date;
  permalink?: string;
}

/** Loose shape of a Slack message as returned by reactions.get / conversations.*. */
export interface SlackMessage {
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string; icons?: { image_72?: string; image_48?: string } };
  text?: string;
  ts: string;
  files?: Array<{ mimetype?: string; url_private?: string; title?: string; name?: string }>;
  blocks?: Array<Record<string, any>>;
  reactions?: Array<{ name: string; count: number; users?: string[] }>;
}

/** Resolves user ids to display names + avatars (for the senders block). */
export async function resolveUserInfos(
  client: WebClient,
  userIds: string[],
): Promise<Array<{ name: string; avatarUrl?: string }>> {
  const cache = new Map<string, { name: string; avatarUrl?: string }>();
  return Promise.all(userIds.map((id) => getUserInfo(client, id, cache)));
}

async function getUserInfo(
  client: WebClient,
  userId: string,
  cache: Map<string, { name: string; avatarUrl?: string }>,
): Promise<{ name: string; avatarUrl?: string }> {
  const cached = cache.get(userId);
  if (cached) return cached;
  let info: { name: string; avatarUrl?: string };
  try {
    const res = await client.users.info({ user: userId });
    const profile = res.user?.profile;
    info = {
      name: profile?.display_name || profile?.real_name || res.user?.name || 'Someone',
      avatarUrl: profile?.image_512 ?? profile?.image_192,
    };
  } catch {
    info = { name: 'Someone' };
  }
  cache.set(userId, info);
  return info;
}

async function getChannelName(client: WebClient, channelId: string): Promise<string> {
  try {
    const res = await client.conversations.info({ channel: channelId });
    return res.channel?.name ?? channelId;
  } catch {
    return channelId;
  }
}

/**
 * Bot messages (subtype bot_message) carry no `user` — resolve the poster
 * through bot_profile → username → bots.info (needs bots:read; degrades
 * gracefully without it).
 */
async function resolveAuthor(
  client: WebClient,
  message: SlackMessage,
  userCache: Map<string, { name: string; avatarUrl?: string }>,
): Promise<NormalizedMessage['author']> {
  if (message.user) {
    return { id: message.user, ...(await getUserInfo(client, message.user, userCache)) };
  }
  const profileName = message.bot_profile?.name ?? message.username;
  if (profileName) {
    return { name: profileName, avatarUrl: message.bot_profile?.icons?.image_72 };
  }
  if (message.bot_id) {
    try {
      const res = await client.bots.info({ bot: message.bot_id });
      const icons = res.bot?.icons as { image_72?: string } | undefined;
      return { name: res.bot?.name ?? 'A bot', avatarUrl: icons?.image_72 };
    } catch {
      return { name: 'A bot' };
    }
  }
  return { name: 'Someone' };
}

function isSlackHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'slack.com' || host.endsWith('.slack.com') || host.endsWith('.slack-edge.com');
  } catch {
    return false;
  }
}

function guessMime(url: string): string {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

function extractImage(message: SlackMessage): NormalizedMessage['image'] {
  const file = (message.files ?? []).find((f) => f.mimetype?.startsWith('image/') && f.url_private);
  if (file) {
    return {
      url: file.url_private!,
      mimetype: file.mimetype!,
      title: file.title,
      requiresAuth: true,
    };
  }
  // Bot posts (AI image generators etc.) attach images as blocks, not files.
  for (const block of message.blocks ?? []) {
    if (block.type !== 'image') continue;
    const slackFileUrl = block.slack_file?.url_private as string | undefined;
    const url = (block.image_url as string | undefined) ?? slackFileUrl;
    if (!url) continue;
    return {
      url,
      mimetype: guessMime(url),
      title: (block.title?.text as string | undefined) ?? undefined,
      requiresAuth: Boolean(slackFileUrl) || isSlackHost(url),
    };
  }
  return undefined;
}

export async function normalizeMessage(
  client: WebClient,
  opts: { teamId: string; channelId: string; message: SlackMessage },
): Promise<NormalizedMessage> {
  const { teamId, channelId, message } = opts;
  const userCache = new Map<string, { name: string; avatarUrl?: string }>();
  const customEmoji = await getCustomEmojiMap(client);

  const author = await resolveAuthor(client, message, userCache);

  // Card text hierarchy: the author's words (content blocks) → the bot's own
  // one-line summary (top-level text) → context-block chrome as last resort.
  const { content, chrome } = blocksToTokens(message.blocks);
  const tokens = content.length ? content : message.text?.trim() ? tokenize(message.text) : chrome;

  let onBehalfOf: NormalizedMessage['onBehalfOf'];
  if (!message.user) {
    // First mention wins: bots credit the acting user before echoing the
    // prompt, so mentions inside the prompt text can't steal attribution.
    const first = chrome.find((t) => t.kind === 'user') as { userId: string } | undefined;
    if (first) {
      onBehalfOf = { id: first.userId, ...(await getUserInfo(client, first.userId, userCache)) };
    }
  }
  const segments: Segment[] = [];
  for (const token of tokens) {
    segments.push(await resolveToken(client, token, customEmoji, userCache));
  }

  let permalink: string | undefined;
  try {
    const res = await client.chat.getPermalink({ channel: channelId, message_ts: message.ts });
    permalink = res.permalink;
  } catch {
    // Non-essential; used only for log/context lines.
  }

  return {
    teamId,
    channelId,
    channelName: await getChannelName(client, channelId),
    messageTs: message.ts,
    author,
    onBehalfOf,
    segments,
    plainText: segmentsToPlainText(segments),
    image: extractImage(message),
    postedAt: new Date(parseFloat(message.ts) * 1000),
    permalink,
  };
}

async function resolveToken(
  client: WebClient,
  token: Token,
  customEmoji: Record<string, string>,
  userCache: Map<string, { name: string; avatarUrl?: string }>,
): Promise<Segment> {
  switch (token.kind) {
    case 'user': {
      const name = token.label ?? (await getUserInfo(client, token.userId, userCache)).name;
      return { kind: 'mention', text: `@${name}` };
    }
    case 'channel': {
      const name = token.label ?? (await getChannelName(client, token.channelId));
      return { kind: 'mention', text: `#${name}` };
    }
    case 'broadcast':
      return { kind: 'mention', text: `@${token.range}` };
    case 'link':
      return { kind: 'link', text: token.label ?? prettyUrl(token.url), url: token.url };
    case 'emoji': {
      const url = resolveCustomEmojiUrl(customEmoji, token.name);
      if (url) return { kind: 'emoji', name: token.name, url };
      // rich_text emoji elements carry the codepoints directly ("1f60a").
      const char = token.unicode ? unicodeToChar(token.unicode) : nodeEmoji.get(token.name);
      if (char) return { kind: 'emoji', name: token.name, char };
      return { kind: 'text', text: `:${token.name}:` };
    }
    default:
      return token;
  }
}

function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function unicodeToChar(unicode: string): string | undefined {
  try {
    return String.fromCodePoint(...unicode.split('-').map((cp) => parseInt(cp, 16)));
  } catch {
    return undefined;
  }
}

export function segmentsToPlainText(segments: Segment[]): string {
  return segments
    .map((s) => {
      switch (s.kind) {
        case 'text':
        case 'mention':
        case 'link':
          return s.text;
        case 'emoji':
          return s.char ?? `:${s.name}:`;
        case 'codeblock':
          return s.text;
        case 'newline':
          return '\n';
        default:
          return '';
      }
    })
    .join('');
}
