import { describe, expect, it } from 'vitest';
import { normalizeMessage, type SlackMessage } from '../src/postcard/normalize';

/**
 * Fake WebClient covering the calls normalizeMessage makes — no network.
 */
const fakeClient = {
  emoji: { list: async () => ({ ok: true, emoji: {} }) },
  conversations: { info: async () => ({ ok: true, channel: { name: 'gen-art' } }) },
  chat: { getPermalink: async () => ({ ok: true, permalink: 'https://x.slack.com/p1' }) },
  users: { info: async () => ({ ok: true, user: { profile: { display_name: 'mike' } } }) },
  bots: { info: async () => ({ ok: true, bot: { name: 'Clank', icons: {} } }) },
} as never;

/** Real shape captured from an AI image-generator bot post (2026-07-13). */
const BOT_IMAGE_MESSAGE: SlackMessage = {
  ts: '1783992999.844899',
  text: '✨ Generated image for: "cat in space"',
  bot_id: 'B0A69CHT46T',
  blocks: [
    {
      type: 'image',
      block_id: 'fWJ1z',
      image_url: 'https://example-bucket.s3.us-east-1.amazonaws.com/cat.png',
      alt_text: 'A very long internal monologue that should never appear on a postcard…',
      image_width: 1024,
      image_height: 1024,
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '<@U151PTHK9> | *cat in space* | GPT-5 Image Mini' }],
    },
  ],
};

describe('normalizeMessage with a bot image post', () => {
  it('finds the image in blocks and marks it public (no bot token on fetch)', async () => {
    const n = await normalizeMessage(fakeClient, {
      teamId: 'T1',
      channelId: 'C1',
      message: BOT_IMAGE_MESSAGE,
    });
    expect(n.image?.url).toContain('example-bucket');
    expect(n.image?.requiresAuth).toBe(false);
    expect(n.image?.mimetype).toBe('image/png');
  });

  it('prefers the bot summary over context-block chrome when there are no content blocks', async () => {
    const n = await normalizeMessage(fakeClient, {
      teamId: 'T1',
      channelId: 'C1',
      message: BOT_IMAGE_MESSAGE,
    });
    // context blocks are metadata ("model | runtime | cost") — a postcard
    // prints the author's summary line instead.
    expect(n.plainText).toBe('✨ Generated image for: "cat in space"');
    expect(n.plainText).not.toContain('GPT-5 Image Mini');
    expect(n.plainText).not.toContain('internal monologue');
  });

  it('uses context chrome only when it is the only text anywhere', async () => {
    const n = await normalizeMessage(fakeClient, {
      teamId: 'T1',
      channelId: 'C1',
      message: {
        ...BOT_IMAGE_MESSAGE,
        text: '',
      },
    });
    expect(n.plainText).toBe('@mike | cat in space | GPT-5 Image Mini');
  });

  it('lets content blocks beat the fallback summary', async () => {
    const n = await normalizeMessage(fakeClient, {
      teamId: 'T1',
      channelId: 'C1',
      message: {
        ...BOT_IMAGE_MESSAGE,
        blocks: [
          ...(BOT_IMAGE_MESSAGE.blocks ?? []),
          { type: 'section', text: { type: 'mrkdwn', text: 'A fat orange tabby, *at last*.' } },
        ],
      },
    });
    expect(n.plainText).toBe('A fat orange tabby, at last.');
  });

  it('falls back to the text field when a message has no blocks', async () => {
    const n = await normalizeMessage(fakeClient, {
      teamId: 'T1',
      channelId: 'C1',
      message: { ts: '1.2', text: 'plain *bold* message' },
    });
    expect(n.plainText).toBe('plain bold message');
    expect(n.segments).toContainEqual({ kind: 'text', text: 'bold', style: 'bold' });
  });

  it('resolves the author via bots.info when no user/profile is present', async () => {
    const n = await normalizeMessage(fakeClient, {
      teamId: 'T1',
      channelId: 'C1',
      message: BOT_IMAGE_MESSAGE,
    });
    expect(n.author.name).toBe('Clank');
  });

  it('attributes bot posts to the single human mentioned in the context block', async () => {
    const n = await normalizeMessage(fakeClient, {
      teamId: 'T1',
      channelId: 'C1',
      message: BOT_IMAGE_MESSAGE,
    });
    expect(n.onBehalfOf?.id).toBe('U151PTHK9');
    expect(n.onBehalfOf?.name).toBe('mike');
  });

  it('leaves onBehalfOf unset for human posts and ambiguous chrome', async () => {
    const human = await normalizeMessage(fakeClient, {
      teamId: 'T1',
      channelId: 'C1',
      message: { ts: '1.1', user: 'U7', text: 'hello' },
    });
    expect(human.onBehalfOf).toBeUndefined();

    const twoMentions = await normalizeMessage(fakeClient, {
      teamId: 'T1',
      channelId: 'C1',
      message: {
        ...BOT_IMAGE_MESSAGE,
        blocks: [
          ...(BOT_IMAGE_MESSAGE.blocks ?? []).slice(0, 1),
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: '<@U1> and <@U2> collaborated' }],
          },
        ],
      },
    });
    expect(twoMentions.onBehalfOf).toBeUndefined();
  });

  it('prefers bot_profile over the bots.info call', async () => {
    const n = await normalizeMessage(fakeClient, {
      teamId: 'T1',
      channelId: 'C1',
      message: { ...BOT_IMAGE_MESSAGE, bot_profile: { name: 'Clank (profile)' } },
    });
    expect(n.author.name).toBe('Clank (profile)');
  });

  it('parses human rich_text blocks with styles, emoji, links, and lists', async () => {
    const n = await normalizeMessage(fakeClient, {
      teamId: 'T1',
      channelId: 'C1',
      message: {
        ts: '2.3',
        text: 'fallback that should be ignored',
        user: 'U9',
        blocks: [
          {
            type: 'rich_text',
            elements: [
              {
                type: 'rich_text_section',
                elements: [
                  { type: 'text', text: 'shipped ' },
                  { type: 'text', text: 'v2', style: { bold: true } },
                  { type: 'text', text: ' today ' },
                  { type: 'emoji', name: 'rocket', unicode: '1f680' },
                  { type: 'text', text: ' see ' },
                  { type: 'link', url: 'https://example.com/notes', text: 'the notes' },
                ],
              },
              {
                type: 'rich_text_list',
                style: 'bullet',
                elements: [
                  { type: 'rich_text_section', elements: [{ type: 'text', text: 'faster' }] },
                  { type: 'rich_text_section', elements: [{ type: 'text', text: 'prettier' }] },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(n.plainText).toBe('shipped v2 today 🚀 see the notes\n• faster\n• prettier');
    expect(n.segments).toContainEqual({ kind: 'text', text: 'v2', style: 'bold' });
    expect(n.segments).toContainEqual({ kind: 'emoji', name: 'rocket', char: '🚀' });
  });

  it('handles the human image+caption shape: rich_text caption, files image, no chrome', async () => {
    const n = await normalizeMessage(fakeClient, {
      teamId: 'T1',
      channelId: 'C1',
      message: {
        ts: '3.4',
        user: 'U7',
        text: 'first tomato of the season!',
        blocks: [
          {
            type: 'rich_text',
            elements: [
              {
                type: 'rich_text_section',
                elements: [{ type: 'text', text: 'first tomato of the season!' }],
              },
            ],
          },
        ],
        files: [{ mimetype: 'image/jpeg', url_private: 'https://files.slack.com/tomato.jpg' }],
      },
    });
    expect(n.plainText).toBe('first tomato of the season!');
    expect(n.image?.requiresAuth).toBe(true);
  });

  it('still prefers files over blocks and requires auth for them', async () => {
    const n = await normalizeMessage(fakeClient, {
      teamId: 'T1',
      channelId: 'C1',
      message: {
        ...BOT_IMAGE_MESSAGE,
        files: [{ mimetype: 'image/jpeg', url_private: 'https://files.slack.com/f.jpg' }],
      },
    });
    expect(n.image?.url).toBe('https://files.slack.com/f.jpg');
    expect(n.image?.requiresAuth).toBe(true);
  });
});
