/**
 * Tokenizer for Slack's mrkdwn format. Slack messages arrive with three HTML
 * entities escaped (& < >), rich elements in angle brackets (<@U123>, <#C123|name>,
 * <https://url|label>, <!here>), emoji as :shortcodes:, and *bold* _italic_
 * ~strike~ `code` ```blocks```.
 */

export type TextStyle = 'bold' | 'italic' | 'strike' | 'code';

export type Token =
  | { kind: 'text'; text: string; style?: TextStyle }
  | { kind: 'user'; userId: string; label?: string }
  | { kind: 'channel'; channelId: string; label?: string }
  | { kind: 'broadcast'; range: string }
  | { kind: 'link'; url: string; label?: string }
  | { kind: 'emoji'; name: string; unicode?: string }
  | { kind: 'codeblock'; text: string }
  | { kind: 'newline' };

export function unescapeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const CODE_BLOCK = /```([\s\S]*?)```/g;

// One pass per line: angle elements, emoji shortcodes, then inline styles.
// Lookarounds keep :30: out of "10:30:45" and _x_ out of snake_case.
const INLINE = new RegExp(
  [
    '<([^<>]+)>',
    "(?<![\\w:]):([a-zA-Z0-9_+'\\-]+):(?!\\w)",
    '\\*([^*\\n]+)\\*',
    '(?<![\\w])_([^_\\n]+)_(?![\\w])',
    '~([^~\\n]+)~',
    '`([^`\\n]+)`',
  ].join('|'),
  'g',
);

function parseAngle(content: string): Token {
  if (content.startsWith('@')) {
    const [id, label] = content.slice(1).split('|', 2);
    return { kind: 'user', userId: id, label };
  }
  if (content.startsWith('#')) {
    const [id, label] = content.slice(1).split('|', 2);
    return { kind: 'channel', channelId: id, label };
  }
  if (content.startsWith('!')) {
    const body = content.slice(1);
    // <!date^...|fallback> and <!subteam^ID|@group> carry a display fallback.
    const fallback = body.includes('|') ? body.split('|').pop() : undefined;
    if (body.startsWith('date') || body.startsWith('subteam')) {
      return { kind: 'text', text: fallback ?? '' };
    }
    return { kind: 'broadcast', range: body.split('|')[0] };
  }
  const [url, label] = content.split('|', 2);
  return { kind: 'link', url, label };
}

function tokenizeInline(line: string, out: Token[]): void {
  let last = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(line); m; m = INLINE.exec(line)) {
    if (m.index > last) {
      out.push({ kind: 'text', text: unescapeEntities(line.slice(last, m.index)) });
    }
    const [, angle, emoji, bold, italic, strike, code] = m;
    if (angle !== undefined) out.push(parseAngle(angle));
    else if (emoji !== undefined) out.push({ kind: 'emoji', name: emoji });
    else if (bold !== undefined) out.push({ kind: 'text', text: unescapeEntities(bold), style: 'bold' });
    else if (italic !== undefined) out.push({ kind: 'text', text: unescapeEntities(italic), style: 'italic' });
    else if (strike !== undefined) out.push({ kind: 'text', text: unescapeEntities(strike), style: 'strike' });
    else if (code !== undefined) out.push({ kind: 'text', text: unescapeEntities(code), style: 'code' });
    last = m.index + m[0].length;
  }
  if (last < line.length) {
    out.push({ kind: 'text', text: unescapeEntities(line.slice(last)) });
  }
}

function tokenizeChunk(chunk: string, out: Token[]): void {
  const lines = chunk.split('\n');
  lines.forEach((line, i) => {
    if (i > 0) out.push({ kind: 'newline' });
    if (line.length > 0) tokenizeInline(line, out);
  });
}

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  CODE_BLOCK.lastIndex = 0;
  for (let m = CODE_BLOCK.exec(text); m; m = CODE_BLOCK.exec(text)) {
    if (m.index > last) tokenizeChunk(text.slice(last, m.index), out);
    out.push({ kind: 'codeblock', text: unescapeEntities(m[1].replace(/^\n|\n$/g, '')) });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokenizeChunk(text.slice(last), out);
  return out;
}
