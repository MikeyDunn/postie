/* One-off: renders the :postcard: emoji for Slack. Run from the postie repo:
 *   npx tsx /path/to/make-emoji.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import satori from 'satori';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

const REPO = path.join(__dirname, '..');
const ink = '#2A241B';
const paper = '#FFFDF8';
const accent = '#C4553B';
const subtle = '#8D8271';
const blue = '#3E5F8A';

type Node = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, ...children: Node[]): Node => ({
  type,
  props: { style: { display: 'flex', ...style }, children },
});

const line = (width: number, color = subtle, height = 14) =>
  h('div', { width, height, backgroundColor: color, borderRadius: 7 });

// 512-unit canvas, rendered down to 128 for smooth edges.
const card = h(
  'div',
  {
    display: 'flex',
    width: 512,
    height: 512,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: process.env.ICON_BG ?? 'transparent',
  },
  h(
    'div',
    {
      display: 'flex',
      width: 460,
      height: 340,
      backgroundColor: paper,
      border: `14px solid ${ink}`,
      borderRadius: 36,
      transform: 'rotate(-8deg)',
      padding: 26,
    },
    // Left half: message scribbles
    h(
      'div',
      {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        gap: 22,
        width: '50%',
        paddingRight: 20,
        paddingBottom: 6,
      },
      line(150, accent, 16),
      line(180),
      line(130),
      line(160),
    ),
    // Divider
    h('div', { width: 10, backgroundColor: ink, borderRadius: 5, height: '100%' }),
    // Right half: stamp + address lines
    h(
      'div',
      {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        width: '50%',
        paddingLeft: 20,
      },
      h(
        'div',
        {
          display: 'flex',
          width: 92,
          height: 108,
          backgroundColor: accent,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
        },
        h('div', {
          width: 56,
          height: 68,
          border: `10px solid ${paper}`,
          borderRadius: 6,
          backgroundColor: blue,
        }),
      ),
      h(
        'div',
        {
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          alignItems: 'flex-start',
          width: '100%',
          paddingBottom: 6,
        },
        line(170, ink),
        line(120, ink),
      ),
    ),
  ),
);

async function main() {
  await initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
  const svg = await satori(card as never, {
    width: 512,
    height: 512,
    fonts: [
      {
        name: 'Inter',
        data: fs.readFileSync(path.join(REPO, 'assets/fonts/Inter-Regular.ttf')),
        weight: 400,
        style: 'normal',
      },
    ],
  });
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: Number(process.env.ICON_SIZE ?? 128) },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
  const out = path.join(REPO, 'assets', process.env.ICON_OUT ?? 'postcard-emoji.png');
  fs.writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
