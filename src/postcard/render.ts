import * as fs from 'node:fs';
import * as path from 'node:path';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { Jimp } from 'jimp';
import satori from 'satori';
import type { PostcardSize } from '../core/types';
import type { NormalizedMessage, Segment } from './normalize';

/**
 * Print dimensions at 300 DPI including 0.125" bleed on each edge
 * (e.g. 4x6 → 6.25" x 4.25" artwork = 1875x1275).
 * TODO: confirm exact bleed + safe-zone specs against Mailstream's docs
 * once we have dashboard access — these follow common print-API conventions.
 */
export const SIZE_SPECS: Record<PostcardSize, { width: number; height: number }> = {
  '4x6': { width: 1875, height: 1275 },
  '6x9': { width: 2775, height: 1875 },
  '6x11': { width: 3375, height: 1875 },
};

/**
 * Print-safety inset at 300 DPI: the 0.125" bleed is physically trimmed off
 * every edge, and print convention keeps must-survive art another 0.125"
 * inside the trim line. Anything an uncropped image needs to keep stays this
 * far from the artwork edge.
 */
const EDGE_SAFE_PX = 75;

const palette = {
  paper: '#FBF7EF',
  ink: '#2A241B',
  accent: '#C4553B',
  subtle: '#8D8271',
  codePillBg: '#EFE6D4',
  codeBlockBg: '#2C261F',
  codeBlockInk: '#F4EBDA',
  linkInk: '#7A5C3E',
};

// ---------------------------------------------------------------------------
// Fonts + wasm bootstrap
// ---------------------------------------------------------------------------

interface SatoriFont {
  name: string;
  data: Buffer;
  weight: 400 | 500 | 600 | 700;
  style: 'normal' | 'italic';
}

let fontsCache: SatoriFont[] | undefined;

function fontsDir(): string {
  return process.env.FONTS_DIR ?? path.join(__dirname, '..', '..', 'assets', 'fonts');
}

// Postie's own postcard mark (the custom emoji artwork), used as the brand
// glyph on cards instead of the generic twemoji mailbox.
let brandMarkCache: string | undefined;
function brandMarkUri(): string {
  if (!brandMarkCache) {
    const file = path.join(fontsDir(), '..', 'postcard-emoji.png');
    brandMarkCache = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  }
  return brandMarkCache;
}

function loadFonts(): SatoriFont[] {
  if (fontsCache) return fontsCache;
  const dir = fontsDir();
  const spec: Array<[string, string, SatoriFont['weight'], SatoriFont['style']]> = [
    ['Inter', 'Inter-Regular.ttf', 400, 'normal'],
    ['Inter', 'Inter-Medium.ttf', 500, 'normal'],
    ['Inter', 'Inter-SemiBold.ttf', 600, 'normal'],
    ['Inter', 'Inter-Bold.ttf', 700, 'normal'],
    ['Source Serif 4', 'SourceSerif4-Regular.ttf', 400, 'normal'],
    ['Source Serif 4', 'SourceSerif4-Semibold.ttf', 600, 'normal'],
    ['Source Serif 4', 'SourceSerif4-It.ttf', 400, 'italic'],
  ];
  fontsCache = spec.map(([name, file, weight, style]) => ({
    name,
    data: fs.readFileSync(path.join(dir, file)),
    weight,
    style,
  }));
  return fontsCache;
}

let wasmReady: Promise<void> | undefined;

function ensureResvg(): Promise<void> {
  if (!wasmReady) {
    const wasmPath = require.resolve('@resvg/resvg-wasm/index_bg.wasm');
    wasmReady = initWasm(fs.readFileSync(wasmPath));
  }
  return wasmReady;
}

async function svgToPng(svg: string, width: number): Promise<Buffer> {
  await ensureResvg();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: false },
  });
  return Buffer.from(resvg.render().asPng());
}

// ---------------------------------------------------------------------------
// Element helpers (satori accepts React-shaped plain objects)
// ---------------------------------------------------------------------------

type Node = { type: string; props: Record<string, unknown> } | string;

function h(type: string, style: Record<string, unknown>, ...children: (Node | Node[])[]): Node {
  const flat = children.flat();
  // satori requires explicit display:flex on any multi-child container;
  // defaulting it on divs avoids a class of silent layout errors.
  const withDisplay = type === 'div' ? { display: 'flex', ...style } : style;
  return {
    type,
    props: { style: withDisplay, children: flat.length === 1 ? flat[0] : flat },
  };
}

function img(src: string, size: number, style: Record<string, unknown> = {}): Node {
  return { type: 'img', props: { src, width: size, height: size, style } };
}

// ---------------------------------------------------------------------------
// Emoji (unicode → twemoji images so satori doesn't render tofu)
// ---------------------------------------------------------------------------

// \p{RGI_Emoji} needs the 'v' flag (ES2024 / Node 20+).
const EMOJI_RE = /\p{RGI_Emoji}/gv;

function twemojiUrl(grapheme: string): string {
  const cps = [...grapheme].map((c) => c.codePointAt(0)!);
  const filtered = grapheme.includes('‍') ? cps : cps.filter((c) => c !== 0xfe0f);
  const code = filtered.map((c) => c.toString(16)).join('-');
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/${code}.svg`;
}

// Fetched twemoji, cached for the lifetime of the process (warm Lambda).
const twemojiCache = new Map<string, string | undefined>();

/**
 * satori embeds graphemeImages as <img> hrefs but does NOT fetch remote URLs,
 * and resvg-wasm can't fetch either — so emoji must be inlined as data URIs
 * or they silently disappear from the render.
 */
async function collectGraphemeImages(texts: string[]): Promise<Record<string, string>> {
  const graphemes = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(EMOJI_RE)) graphemes.add(match[0]);
  }
  const map: Record<string, string> = {};
  await Promise.all(
    [...graphemes].map(async (g) => {
      if (!twemojiCache.has(g)) {
        twemojiCache.set(g, await tryDataUri(twemojiUrl(g)));
      }
      const uri = twemojiCache.get(g);
      if (uri) map[g] = uri;
    }),
  );
  return map;
}

function allText(msg: NormalizedMessage): string[] {
  const texts = [msg.author.name, msg.channelName];
  for (const s of msg.segments) {
    if (s.kind === 'text' || s.kind === 'mention' || s.kind === 'link' || s.kind === 'codeblock') {
      texts.push(s.text);
    } else if (s.kind === 'emoji' && s.char) {
      texts.push(s.char);
    }
  }
  return texts;
}

// ---------------------------------------------------------------------------
// Remote assets → data URIs (avatars, custom emoji) so satori never fetches
// ---------------------------------------------------------------------------

async function fetchAsDataUri(url: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const type = res.headers.get('content-type') ?? 'image/png';
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${type};base64,${buf.toString('base64')}`;
}

async function tryDataUri(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    return await fetchAsDataUri(url);
  } catch {
    return undefined;
  }
}

async function inlineCustomEmoji(segments: Segment[]): Promise<Segment[]> {
  return Promise.all(
    segments.map(async (s) => {
      if (s.kind !== 'emoji' || !s.url) return s;
      const dataUri = await tryDataUri(s.url);
      return dataUri ? { ...s, url: dataUri } : { ...s, url: undefined, char: s.char };
    }),
  );
}

// ---------------------------------------------------------------------------
// Text layout: segments → word-level spans (satori wraps flex items, so
// word-granular spans give natural line breaks across style boundaries)
// ---------------------------------------------------------------------------

function fitBodySize(charCount: number): number {
  if (charCount <= 80) return 88;
  if (charCount <= 160) return 72;
  if (charCount <= 280) return 60;
  if (charCount <= 450) return 50;
  return 42;
}

const MAX_CHARS = 600;

export function truncateSegments(segments: Segment[], maxChars: number = MAX_CHARS): Segment[] {
  const out: Segment[] = [];
  let used = 0;
  for (const s of segments) {
    const len = s.kind === 'newline' ? 1 : s.kind === 'emoji' ? 2 : s.text.length;
    if (used + len > maxChars) {
      if (s.kind !== 'newline' && s.kind !== 'emoji') {
        const room = Math.max(0, maxChars - used);
        const clipped = s.text.slice(0, room).replace(/\s+\S*$/, '');
        if (clipped) out.push({ ...s, text: `${clipped}…` } as Segment);
        else out.push({ kind: 'text', text: '…' });
      } else {
        out.push({ kind: 'text', text: '…' });
      }
      return out;
    }
    used += len;
    out.push(s);
  }
  return out;
}

function wordSpans(text: string, style: Record<string, unknown>): Node[] {
  return text
    .split(/(\s+)/)
    .filter((w) => w.length > 0)
    .map((word) => h('span', style, word.match(/^\s+$/) ? ' ' : word));
}

function segmentNodes(segments: Segment[], base: number, serif: boolean): Node[] {
  const bodyFont = serif ? 'Source Serif 4' : 'Inter';
  const nodes: Node[] = [];
  for (const s of segments) {
    switch (s.kind) {
      case 'text': {
        const style: Record<string, unknown> = { fontFamily: bodyFont };
        if (s.style === 'bold') style.fontWeight = 600;
        if (s.style === 'italic') style.fontStyle = 'italic';
        if (s.style === 'strike') style.textDecoration = 'line-through';
        if (s.style === 'code') {
          Object.assign(style, {
            fontFamily: 'Inter',
            backgroundColor: palette.codePillBg,
            borderRadius: 10,
            padding: '2px 12px',
            fontSize: Math.round(base * 0.82),
          });
          nodes.push(h('span', style, s.text));
          break;
        }
        nodes.push(...wordSpans(s.text, style));
        break;
      }
      case 'mention':
        nodes.push(
          h('span', { color: palette.accent, fontWeight: 600, fontFamily: 'Inter' }, s.text),
        );
        break;
      case 'link':
        nodes.push(
          ...wordSpans(s.text, {
            color: palette.linkInk,
            textDecoration: 'underline',
            fontFamily: bodyFont,
          }),
        );
        break;
      case 'emoji':
        if (s.url) {
          nodes.push(img(s.url, base, { margin: '0 6px', borderRadius: 8 }));
        } else if (s.char) {
          nodes.push(h('span', { fontFamily: bodyFont }, s.char));
        } else {
          nodes.push(h('span', { fontFamily: bodyFont }, `:${s.name}:`));
        }
        break;
      case 'codeblock':
        nodes.push(
          h(
            'div',
            {
              display: 'flex',
              width: '100%',
              backgroundColor: palette.codeBlockBg,
              color: palette.codeBlockInk,
              borderRadius: 18,
              padding: '20px 28px',
              fontSize: Math.round(base * 0.6),
              fontFamily: 'Inter',
              whiteSpace: 'pre-wrap',
            },
            s.text.length > 300 ? `${s.text.slice(0, 300)}…` : s.text,
          ),
        );
        break;
      case 'newline':
        nodes.push(h('div', { width: '100%', height: Math.round(base * 0.3) }));
        break;
    }
  }
  return nodes;
}

function avatarNode(
  author: NormalizedMessage['author'],
  avatarUri: string | undefined,
  size: number,
): Node {
  if (avatarUri) return img(avatarUri, size, { borderRadius: size });
  return h(
    'div',
    {
      display: 'flex',
      width: size,
      height: size,
      borderRadius: size,
      backgroundColor: palette.accent,
      color: palette.paper,
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: Math.round(size * 0.45),
      fontWeight: 700,
      fontFamily: 'Inter',
    },
    (author.name[0] ?? '?').toUpperCase(),
  );
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Public renderers
// ---------------------------------------------------------------------------

/** Front of the card when the message has no photo: a designed text card. */
export async function renderTextCardFront(
  msg: NormalizedMessage,
  size: PostcardSize,
): Promise<Buffer> {
  const { width, height } = SIZE_SPECS[size];
  const segments = truncateSegments(await inlineCustomEmoji(msg.segments));
  const base = fitBodySize(msg.plainText.length);
  // First-person bot posts show the human they were posted for.
  const speaker = msg.onBehalfOf ?? msg.author;
  const speakerLabel = msg.onBehalfOf
    ? `${msg.onBehalfOf.name} · via ${msg.author.name}`
    : msg.author.name;
  const avatarUri = await tryDataUri(speaker.avatarUrl);

  const tree = h(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      backgroundColor: palette.paper,
      color: palette.ink,
      padding: '110px 130px',
      fontFamily: 'Inter',
      position: 'relative',
    },
    h(
      'div',
      {
        position: 'absolute',
        top: -60,
        left: 60,
        fontFamily: 'Source Serif 4',
        fontSize: 480,
        color: 'rgba(196, 85, 59, 0.10)',
      },
      '“',
    ),
    // No header — channel/date live on the back's meta line; the front is
    // just the words and who said them.
    h(
      'div',
      { display: 'flex', flex: 1, alignItems: 'center' },
      h(
        'div',
        {
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          rowGap: Math.round(base * 0.35),
          fontSize: base,
          fontFamily: 'Source Serif 4',
          lineHeight: 1.3,
        },
        segmentNodes(segments, base, true),
      ),
    ),
    h(
      'div',
      { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 40 },
      h(
        'div',
        { display: 'flex', alignItems: 'center', gap: 28 },
        avatarNode(speaker, avatarUri, 104),
        h('span', { fontSize: 42, fontWeight: 700 }, speakerLabel),
      ),
      h(
        'div',
        { alignItems: 'center', gap: 12 },
        img(brandMarkUri(), 40),
        h('span', { fontSize: 30, color: palette.subtle, fontWeight: 600 }, 'postie'),
      ),
    ),
  );

  const svg = await satori(tree as never, {
    width,
    height,
    fonts: loadFonts(),
    graphemeImages: await collectGraphemeImages(allText(msg)),
  });
  return svgToPng(svg, width);
}

/**
 * Front of the card when the message has a photo — always a pure image, no
 * text (the back is the information side):
 *   - wide images (ratio ≥ 1.25): full-bleed cover crop
 *   - square/portrait (incl. 1024x1024 AI output): blur-fill — the image
 *     itself, scaled to cover and heavily blurred, becomes an ambient
 *     backdrop behind the sharp uncropped original, inset to trim-safe
 *     height so the printer's edge trim never cuts into it.
 * JPEG output — a photo-sized PNG triples the size for no visible gain on
 * print stock.
 */
export async function renderPhotoFront(imageBuffer: Buffer, size: PostcardSize): Promise<Buffer> {
  const { width, height } = SIZE_SPECS[size];
  // Jimp applies EXIF orientation on decode — phone photos stay upright.
  const image = await Jimp.read(imageBuffer);

  if (image.width / image.height >= 1.25) {
    image.cover({ w: width, h: height });
    return image.getBuffer('image/jpeg', { quality: 90 });
  }

  // Blur-fill: downscale → blur → upscale is both faster and smoother than
  // blurring at print resolution; the dark overlay quiets the backdrop so it
  // reads as a color wash rather than failed focus.
  const bg = image.clone();
  bg.cover({ w: Math.max(64, Math.round(width / 5)), h: Math.max(64, Math.round(height / 5)) });
  bg.blur(10);
  bg.resize({ w: width, h: height });
  bg.composite(new Jimp({ width, height, color: 0x00000055 }), 0, 0);

  const sharp = image.clone();
  // Scaled to the trim-safe height, not the full artwork: the bleed zone is
  // physically cut in printing, which was slicing the top/bottom off the
  // uncropped original. The blur backdrop owns the bleed instead.
  sharp.scale((height - 2 * EDGE_SAFE_PX) / sharp.height);
  bg.composite(
    sharp,
    Math.round((width - sharp.width) / 2),
    Math.round((height - sharp.height) / 2),
  );
  return bg.getBuffer('image/jpeg', { quality: 90 });
}

export interface Sender {
  name: string;
  avatarUrl?: string;
}

export interface BackExtras {
  includeMessage: boolean;
  /** Everyone who added the trigger reaction — the card's "signed by" line. */
  senders?: Sender[];
  cardNumber?: number;
  teamName?: string;
  /** Pre-rendered QR data URI linking to the Slack permalink. */
  qrDataUri?: string;
}

const MAX_SENDER_NAMES = 5;

/**
 * One quiet line, not a labeled block — print-size avatars are mud and a
 * second caps label makes the back read like UI. Omitted when the only
 * sender is the message author (nothing new to say).
 */
function sendersLine(senders: Sender[], authorName: string): string | undefined {
  if (!senders.length) return undefined;
  if (senders.length === 1) {
    return senders[0].name === authorName ? undefined : `Sent by your friend ${senders[0].name}`;
  }
  const names = senders.map((s) => s.name);
  if (names.length <= MAX_SENDER_NAMES) {
    return `Sent by your friends: ${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
  }
  return `Sent by your friends: ${names.slice(0, MAX_SENDER_NAMES).join(', ')} +${names.length - MAX_SENDER_NAMES} more`;
}

/**
 * Back of the card. The right side stays clear for the address block +
 * postage (TODO: confirm Mailstream's exact clear-zone once docs are open).
 * When the front is a photo (full-bleed) the message text lives here; the
 * signature block (senders), card number, workspace name, and permalink QR
 * make the back the "who and where" side of the artifact.
 */
export async function renderBack(
  msg: NormalizedMessage,
  size: PostcardSize,
  opts: BackExtras,
): Promise<Buffer> {
  const { width, height } = SIZE_SPECS[size];
  const base = opts.includeMessage ? Math.min(fitBodySize(msg.plainText.length), 44) : 40;
  const segments = opts.includeMessage
    ? truncateSegments(await inlineCustomEmoji(msg.segments), 320)
    : [];

  // The meta line is the single home for context — team, channel, date
  // appear here and nowhere else on the card. First-person text in bot posts
  // belongs to the human it was posted for ("— sam · via clank").
  const attribution = msg.onBehalfOf
    ? `— ${msg.onBehalfOf.name} · via ${msg.author.name}`
    : `— ${msg.author.name}`;
  const meta = [opts.teamName, `#${msg.channelName}`, formatDate(msg.postedAt)]
    .filter(Boolean)
    .join(' · ');
  const footerText = `postie${opts.cardNumber ? ` № ${opts.cardNumber}` : ''}`;
  const senders = sendersLine(opts.senders ?? [], msg.author.name);

  // Small sans register, used for every non-serif element on the back —
  // exactly two type registers total keeps it calm.
  const metaStyle = {
    fontSize: 20,
    letterSpacing: 3,
    textTransform: 'uppercase',
    color: palette.subtle,
    fontWeight: 600,
  };

  const contentChildren: Node[] = [];
  if (opts.includeMessage) {
    contentChildren.push(
      h(
        'div',
        {
          flexWrap: 'wrap',
          alignItems: 'baseline',
          rowGap: Math.round(base * 0.35),
          fontSize: base,
          fontFamily: 'Source Serif 4',
          lineHeight: 1.35,
        },
        segmentNodes(segments, base, true),
      ),
    );
  }
  // Attribution only when the message is here too (photo cards) — the text
  // card already names its author on the front.
  if (opts.includeMessage) {
    contentChildren.push(
      h('span', { fontSize: 30, fontFamily: 'Source Serif 4', fontStyle: 'italic' }, attribution),
    );
  }
  if (senders) contentChildren.push(h('span', metaStyle, senders));

  const tree = h(
    'div',
    {
      width: '100%',
      height: '100%',
      backgroundColor: '#FFFFFF',
      color: palette.ink,
      padding: '80px 90px 70px 90px',
      fontFamily: 'Inter',
    },
    h(
      'div',
      // Mailstream's template proof shows their return address printing from
      // ~44% width — the writable area is the left ~40% only.
      { flexDirection: 'column', width: '40%', paddingRight: 40 },
      h('span', metaStyle, meta),
      h(
        'div',
        { flexDirection: 'column', flex: 1, justifyContent: 'center', gap: 26 },
        contentChildren,
      ),
      h(
        'div',
        { alignItems: 'center', gap: 24 },
        // ≥0.5" at 300 DPI — smaller QRs don't scan reliably from print.
        opts.qrDataUri ? img(opts.qrDataUri, 150) : h('div', {}),
        h(
          'div',
          { alignItems: 'center', gap: 10 },
          img(brandMarkUri(), 28),
          h('span', { fontSize: 18, color: palette.subtle, fontWeight: 500 }, footerText),
        ),
      ),
    ),
    // Postage indicia, return address, recipient address, IMb barcode zone.
    h('div', { width: '60%' }),
  );

  const senderNames = (opts.senders ?? []).map((s) => s.name);
  const svg = await satori(tree as never, {
    width,
    height,
    fonts: loadFonts(),
    graphemeImages: await collectGraphemeImages(allText(msg).concat(senderNames, ['📮'])),
  });
  return svgToPng(svg, width);
}
