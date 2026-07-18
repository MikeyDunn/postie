import { Token, tokenize } from './mrkdwn';

/**
 * Converts Block Kit blocks into the same Token stream the mrkdwn tokenizer
 * produces, split by the editorial role Slack itself assigns:
 *
 *   - content: rich_text (human messages — fully structured), section,
 *     header, image titles. The author's actual words.
 *   - chrome: context blocks — Slack renders these small and muted; they are
 *     metadata ("model | runtime | cost"), not the message.
 *
 * A postcard prints content. When a message has no content blocks, the
 * top-level `text` (the bot author's own one-line notification summary) is
 * usually the most card-worthy line available; chrome is the last resort.
 * That selection lives in the normalizer — this module only classifies.
 */
export interface BlockTokens {
  content: Token[];
  chrome: Token[];
}

export function blocksToTokens(blocks: Array<Record<string, any>> | undefined): BlockTokens {
  const content: Token[] = [];
  const chrome: Token[] = [];
  for (const block of blocks ?? []) {
    const target = block.type === 'context' ? chrome : content;
    const tokens = blockTokens(block);
    if (tokens.length) {
      if (target.length) target.push({ kind: 'newline' });
      target.push(...tokens);
    }
  }
  return { content, chrome };
}

function blockTokens(block: Record<string, any>): Token[] {
  switch (block.type) {
    case 'rich_text':
      return richTextTokens(block.elements ?? []);
    case 'header':
      return block.text?.text ? [{ kind: 'text', text: block.text.text, style: 'bold' }] : [];
    case 'section': {
      const out: Token[] = [];
      if (block.text?.text) out.push(...textObjectTokens(block.text));
      for (const field of block.fields ?? []) {
        if (!field?.text) continue;
        if (out.length) out.push({ kind: 'newline' });
        out.push(...textObjectTokens(field));
      }
      return out;
    }
    case 'context': {
      // Slack renders context elements inline, small and muted.
      const out: Token[] = [];
      for (const el of block.elements ?? []) {
        if (el.type !== 'mrkdwn' && el.type !== 'plain_text') continue;
        if (!el.text) continue;
        if (out.length) out.push({ kind: 'text', text: '  ' });
        out.push(...textObjectTokens(el));
      }
      return out;
    }
    case 'image':
      // The image itself is extracted separately; its title is displayed text.
      return block.title?.text ? [{ kind: 'text', text: block.title.text }] : [];
    default:
      return [];
  }
}

function textObjectTokens(textObject: { type?: string; text?: string }): Token[] {
  if (!textObject.text) return [];
  if (textObject.type === 'plain_text') return [{ kind: 'text', text: textObject.text }];
  return tokenize(textObject.text);
}

function richTextTokens(elements: Array<Record<string, any>>): Token[] {
  const out: Token[] = [];
  for (const el of elements) {
    const part = richPartTokens(el);
    if (part.length) {
      if (out.length) out.push({ kind: 'newline' });
      out.push(...part);
    }
  }
  return out;
}

function richPartTokens(el: Record<string, any>): Token[] {
  switch (el.type) {
    case 'rich_text_section':
    case 'rich_text_quote':
      return richInlineTokens(el.elements ?? []);
    case 'rich_text_preformatted':
      return [
        {
          kind: 'codeblock',
          text: (el.elements ?? []).map((e: Record<string, any>) => e.text ?? '').join(''),
        },
      ];
    case 'rich_text_list': {
      const out: Token[] = [];
      (el.elements ?? []).forEach((item: Record<string, any>, i: number) => {
        if (i) out.push({ kind: 'newline' });
        const marker = el.style === 'ordered' ? `${(el.offset ?? 0) + i + 1}. ` : '• ';
        out.push({ kind: 'text', text: marker });
        out.push(...richInlineTokens(item.elements ?? []));
      });
      return out;
    }
    default:
      return [];
  }
}

function richInlineTokens(elements: Array<Record<string, any>>): Token[] {
  const out: Token[] = [];
  for (const e of elements) {
    switch (e.type) {
      case 'text': {
        const s = e.style ?? {};
        const style = s.code ? 'code' : s.bold ? 'bold' : s.italic ? 'italic' : s.strike ? 'strike' : undefined;
        const lines = String(e.text ?? '').split('\n');
        lines.forEach((line, i) => {
          if (i) out.push({ kind: 'newline' });
          if (line) out.push({ kind: 'text', text: line, ...(style ? { style } : {}) } as Token);
        });
        break;
      }
      case 'link':
        out.push({ kind: 'link', url: e.url, label: e.text });
        break;
      case 'user':
        out.push({ kind: 'user', userId: e.user_id });
        break;
      case 'channel':
        out.push({ kind: 'channel', channelId: e.channel_id });
        break;
      case 'emoji':
        out.push({ kind: 'emoji', name: e.name, unicode: e.unicode });
        break;
      case 'broadcast':
        out.push({ kind: 'broadcast', range: e.range });
        break;
      case 'usergroup':
        out.push({ kind: 'text', text: e.name ? `@${e.name}` : '@group' });
        break;
      case 'date':
        if (e.fallback) out.push({ kind: 'text', text: e.fallback });
        break;
      default:
        if (e.text) out.push({ kind: 'text', text: String(e.text) });
    }
  }
  return out;
}
