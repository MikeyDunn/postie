/**
 * Design gallery: renders every representative message shape front + back
 * into test/__output__/gallery/ with an index.html contact sheet, so layout
 * changes can be judged across all cases at once.
 *
 *   npm run gallery      (then it opens in the browser)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as QRCode from 'qrcode';
import { renderBack, renderPhotoFront, renderTextCardFront } from '../src/postcard/render';
import { FIXTURES, SENDERS } from '../test/fixtures';

const OUT = path.join(__dirname, '..', 'test', '__output__', 'gallery');

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
