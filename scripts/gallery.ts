/**
 * Design gallery: renders every representative message shape front + back
 * into test/__output__/gallery/ with an index.html contact sheet, so layout
 * changes can be judged across all cases at once.
 *
 *   npm run gallery      (then it opens in the browser)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as QRCode from 'qrcode';
import { NormalizedMessage } from '../src/postcard/normalize';
import { renderBack, renderPhotoFront, renderTextCardFront, BackExtras } from '../src/postcard/render';

const OUT = path.join(__dirname, '..', 'test', '__output__', 'gallery');

function msg(overrides: Partial<NormalizedMessage>): NormalizedMessage {
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

function text(t: string): NormalizedMessage['segments'] {
  return [{ kind: 'text', text: t }];
}

const SENDERS = [
  { name: 'Sam Rivera' },
  { name: 'Alex Kim' },
  { name: 'Jordan Fox' },
  { name: 'Casey Lee' },
  { name: 'Robin Diaz' },
];

interface Fixture {
  name: string;
  message: NormalizedMessage;
  /** picsum URL for photo cards; undefined = text card */
  photo?: string;
  back?: Partial<BackExtras>;
}

const FIXTURES: Fixture[] = [
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
      plainText: 'after 3 hours the fix was one character: - if (retries > MAX) + if (retries >= MAX)',
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
      segments: text('✨ Generated image for: "suddenly i dancing severance style with the furry orcas"'),
      plainText: '✨ Generated image for: "suddenly i dancing severance style with the furry orcas"',
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

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const qrDataUri = await QRCode.toDataURL(
    'https://example.slack.com/archives/C1/p1752345600000100',
    { margin: 0, width: 260, color: { dark: '#2A241B', light: '#FFFFFF' } },
  );

  const rows: string[] = [];
  for (const f of FIXTURES) {
    const photoFront = Boolean(f.photo);
    let front: Buffer;
    if (f.photo) {
      const res = await fetch(f.photo);
      front = await renderPhotoFront(Buffer.from(await res.arrayBuffer()), '4x6');
    } else {
      front = await renderTextCardFront(f.message, '4x6');
    }
    const back = await renderBack(f.message, '4x6', {
      includeMessage: photoFront,
      senders: SENDERS,
      cardNumber: 12,
      teamName: 'exampleco',
      qrDataUri,
      ...f.back,
    });

    const frontFile = `${f.name}-front.${photoFront ? 'jpg' : 'png'}`;
    const backFile = `${f.name}-back.png`;
    fs.writeFileSync(path.join(OUT, frontFile), front);
    fs.writeFileSync(path.join(OUT, backFile), back);
    rows.push(
      `<h2>${f.name}</h2><div class="pair"><img src="${frontFile}"><img src="${backFile}"></div>`,
    );
    console.log(`✓ ${f.name}`);
  }

  fs.writeFileSync(
    path.join(OUT, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Postie gallery</title>
<style>
  body{font-family:system-ui;background:#efeae2;margin:40px;color:#2a241b}
  h2{margin:36px 0 10px;font-size:15px;text-transform:uppercase;letter-spacing:2px;color:#8d8271}
  .pair{display:flex;gap:16px}
  img{width:46%;box-shadow:0 3px 14px rgba(0,0,0,.22);border-radius:4px}
</style>
<h1>Postie design gallery</h1>
${rows.join('\n')}`,
  );
  console.log(`\ngallery: ${path.join(OUT, 'index.html')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
