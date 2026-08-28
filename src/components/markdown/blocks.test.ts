import { inlineText, parseMarkdown } from '@/components/markdown/blocks';
import type { InlineToken, MdBlock } from '@/components/markdown/blocks';

/** The first block, asserted to be of a given kind so the test can index into it. */
function only<K extends MdBlock['kind']>(source: string, kind: K): Extract<MdBlock, { kind: K }> {
  const blocks = parseMarkdown(source);
  expect(blocks).toHaveLength(1);
  const block = blocks[0];
  expect(block?.kind).toBe(kind);
  return block as Extract<MdBlock, { kind: K }>;
}

function kinds(tokens: readonly InlineToken[]): string[] {
  return tokens.map((token) => token.kind);
}

describe('parseMarkdown — structure', () => {
  it('returns nothing for empty or whitespace-only input', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   \n\n  ')).toEqual([]);
  });

  it('parses a paragraph', () => {
    const block = only('Hello there.', 'paragraph');
    expect(block.tokens).toEqual([{ kind: 'text', text: 'Hello there.' }]);
  });

  it('parses headings and clamps the level', () => {
    expect(only('# One', 'heading').level).toBe(1);
    expect(only('###### Six', 'heading').level).toBe(6);
  });

  it('parses a horizontal rule', () => {
    expect(only('---', 'rule').kind).toBe('rule');
  });

  it('keeps blocks in source order', () => {
    const blocks = parseMarkdown('# Title\n\nBody.\n\n```\ncode\n```');
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'code']);
  });
});

describe('parseMarkdown — code', () => {
  it('captures the language, lowercased and without extra info', () => {
    const block = only('```TypeScript title=x\nconst a = 1\n```', 'code');
    expect(block.lang).toBe('typescript');
    expect(block.code).toBe('const a = 1');
  });

  it('omits the language when the fence has none', () => {
    expect(only('```\nplain\n```', 'code').lang).toBeUndefined();
  });

  it('treats an unterminated fence as a code block', () => {
    // This is the streaming case: the closing fence has not arrived yet, and a
    // block that renders as backtick soup until it does would flicker on every
    // token.
    const blocks = parseMarkdown('Here:\n\n```py\nimport os\nprint(');
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'code']);
    const code = blocks[1] as Extract<MdBlock, { kind: 'code' }>;
    expect(code.lang).toBe('py');
    expect(code.code).toContain('import os');
  });

  it('preserves indentation and blank lines inside a fence', () => {
    const block = only('```\nif x:\n\n    y()\n```', 'code');
    expect(block.code).toBe('if x:\n\n    y()');
  });

  it('shows raw HTML as a code block rather than dropping it', () => {
    const block = only('<div class="x">hi</div>', 'code');
    expect(block.lang).toBe('html');
    expect(block.code).toContain('<div');
  });
});

describe('parseMarkdown — inline', () => {
  it('parses the full inline vocabulary', () => {
    const block = only('a **b** _c_ ~~d~~ `e` [f](https://g) ![h](i.png)', 'paragraph');
    expect(kinds(block.tokens)).toEqual([
      'text',
      'strong',
      'text',
      'em',
      'text',
      'del',
      'text',
      'code',
      'text',
      'link',
      'text',
      'image',
    ]);
  });

  it('keeps a link href and its label tokens', () => {
    const block = only('see [the **docs**](https://example.com/a?b=1)', 'paragraph');
    const link = block.tokens[1];
    expect(link).toMatchObject({ kind: 'link', href: 'https://example.com/a?b=1' });
    expect(kinds((link as Extract<InlineToken, { kind: 'link' }>).tokens)).toEqual(['text', 'strong']);
  });

  it('keeps an image alt text', () => {
    const block = only('![a diagram](x.png)', 'paragraph');
    expect(block.tokens[0]).toEqual({ kind: 'image', href: 'x.png', alt: 'a diagram' });
  });

  it('turns a hard break into a break token', () => {
    // `breaks: true`, so a single newline inside a paragraph is a real break.
    const block = only('one\ntwo', 'paragraph');
    expect(kinds(block.tokens)).toEqual(['text', 'break', 'text']);
  });

  it('decodes the entities marked escapes for HTML output', () => {
    // These would otherwise reach the user as literal `&lt;`, which reads as a
    // rendering bug rather than as markdown.
    const block = only('use <T> & "quotes" and \'apostrophes\'', 'paragraph');
    expect(inlineText(block.tokens)).toBe('use <T> & "quotes" and \'apostrophes\'');
  });

  it('decodes entities inside inline code', () => {
    const block = only('`Array<T> & U`', 'paragraph');
    expect(block.tokens[0]).toEqual({ kind: 'code', text: 'Array<T> & U' });
  });
});

describe('parseMarkdown — lists', () => {
  it('parses an ordered list with its start number', () => {
    const block = only('3. three\n4. four', 'list');
    expect(block.ordered).toBe(true);
    expect(block.start).toBe(3);
    expect(block.items).toHaveLength(2);
  });

  it('defaults the start of an unordered list to 1', () => {
    const block = only('- a\n- b', 'list');
    expect(block.ordered).toBe(false);
    expect(block.start).toBe(1);
  });

  it('records the checked state of task items and nothing else', () => {
    const block = only('- [ ] todo\n- [x] done\n- plain', 'list');
    expect(block.items[0]?.checked).toBe(false);
    expect(block.items[1]?.checked).toBe(true);
    expect(block.items[2]).not.toHaveProperty('checked');
  });

  it('parses nested blocks inside an item', () => {
    const block = only('- text\n\n  ```js\n  a\n  ```', 'list');
    expect(block.items[0]?.blocks.map((b) => b.kind)).toEqual(['paragraph', 'code']);
  });

  it('parses a nested list as a block of its parent item', () => {
    const block = only('- outer\n  - inner', 'list');
    const nested = block.items[0]?.blocks.find((b) => b.kind === 'list');
    expect(nested).toBeDefined();
  });
});

describe('parseMarkdown — tables', () => {
  it('parses header, rows and alignment', () => {
    const block = only('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |', 'table');
    expect(block.align).toEqual(['left', 'center', 'right']);
    expect(block.head.map(inlineText)).toEqual(['a', 'b', 'c']);
    expect(block.rows).toHaveLength(2);
    expect(block.rows[1]?.map(inlineText)).toEqual(['4', '5', '6']);
  });

  it('records an unaligned column as null rather than guessing', () => {
    const block = only('| a |\n|---|\n| 1 |', 'table');
    expect(block.align).toEqual([null]);
  });

  it('keeps inline formatting inside cells', () => {
    const block = only('| a |\n|---|\n| `x` |', 'table');
    expect(kinds(block.rows[0]?.[0] ?? [])).toEqual(['code']);
  });
});

describe('parseMarkdown — quotes', () => {
  it('parses nested blocks inside a quote', () => {
    const block = only('> quoted\n>\n> ```\n> code\n> ```', 'quote');
    expect(block.blocks.map((b) => b.kind)).toEqual(['paragraph', 'code']);
  });

  it('parses a quote inside a quote', () => {
    const block = only('> outer\n>\n> > inner', 'quote');
    expect(block.blocks.some((b) => b.kind === 'quote')).toBe(true);
  });
});

describe('parseMarkdown — math', () => {
  it('parses $$…$$ as its own block', () => {
    const block = only('$$\n\\int_0^1 x\\,dx\n$$', 'math');
    expect(block.latex).toBe('\\int_0^1 x\\,dx');
  });

  it('parses \\[…\\] as a block', () => {
    expect(only('\\[a = b\\]', 'math').latex).toBe('a = b');
  });

  it('parses $…$ inline', () => {
    const block = only('the value $x^2$ is positive', 'paragraph');
    expect(kinds(block.tokens)).toEqual(['text', 'math', 'text']);
    expect(block.tokens[1]).toEqual({ kind: 'math', latex: 'x^2' });
  });

  it('parses \\(…\\) inline', () => {
    const block = only('so \\(n > 0\\) holds', 'paragraph');
    expect(block.tokens[1]).toEqual({ kind: 'math', latex: 'n > 0' });
  });

  it('leaves subscripts alone instead of reading them as emphasis', () => {
    // `$x_1 + x_2$` through a plain markdown parser becomes `x<em>1 + x</em>2`,
    // which is why math is tokenised before inline parsing.
    const block = only('$x_1 + x_2$', 'paragraph');
    expect(block.tokens).toEqual([{ kind: 'math', latex: 'x_1 + x_2' }]);
  });

  it('does not treat currency as math', () => {
    const block = only('it costs $5 and $10 total', 'paragraph');
    expect(kinds(block.tokens)).toEqual(['text']);
    expect(inlineText(block.tokens)).toBe('it costs $5 and $10 total');
  });

  it('does not match across a blank-space delimiter', () => {
    const block = only('a $ b $ c', 'paragraph');
    expect(kinds(block.tokens)).toEqual(['text']);
  });

  it('handles two inline expressions in one paragraph', () => {
    const block = only('$a$ and $b$', 'paragraph');
    expect(kinds(block.tokens)).toEqual(['math', 'text', 'math']);
  });

  it('keeps escaped dollars inside an expression', () => {
    const block = only('$\\$x$', 'paragraph');
    expect(block.tokens[0]).toEqual({ kind: 'math', latex: '\\$x' });
  });

  it('does not read a fenced block as math', () => {
    const block = only('```\n$$a$$\n```', 'code');
    expect(block.code).toBe('$$a$$');
  });
});

describe('inlineText', () => {
  it('flattens nested styling', () => {
    const block = only('**bold _and italic_** plain', 'paragraph');
    expect(inlineText(block.tokens)).toBe('bold and italic plain');
  });

  it('renders a break as a space and math as its source', () => {
    const block = only('a\n$x$', 'paragraph');
    expect(inlineText(block.tokens)).toBe('a x');
  });

  it('uses a link label rather than its href', () => {
    const block = only('[label](https://example.com)', 'paragraph');
    expect(inlineText(block.tokens)).toBe('label');
  });
});

describe('parseMarkdown — streaming safety', () => {
  // Every prefix of a document is parsed on its own during streaming, so none of
  // them may throw. A crash here takes the whole transcript down mid-answer.
  const document = [
    '# Title',
    '',
    'Some **bold** text with $x^2$ math and a [link](https://a.b).',
    '',
    '| a | b |',
    '|---|--:|',
    '| 1 | 2 |',
    '',
    '> quoted',
    '',
    '- [ ] one',
    '- [x] two',
    '',
    '```ts',
    'const a: number = 1;',
    '```',
    '',
    '$$',
    'e = mc^2',
    '$$',
  ].join('\n');

  it('parses every prefix without throwing', () => {
    for (let i = 0; i <= document.length; i += 1) {
      expect(() => parseMarkdown(document.slice(0, i))).not.toThrow();
    }
  });

  it('parses the finished document into the expected blocks', () => {
    expect(parseMarkdown(document).map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'table',
      'quote',
      'list',
      'code',
      'math',
    ]);
  });
});
