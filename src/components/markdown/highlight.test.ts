import { classToColor, highlightLines, plainLines } from '@/components/markdown/highlight';
import type { HastElement, HastNode, HastRoot, HighlightSpan } from '@/components/markdown/highlight';

function tx(value: string): HastNode {
  return { type: 'text', value };
}

function el(className: string, ...children: HastNode[]): HastElement {
  return { type: 'element', tagName: 'span', properties: { className: className.split(' ') }, children };
}

function root(...children: HastNode[]): HastRoot {
  return { type: 'root', children };
}

/** Lines rendered as `colour:text` pairs, which reads far better in a failure. */
function shape(lines: HighlightSpan[][]): string[][] {
  return lines.map((line) => line.map((span) => `${span.color}:${span.text}`));
}

describe('classToColor', () => {
  it('is plain for an unclassified span', () => {
    expect(classToColor([])).toBe('plain');
    expect(classToColor(['token'])).toBe('plain');
  });

  it('ignores the structural classes Prism puts on everything', () => {
    expect(classToColor(['token', 'keyword'])).toBe('keyword');
    expect(classToColor(['token', 'language-css', 'string'])).toBe('string');
  });

  it('is plain for a token class it has no colour for', () => {
    expect(classToColor(['token', 'some-future-prism-class'])).toBe('plain');
  });

  it('lets the last recognised class win', () => {
    // Prism emits general before specific: `token template-punctuation string`
    // should read as a string, not as unclassified punctuation.
    expect(classToColor(['token', 'template-punctuation', 'string'])).toBe('string');
    expect(classToColor(['token', 'interpolation-punctuation', 'punctuation'])).toBe('punctuation');
  });

  it.each([
    [['token', 'comment'], 'comment'],
    [['token', 'keyword'], 'keyword'],
    [['token', 'string'], 'string'],
    [['token', 'number'], 'number'],
    [['token', 'boolean'], 'number'],
    [['token', 'function'], 'function'],
    [['token', 'class-name'], 'type'],
    [['token', 'builtin'], 'type'],
    [['token', 'operator'], 'operator'],
    [['token', 'punctuation'], 'punctuation'],
    [['token', 'property'], 'variable'],
    [['token', 'deleted'], 'deleted'],
    [['token', 'inserted'], 'inserted'],
  ])('maps %p to %s', (classNames, expected) => {
    expect(classToColor(classNames)).toBe(expected);
  });

  it('accepts a className given as a string', () => {
    const node = { type: 'element' as const, tagName: 'span', properties: { className: 'token keyword' }, children: [tx('if')] };
    expect(shape(highlightLines(root(node)))).toEqual([['keyword:if']]);
  });
});

describe('highlightLines', () => {
  it('returns one empty line for an empty tree', () => {
    expect(highlightLines(root())).toEqual([[]]);
  });

  it('colours a flat sequence of tokens', () => {
    const tree = root(el('token keyword', tx('const')), tx(' a = '), el('token number', tx('1')));
    expect(shape(highlightLines(tree))).toEqual([['keyword:const', 'plain: a = ', 'number:1']]);
  });

  it('splits on newlines into separate lines', () => {
    const tree = root(el('token keyword', tx('if')), tx(' x:\n  '), el('token keyword', tx('pass')));
    expect(shape(highlightLines(tree))).toEqual([
      ['keyword:if', 'plain: x:'],
      ['plain:  ', 'keyword:pass'],
    ]);
  });

  it('keeps a token colour on both sides of a line break', () => {
    // A block comment is one Prism token containing a newline. Splitting text
    // before walking would lose the colour on the second line.
    const tree = root(el('token comment', tx('/* one\n   two */')));
    expect(shape(highlightLines(tree))).toEqual([['comment:/* one'], ['comment:   two */']]);
  });

  it('produces an empty array for a blank line', () => {
    expect(shape(highlightLines(root(tx('a\n\nb'))))).toEqual([['plain:a'], [], ['plain:b']]);
  });

  it('preserves a trailing newline as a final empty line', () => {
    expect(highlightLines(root(tx('a\n')))).toHaveLength(2);
  });

  it('merges adjacent spans of the same colour', () => {
    // Thousands of one-character spans is the difference between a code block
    // that scrolls and one that does not.
    const tree = root(el('token punctuation', tx('(')), el('token punctuation', tx(')')), tx('x'));
    expect(shape(highlightLines(tree))).toEqual([['punctuation:()', 'plain:x']]);
  });

  it('does not merge across a line break', () => {
    const tree = root(el('token string', tx('a\nb')));
    expect(shape(highlightLines(tree))).toEqual([['string:a'], ['string:b']]);
  });

  it('inherits a parent colour through an unclassified wrapper', () => {
    const tree = root(el('token string', el('token', tx('inner'))));
    expect(shape(highlightLines(tree))).toEqual([['string:inner']]);
  });

  it('resets to plain inside a template interpolation', () => {
    // `${a}` is an expression, not more string.
    const tree = root(
      el(
        'token template-string',
        el('token string', tx('x')),
        el('token interpolation', el('token interpolation-punctuation punctuation', tx('${')), tx('a')),
      ),
    );
    expect(shape(highlightLines(tree))).toEqual([['string:x', 'punctuation:${', 'plain:a']]);
  });

  it('walks a nested root without losing children', () => {
    const tree = root(root(el('token keyword', tx('a'))) as HastNode);
    expect(shape(highlightLines(tree))).toEqual([['keyword:a']]);
  });

  it('ignores node types it does not know', () => {
    const tree = root({ type: 'comment' }, el('token keyword', tx('a')));
    expect(shape(highlightLines(tree))).toEqual([['keyword:a']]);
  });

  it('handles a real refractor tree for a TypeScript function', () => {
    // Captured from refractor 5 for:
    //   function f(a: string) {\n  /* one\n     two */\n  return `x${a}y`;\n}
    const tree = root(
      el('token keyword', tx('function')),
      tx(' '),
      el('token function', tx('f')),
      el('token punctuation', tx('(')),
      tx('a'),
      el('token operator', tx(':')),
      tx(' '),
      el('token builtin', tx('string')),
      el('token punctuation', tx(')')),
      tx(' '),
      el('token punctuation', tx('{')),
      tx('\n  '),
      el('token comment', tx('/* one\n     two */')),
      tx('\n  '),
      el('token keyword', tx('return')),
      tx(' '),
      el(
        'token template-string',
        el('token template-punctuation string', tx('`')),
        el('token string', tx('x')),
        el(
          'token interpolation',
          el('token interpolation-punctuation punctuation', tx('${')),
          tx('a'),
          el('token interpolation-punctuation punctuation', tx('}')),
        ),
        el('token string', tx('y')),
        el('token template-punctuation string', tx('`')),
      ),
      el('token punctuation', tx(';')),
      tx('\n'),
      el('token punctuation', tx('}')),
    );

    expect(shape(highlightLines(tree))).toEqual([
      ['keyword:function', 'plain: ', 'function:f', 'punctuation:(', 'plain:a', 'operator::', 'plain: ', 'type:string', 'punctuation:)', 'plain: ', 'punctuation:{'],
      ['plain:  ', 'comment:/* one'],
      ['comment:     two */'],
      ['plain:  ', 'keyword:return', 'plain: ', 'string:`x', 'punctuation:${', 'plain:a', 'punctuation:}', 'string:y`', 'punctuation:;'],
      ['punctuation:}'],
    ]);
  });
});

describe('plainLines', () => {
  it('splits source into lines with no colour', () => {
    expect(shape(plainLines('a\nb'))).toEqual([['plain:a'], ['plain:b']]);
  });

  it('produces an empty array for a blank line', () => {
    expect(plainLines('a\n\nb')[1]).toEqual([]);
  });

  it('agrees with highlightLines on the number of lines', () => {
    const code = 'a\n\nb\nc\n';
    expect(plainLines(code)).toHaveLength(highlightLines(root({ type: 'text', value: code })).length);
  });
});
