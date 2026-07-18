import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/postcard/mrkdwn';

describe('tokenize', () => {
  it('passes plain text through', () => {
    expect(tokenize('hello world')).toEqual([{ kind: 'text', text: 'hello world' }]);
  });

  it('parses user mentions with and without labels', () => {
    expect(tokenize('<@U123> and <@U456|mike>')).toEqual([
      { kind: 'user', userId: 'U123', label: undefined },
      { kind: 'text', text: ' and ' },
      { kind: 'user', userId: 'U456', label: 'mike' },
    ]);
  });

  it('parses channel refs, broadcasts, and links', () => {
    expect(tokenize('<#C123|general> <!here> <https://a.com|see this>')).toEqual([
      { kind: 'channel', channelId: 'C123', label: 'general' },
      { kind: 'text', text: ' ' },
      { kind: 'broadcast', range: 'here' },
      { kind: 'text', text: ' ' },
      { kind: 'link', url: 'https://a.com', label: 'see this' },
    ]);
  });

  it('parses inline styles', () => {
    expect(tokenize('*bold* _it_ ~gone~ `x=1`')).toEqual([
      { kind: 'text', text: 'bold', style: 'bold' },
      { kind: 'text', text: ' ' },
      { kind: 'text', text: 'it', style: 'italic' },
      { kind: 'text', text: ' ' },
      { kind: 'text', text: 'gone', style: 'strike' },
      { kind: 'text', text: ' ' },
      { kind: 'text', text: 'x=1', style: 'code' },
    ]);
  });

  it('parses emoji shortcodes but not clock times or snake_case', () => {
    expect(tokenize('ship it :tada: at 10:30:45 for my_var_name')).toEqual([
      { kind: 'text', text: 'ship it ' },
      { kind: 'emoji', name: 'tada' },
      { kind: 'text', text: ' at 10:30:45 for my_var_name' },
    ]);
  });

  it('parses code blocks and newlines', () => {
    expect(tokenize('look:\n```const x = 1;\nreturn x;```')).toEqual([
      { kind: 'text', text: 'look:' },
      { kind: 'newline' },
      { kind: 'codeblock', text: 'const x = 1;\nreturn x;' },
    ]);
  });

  it('unescapes slack HTML entities', () => {
    expect(tokenize('a &lt;tag&gt; &amp; more')).toEqual([
      { kind: 'text', text: 'a <tag> & more' },
    ]);
  });

  it('parses date fallbacks as text', () => {
    expect(tokenize('<!date^1700000000^{date}|Nov 14 2023>')).toEqual([
      { kind: 'text', text: 'Nov 14 2023' },
    ]);
  });
});
