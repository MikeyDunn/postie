import * as fs from 'node:fs';
import * as path from 'node:path';
import { Jimp } from 'jimp';
import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../src/postcard/normalize';
import {
  renderBack,
  renderPhotoFront,
  renderTextCardFront,
  SIZE_SPECS,
  truncateSegments,
} from '../src/postcard/render';

function pngSize(buf: Buffer): { width: number; height: number } {
  // PNG signature (8) + IHDR length/type (8), then width/height as u32be.
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const OUT_DIR = path.join(__dirname, '__output__');

function sampleMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    teamId: 'T1',
    channelId: 'C1',
    channelName: 'general',
    messageTs: '1752345600.000100',
    author: { id: 'U1', name: 'Sam Rivera' },
    segments: [
      { kind: 'text', text: 'The rooftop garden finally ' },
      { kind: 'text', text: 'bloomed', style: 'bold' },
      { kind: 'text', text: ' after three failed summers, ' },
      { kind: 'mention', text: '@alex' },
      { kind: 'text', text: ' called it a miracle.' },
    ],
    plainText:
      'The rooftop garden finally bloomed after three failed summers, @alex called it a miracle.',
    postedAt: new Date('2026-07-12T18:00:00Z'),
    ...overrides,
  };
}

describe('renderTextCardFront', () => {
  it('renders a 4x6 text card at print dimensions', async () => {
    const png = await renderTextCardFront(sampleMessage(), '4x6');
    expect(pngSize(png)).toEqual(SIZE_SPECS['4x6']);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'text-front.png'), png);
  });
});

describe('renderPhotoFront', () => {
  it('cover-crops wide images to full-bleed JPEG', async () => {
    const src = new Jimp({ width: 1600, height: 900, color: 0x336699ff });
    const srcPng = await src.getBuffer('image/png');
    const front = await renderPhotoFront(Buffer.from(srcPng), '4x6');
    expect(front.subarray(0, 3).toString('hex')).toBe('ffd8ff'); // JPEG magic
    const decoded = await Jimp.read(Buffer.from(front));
    expect({ width: decoded.width, height: decoded.height }).toEqual(SIZE_SPECS['4x6']);
  });

  it('blur-fills square images to full-bleed with the sharp original centered', async () => {
    // Two-tone source so the blurred wings differ from the sharp center.
    const src = new Jimp({ width: 1024, height: 1024, color: 0x7a9e7eff });
    src.composite(new Jimp({ width: 512, height: 1024, color: 0xc4553bff }), 0, 0);
    const srcPng = await src.getBuffer('image/png');
    const front = await renderPhotoFront(Buffer.from(srcPng), '4x6');
    expect(front.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    const decoded = await Jimp.read(Buffer.from(front));
    expect({ width: decoded.width, height: decoded.height }).toEqual(SIZE_SPECS['4x6']);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'blurfill-front.jpg'), front);
  });
});

describe('renderBack', () => {
  it('renders message, senders, card number, team name, and QR with a clear address zone', async () => {
    const QRCode = await import('qrcode');
    const qrDataUri = await QRCode.toDataURL(
      'https://example.slack.com/archives/C1/p1752345600000100',
      {
        margin: 0,
        width: 260,
      },
    );
    const png = await renderBack(sampleMessage(), '4x6', {
      includeMessage: true,
      senders: [
        { name: 'Sam Rivera' },
        { name: 'Alex Kim' },
        { name: 'Jordan Fox' },
        { name: 'Casey Lee' },
        { name: 'Robin Diaz' },
      ],
      cardNumber: 12,
      teamName: 'exampleco',
      qrDataUri,
    });
    expect(pngSize(png)).toEqual(SIZE_SPECS['4x6']);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'back.png'), png);
  });
});

describe('truncateSegments', () => {
  it('clips long text at a word boundary with an ellipsis', () => {
    const out = truncateSegments([{ kind: 'text', text: 'word '.repeat(400) }], 100);
    expect(out).toHaveLength(1);
    const text = (out[0] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(101);
    expect(text.endsWith('…')).toBe(true);
  });

  it('keeps short messages untouched', () => {
    const segments = sampleMessage().segments;
    expect(truncateSegments(segments)).toEqual(segments);
  });
});
