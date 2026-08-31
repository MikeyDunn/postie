import type { NormalizedMessage } from '../src/postcard/normalize';
import type { BackExtras } from '../src/postcard/render';

/**
 * Shared card fixtures: the representative message shapes rendered by both
 * the unit tests and the design gallery (npm run gallery).
 */
export function msg(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    teamId: 'T1',
    channelId: 'C1',
    channelName: 'general',
    messageTs: '1752345600.000100',
    author: { id: 'U1', name: 'Sam Rivera' },
    segments: [],
    plainText: '',
    postedAt: new Date('2026-07-12T18:00:00Z'),
    permalink: 'https://example.slack.com/archives/C1/p1752345600000100',
    ...overrides,
  };
}

export function text(t: string): NormalizedMessage['segments'] {
  return [{ kind: 'text', text: t }];
}

export const SENDERS = [
  { name: 'Sam Rivera' },
  { name: 'Alex Kim' },
  { name: 'Jordan Fox' },
  { name: 'Casey Lee' },
  { name: 'Robin Diaz' },
];

export interface Fixture {
  name: string;
  message: NormalizedMessage;
  /** picsum URL for photo cards; undefined = text card */
  photo?: string;
  back?: Partial<BackExtras>;
}

export const FIXTURES: Fixture[] = [
  {
    name: 'text-short',
    message: msg({
      segments: text('We got the keys!!'),
      plainText: 'We got the keys!!',
    }),
  },
  {
    name: 'text-long',
    message: msg({
      segments: text(
        'Quarterly retro takeaway: the thing that saved us was not the heroics in March, it was the boring decision in January to write everything down. Documentation is a love letter to your future self, and this team writes great ones. Proud of every single person here.',
      ),
      plainText:
        'Quarterly retro takeaway: the thing that saved us was not the heroics in March, it was the boring decision in January to write everything down. Documentation is a love letter to your future self, and this team writes great ones. Proud of every single person here.',
    }),
  },
  {
    name: 'text-styled',
    message: msg({
      segments: [
        { kind: 'text', text: 'shipped ' },
        { kind: 'text', text: 'v2.0', style: 'bold' },
        { kind: 'text', text: ' today 🎉 huge thanks to ' },
        { kind: 'mention', text: '@alex' },
        { kind: 'text', text: ' — see ' },
        { kind: 'link', text: 'the changelog', url: 'https://example.com' },
      ],
      plainText: 'shipped v2.0 today 🎉 huge thanks to @alex — see the changelog',
    }),
  },
  {
    name: 'text-emoji-heavy',
    message: msg({
      segments: text('🍕🍕🍕 FRIDAY 🍕🍕🍕 first tomato of the season 🍅 who wants some??'),
      plainText: '🍕🍕🍕 FRIDAY 🍕🍕🍕 first tomato of the season 🍅 who wants some??',
    }),
  },
  {
    name: 'text-code',
    message: msg({
      segments: [
        { kind: 'text', text: 'after 3 hours the fix was ' },
        { kind: 'text', text: 'one character', style: 'bold' },
        { kind: 'text', text: ': ' },
        { kind: 'codeblock', text: '- if (retries > MAX)\n+ if (retries >= MAX)' },
      ],
      plainText:
        'after 3 hours the fix was one character: - if (retries > MAX) + if (retries >= MAX)',
    }),
  },
  {
    name: 'photo-wide',
    photo: 'https://picsum.photos/seed/postie-wide/1600/900',
    message: msg({
      channelName: 'family-photos',
      segments: text('sunset from the back porch tonight, no filter'),
      plainText: 'sunset from the back porch tonight, no filter',
    }),
  },
  {
    name: 'photo-square',
    photo: 'https://picsum.photos/seed/postie7/1024/1024',
    message: msg({
      channelName: 'family-photos',
      segments: text('she made this entire fort herself and demanded a photoshoot'),
      plainText: 'she made this entire fort herself and demanded a photoshoot',
    }),
  },
  {
    name: 'photo-portrait',
    photo: 'https://picsum.photos/seed/postie-tall/800/1200',
    message: msg({
      segments: text('caught the exact moment'),
      plainText: 'caught the exact moment',
    }),
  },
  {
    name: 'bot-onbehalf',
    photo: 'https://picsum.photos/seed/postie-bot/1024/1024',
    message: msg({
      channelName: 'gen-art',
      author: { name: 'clank' },
      onBehalfOf: { id: 'U9', name: 'samiswoi bart' },
      // What the normalizer now yields for an AI image post: the human's
      // prompt mined from the chrome's bold run, wrapper and metadata gone.
      segments: text('suddenly i dancing severance style with the furry orcas'),
      plainText: 'suddenly i dancing severance style with the furry orcas',
    }),
    back: { senders: [{ name: 'samiswoi bart' }] },
  },
  {
    name: 'single-sender-is-author',
    message: msg({
      segments: text('note to self: this actually worked'),
      plainText: 'note to self: this actually worked',
    }),
    back: { senders: [{ name: 'Sam Rivera' }] },
  },
];
