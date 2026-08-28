import { parseLatex } from '@/components/markdown/latex';
import type { MathNode } from '@/components/markdown/latex';

function body(source: string): MathNode {
  return parseLatex(source).body;
}

/** The top-level nodes, whether or not the parser collapsed them to one. */
function nodes(source: string): MathNode[] {
  const root = body(source);
  return root.kind === 'group' ? root.nodes : [root];
}

function kinds(source: string): string[] {
  return nodes(source).map((node) => node.kind);
}

/** The whole expression, asserted to be a single node of a given kind. */
function one<K extends MathNode['kind']>(source: string, kind: K): Extract<MathNode, { kind: K }> {
  const root = body(source);
  expect(root.kind).toBe(kind);
  return root as Extract<MathNode, { kind: K }>;
}

const IDENT_X: MathNode = { kind: 'ident', text: 'x' };

describe('parseLatex — structure', () => {
  it('returns an empty group for empty or whitespace-only input', () => {
    expect(parseLatex('')).toEqual({ body: { kind: 'group', nodes: [] }, degraded: false, source: '' });
    expect(body('   \n ')).toEqual({ kind: 'group', nodes: [] });
  });

  it('keeps the original source verbatim, untrimmed', () => {
    expect(parseLatex('  x  ').source).toBe('  x  ');
  });

  it('collapses a single node rather than wrapping it in a group', () => {
    expect(body('x')).toEqual(IDENT_X);
  });

  it('treats each letter as its own italic identifier', () => {
    // `ab` is a times b in TeX, not a two-letter name.
    expect(nodes('ab')).toEqual([{ kind: 'ident', text: 'a' }, { kind: 'ident', text: 'b' }]);
  });

  it('ignores whitespace between atoms', () => {
    expect(nodes('x + y')).toEqual(nodes('x+y'));
    expect(nodes('\\frac {a} {b}')).toEqual(nodes('\\frac{a}{b}'));
  });

  it('shows a stray closing brace rather than dropping it', () => {
    // Unbalanced braces are worth seeing: they are usually the model's mistake.
    expect(nodes('a}')).toEqual([{ kind: 'ident', text: 'a' }, { kind: 'punct', text: '}' }]);
  });

  it('drops style and size commands that carry no meaning here', () => {
    expect(body('\\displaystyle x')).toEqual(IDENT_X);
    expect(body('\\limits x')).toEqual(IDENT_X);
  });
});

describe('parseLatex — numbers and identifiers', () => {
  it('reads a digit run as one number', () => {
    expect(body('314')).toEqual({ kind: 'number', text: '314' });
  });

  it('reads a decimal', () => {
    expect(body('3.14')).toEqual({ kind: 'number', text: '3.14' });
    expect(body('.5')).toEqual({ kind: 'number', text: '.5' });
  });

  it('does not absorb a trailing dot into a number', () => {
    expect(nodes('1.')).toEqual([{ kind: 'number', text: '1' }, { kind: 'punct', text: '.' }]);
  });
});

describe('parseLatex — operators', () => {
  it('renders a hyphen as a real minus sign', () => {
    // U+2212. A hyphen-minus is visibly too short beside digits.
    expect(body('-')).toEqual({ kind: 'op', text: '−' });
  });

  it('marks relations so they can be spaced wider than binary operators', () => {
    expect(nodes('a=b')[1]).toEqual({ kind: 'op', text: '=', rel: true });
    expect(body('\\leq')).toEqual({ kind: 'op', text: '≤', rel: true });
    expect(body('\\to')).toEqual({ kind: 'op', text: '→', rel: true });
  });

  it('leaves binary operators unmarked', () => {
    expect(body('\\times')).toEqual({ kind: 'op', text: '×' });
    expect(body('\\cdot')).toEqual({ kind: 'op', text: '⋅' });
    expect(body('+')).toEqual({ kind: 'op', text: '+' });
  });

  it('treats standalone symbols as ordinary upright atoms', () => {
    expect(body('\\infty')).toEqual({ kind: 'text', text: '∞' });
    expect(body('\\partial')).toEqual({ kind: 'text', text: '∂' });
  });

  it('passes unicode the model wrote directly straight through', () => {
    expect(body('≥')).toEqual({ kind: 'text', text: '≥' });
  });
});

describe('parseLatex — Greek', () => {
  it('maps lowercase Greek to italic identifiers, as TeX does', () => {
    expect(body('\\alpha')).toEqual({ kind: 'ident', text: 'α' });
    expect(body('\\theta')).toEqual({ kind: 'ident', text: 'θ' });
  });

  it('maps uppercase Greek to upright text, as TeX does', () => {
    expect(body('\\Omega')).toEqual({ kind: 'text', text: 'Ω' });
    expect(body('\\Sigma')).toEqual({ kind: 'text', text: 'Σ' });
  });

  it('distinguishes the variant forms', () => {
    expect(body('\\epsilon')).toEqual({ kind: 'ident', text: 'ϵ' });
    expect(body('\\varepsilon')).toEqual({ kind: 'ident', text: 'ε' });
    expect(body('\\phi')).toEqual({ kind: 'ident', text: 'ϕ' });
    expect(body('\\varphi')).toEqual({ kind: 'ident', text: 'φ' });
  });
});

describe('parseLatex — scripts', () => {
  it('attaches a superscript', () => {
    expect(body('x^2')).toEqual({ kind: 'scripted', base: IDENT_X, sup: { kind: 'number', text: '2' } });
  });

  it('attaches a subscript', () => {
    expect(body('x_1')).toEqual({ kind: 'scripted', base: IDENT_X, sub: { kind: 'number', text: '1' } });
  });

  it('fills both slots of one node, in either order', () => {
    const expected = {
      kind: 'scripted',
      base: IDENT_X,
      sup: { kind: 'number', text: '2' },
      sub: { kind: 'number', text: '1' },
    };
    expect(body('x^2_1')).toEqual(expected);
    expect(body('x_1^2')).toEqual(expected);
  });

  it('nests when the same slot is used twice', () => {
    expect(body('x^y^z')).toEqual({
      kind: 'scripted',
      base: { kind: 'scripted', base: IDENT_X, sup: { kind: 'ident', text: 'y' } },
      sup: { kind: 'ident', text: 'z' },
    });
  });

  it('takes a braced script whole', () => {
    const scripted = one('x^{n+1}', 'scripted');
    expect(scripted.sup).toEqual({
      kind: 'group',
      nodes: [{ kind: 'ident', text: 'n' }, { kind: 'op', text: '+' }, { kind: 'number', text: '1' }],
    });
  });

  it('takes a whole unbraced number as the script', () => {
    // A documented deviation from TeX, which would read this as x¹ followed by 2.
    // Nobody writes `2^10` meaning anything but 2¹⁰.
    expect(one('2^10', 'scripted').sup).toEqual({ kind: 'number', text: '10' });
  });

  it('attaches a script to a brace group', () => {
    const scripted = one('{a+b}^2', 'scripted');
    expect(scripted.base.kind).toBe('group');
  });

  it('uses an empty base when a script has nothing to attach to', () => {
    expect(one('^2', 'scripted').base).toEqual({ kind: 'group', nodes: [] });
  });

  it('turns primes into superscripts', () => {
    expect(one("f'", 'scripted').sup).toEqual({ kind: 'text', text: '′' });
    expect(one("f''", 'scripted').sup).toEqual({ kind: 'text', text: '″' });
    expect(one("f'''", 'scripted').sup).toEqual({ kind: 'text', text: '‴' });
  });

  it('attaches limits to a large operator', () => {
    const scripted = one('\\sum_{i=1}^{n}', 'scripted');
    expect(scripted.base).toEqual({ kind: 'bigop', text: '∑' });
    expect(scripted.sup).toEqual({ kind: 'ident', text: 'n' });
    expect(scripted.sub?.kind).toBe('group');
  });

  it('survives a script with no argument at all', () => {
    expect(() => parseLatex('x^')).not.toThrow();
    expect(one('x^', 'scripted').sup).toEqual({ kind: 'group', nodes: [] });
  });
});

describe('parseLatex — fractions and roots', () => {
  it('parses a fraction', () => {
    expect(body('\\frac{a}{b}')).toEqual({
      kind: 'frac',
      num: { kind: 'ident', text: 'a' },
      den: { kind: 'ident', text: 'b' },
    });
  });

  it('treats the sizing variants as the same fraction', () => {
    const plain = body('\\frac{1}{2}');
    expect(body('\\dfrac{1}{2}')).toEqual(plain);
    expect(body('\\tfrac{1}{2}')).toEqual(plain);
  });

  it('reads one token per unbraced argument', () => {
    // `\frac12` is a half. Taking the digit run would give twelve over nothing.
    expect(body('\\frac12')).toEqual({
      kind: 'frac',
      num: { kind: 'number', text: '1' },
      den: { kind: 'number', text: '2' },
    });
  });

  it('nests', () => {
    const outer = one('\\frac{\\frac{a}{b}}{c}', 'frac');
    expect(outer.num.kind).toBe('frac');
    expect(outer.den).toEqual({ kind: 'ident', text: 'c' });
  });

  it('leaves the denominator empty when the source stops early', () => {
    // The streaming case: the second argument has not arrived yet.
    expect(one('\\frac{a}', 'frac').den).toEqual({ kind: 'group', nodes: [] });
    expect(one('\\frac', 'frac').num).toEqual({ kind: 'group', nodes: [] });
  });

  it('parses a binomial as its own node', () => {
    expect(body('\\binom{n}{k}')).toEqual({
      kind: 'binom',
      top: { kind: 'ident', text: 'n' },
      bottom: { kind: 'ident', text: 'k' },
    });
  });

  it('parses a square root, with and without an index', () => {
    expect(body('\\sqrt{x}')).toEqual({ kind: 'root', radicand: IDENT_X });
    expect(body('\\sqrt[3]{x}')).toEqual({
      kind: 'root',
      radicand: IDENT_X,
      index: { kind: 'number', text: '3' },
    });
    expect(body('\\sqrt2')).toEqual({ kind: 'root', radicand: { kind: 'number', text: '2' } });
  });
});

describe('parseLatex — accents', () => {
  it('parses the narrow accents', () => {
    expect(body('\\hat{x}')).toEqual({ kind: 'accent', accent: 'hat', base: IDENT_X });
    expect(body('\\vec{v}')).toEqual({ kind: 'accent', accent: 'vec', base: { kind: 'ident', text: 'v' } });
    expect(body('\\ddot{x}')).toEqual({ kind: 'accent', accent: 'ddot', base: IDENT_X });
  });

  it('marks the wide accents, which span the whole base', () => {
    expect(body('\\overline{x}')).toEqual({ kind: 'accent', accent: 'bar', base: IDENT_X, wide: true });
    expect(body('\\widehat{x}')).toEqual({ kind: 'accent', accent: 'hat', base: IDENT_X, wide: true });
  });

  it('does not mark the narrow form of the same accent as wide', () => {
    expect(one('\\bar{x}', 'accent').wide).toBeUndefined();
  });
});

describe('parseLatex — text and fonts', () => {
  it('preserves whitespace inside \\text', () => {
    expect(body('\\text{hello world}')).toEqual({ kind: 'text', text: 'hello world' });
  });

  it('carries the font flag for the bold and monospace variants', () => {
    expect(body('\\mathbf{x}')).toEqual({ kind: 'text', text: 'x', bold: true });
    expect(body('\\texttt{f}')).toEqual({ kind: 'text', text: 'f', mono: true });
    expect(body('\\textit{a}')).toEqual({ kind: 'text', text: 'a', italic: true });
  });

  it('accepts a single-token argument without braces', () => {
    expect(body('\\mathrm d')).toEqual({ kind: 'text', text: 'd' });
  });

  it('unwraps nested braces and resolves escapes inside text', () => {
    expect(body('\\text{a{b}c}')).toEqual({ kind: 'text', text: 'abc' });
    expect(body('\\text{50\\%}')).toEqual({ kind: 'text', text: '50%' });
  });

  it('accepts an empty argument', () => {
    expect(body('\\text{}')).toEqual({ kind: 'text', text: '' });
  });

  it('maps blackboard and calligraphic letters to unicode', () => {
    expect(body('\\mathbb{R}')).toEqual({ kind: 'text', text: 'ℝ' });
    expect(body('\\mathbb{Z}')).toEqual({ kind: 'text', text: 'ℤ' });
    expect(body('\\mathcal{O}')).toEqual({ kind: 'text', text: '𝒪' });
    expect(body('\\mathcal{L}')).toEqual({ kind: 'text', text: 'ℒ' });
  });

  it('leaves unmapped characters alone rather than dropping them', () => {
    expect(body('\\mathbb{Zz}')).toEqual({ kind: 'text', text: 'ℤz' });
  });

  it('wraps a bolded or italicised sub-expression', () => {
    expect(body('\\boldsymbol{\\theta}')).toEqual({
      kind: 'style',
      body: { kind: 'ident', text: 'θ' },
      bold: true,
    });
    expect(body('\\mathit{x}')).toEqual({ kind: 'style', body: IDENT_X, italic: true });
  });

  it('renders named functions upright', () => {
    expect(nodes('\\sin x')).toEqual([{ kind: 'text', text: 'sin' }, IDENT_X]);
  });

  it('lets a named function take a subscript', () => {
    const scripted = one('\\log_2', 'scripted');
    expect(scripted.base).toEqual({ kind: 'text', text: 'log' });
    expect(scripted.sub).toEqual({ kind: 'number', text: '2' });
  });

  it('marks the word-shaped operators that take limits', () => {
    expect(body('\\lim')).toEqual({ kind: 'bigop', text: 'lim', word: true });
    expect(body('\\max')).toEqual({ kind: 'bigop', text: 'max', word: true });
    expect(body('\\argmax')).toEqual({ kind: 'bigop', text: 'argmax', word: true });
  });
});

describe('parseLatex — delimiters', () => {
  it('parses a \\left…\\right pair around its body', () => {
    const delimited = one('\\left(\\frac{a}{b}\\right)', 'delimited');
    expect(delimited.open).toBe('(');
    expect(delimited.close).toBe(')');
    expect(delimited.body.kind).toBe('frac');
  });

  it('reads named and escaped delimiters', () => {
    expect(one('\\left\\{x\\right\\}', 'delimited')).toMatchObject({ open: '{', close: '}' });
    expect(one('\\left\\langle x\\right\\rangle', 'delimited')).toMatchObject({ open: '⟨', close: '⟩' });
    expect(one('\\left\\|x\\right\\|', 'delimited')).toMatchObject({ open: '‖', close: '‖' });
  });

  it('treats \\left. as an invisible delimiter', () => {
    expect(one('\\left.\\frac{a}{b}\\right|', 'delimited')).toMatchObject({ open: '', close: '|' });
  });

  it('does not mistake \\rightarrow for the closing \\right', () => {
    // The prefix test alone is wrong, and getting it wrong ends the group early
    // and leaves the rest of the expression outside the parentheses.
    const delimited = one('\\left( x \\rightarrow y \\right)', 'delimited');
    expect(delimited.close).toBe(')');
    expect(delimited.body).toEqual({
      kind: 'group',
      nodes: [IDENT_X, { kind: 'op', text: '→', rel: true }, { kind: 'ident', text: 'y' }],
    });
  });

  it('renders an unterminated \\left with an empty closing delimiter', () => {
    // Streaming again: `\right` has not arrived. Falling the whole expression
    // back to source here would make it flicker on the next token.
    const delimited = one('\\left( x', 'delimited');
    expect(delimited).toMatchObject({ open: '(', close: '' });
    expect(parseLatex('\\left( x').degraded).toBe(false);
  });

  it('keeps the delimiter and drops the size for the \\big family', () => {
    expect(body('\\bigl(')).toEqual({ kind: 'punct', text: '(' });
    expect(body('\\Bigr]')).toEqual({ kind: 'punct', text: ']' });
  });

  it('falls back on a \\right with no \\left', () => {
    const expr = parseLatex('\\right)');
    expect(expr.body).toEqual({ kind: 'raw', latex: '\\right' });
    expect(expr.degraded).toBe(true);
  });
});

describe('parseLatex — spacing and escapes', () => {
  it('parses explicit spacing as an em width', () => {
    expect(body('\\,')).toEqual({ kind: 'space', em: 0.167 });
    expect(body('\\quad')).toEqual({ kind: 'space', em: 1 });
    expect(body('\\qquad')).toEqual({ kind: 'space', em: 2 });
    expect(body('~')).toEqual({ kind: 'space', em: 0.333 });
  });

  it('gives negative thin space a negative width', () => {
    expect(one('\\!', 'space').em).toBeLessThan(0);
  });

  it('parses a backslash-space between atoms', () => {
    expect(kinds('a\\ b')).toEqual(['ident', 'space', 'ident']);
  });

  it('resolves the literal escapes', () => {
    expect(body('\\%')).toEqual({ kind: 'text', text: '%' });
    expect(body('\\$')).toEqual({ kind: 'text', text: '$' });
    expect(body('\\_')).toEqual({ kind: 'text', text: '_' });
    expect(body('\\{')).toEqual({ kind: 'punct', text: '{' });
  });
});

describe('parseLatex — fallback', () => {
  it('shows a whole environment as source', () => {
    // Half a rendered matrix is worse than none: the reader cannot tell which
    // half is missing.
    const source = '\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}';
    const expr = parseLatex(source);
    expect(expr.body).toEqual({ kind: 'raw', latex: source });
    expect(expr.degraded).toBe(true);
  });

  it('shows an unknown command with its arguments', () => {
    const expr = parseLatex('\\substack{a}{b}');
    expect(expr.body).toEqual({ kind: 'raw', latex: '\\substack{a}{b}' });
    expect(expr.degraded).toBe(true);
  });

  it('takes bracket options into the fallback too', () => {
    expect(one('\\unknown[opt]{x}', 'raw').latex).toBe('\\unknown[opt]{x}');
  });

  it('shows a bare unknown command', () => {
    expect(one('\\foo', 'raw').latex).toBe('\\foo');
  });

  it('falls back on a row break, which only belongs in an environment', () => {
    expect(parseLatex('a \\\\ b').body).toEqual({ kind: 'raw', latex: 'a \\\\ b' });
  });

  it('falls back locally on an alignment marker without losing the rest', () => {
    const expr = parseLatex('a & b');
    expect(expr.degraded).toBe(true);
    expect(kinds('a & b')).toEqual(['ident', 'raw', 'ident']);
  });

  it('keeps the surrounding expression when only one command is unknown', () => {
    expect(kinds('x + \\nosuchthing + y')).toEqual(['ident', 'op', 'raw', 'op', 'ident']);
  });

  it('does not flag a fully renderable expression as degraded', () => {
    expect(parseLatex('\\frac{\\alpha^2}{\\sqrt{\\beta}} \\leq \\sum_{i=1}^{n} x_i').degraded).toBe(false);
  });

  it('falls back rather than overflowing the stack on deep nesting', () => {
    const deep = '\\frac{'.repeat(40) + 'x' + '}{y}'.repeat(40);
    const expr = parseLatex(deep);
    expect(expr.body.kind).toBe('raw');
    expect(expr.degraded).toBe(true);
  });

  it('falls back on source too long to render usefully', () => {
    const expr = parseLatex('x+'.repeat(3000));
    expect(expr.body.kind).toBe('raw');
    expect(expr.degraded).toBe(true);
  });

  it('does not confuse an inherited Object property for a command', () => {
    // `\constructor` is a syntactically valid command name, and a table lookup
    // that ignores own-property-ness hands back a function to put in the AST.
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'propertyIsEnumerable']) {
      const expr = parseLatex(`\\${name}`);
      expect(expr.body).toEqual({ kind: 'raw', latex: `\\${name}` });
    }
  });

  it('reads \\_ as the escape it is, before any command name', () => {
    // `\__proto__` is `\_` followed by ordinary math, because a command name is
    // letters only — so this never reaches a table at all. Asserted anyway: the
    // renderer must only ever see strings in a text field.
    const expr = parseLatex('\\__proto__');
    expect(nodes('\\__proto__')[0]).toMatchObject({ base: { kind: 'text', text: '_' } });
    expect(everyTextIsAString(expr.body)).toBe(true);
  });
});

/** No node carries a non-string where the renderer expects text. */
function everyTextIsAString(node: MathNode): boolean {
  for (const value of Object.values(node) as unknown[]) {
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') continue;
    if (Array.isArray(value)) {
      if (!value.every((child) => everyTextIsAString(child as MathNode))) return false;
      continue;
    }
    if (value === undefined) continue;
    if (typeof value !== 'object' || value === null) return false;
    if (!everyTextIsAString(value as MathNode)) return false;
  }
  return true;
}

describe('parseLatex — robustness', () => {
  const HOSTILE = [
    '\\',
    '\\\\',
    '{',
    '}',
    '{{{{',
    '}}}}',
    '^',
    '_',
    "'",
    '^_',
    '\\frac',
    '\\frac{',
    '\\frac{}{}',
    '\\sqrt[',
    '\\sqrt[]',
    '\\text{',
    '\\text',
    '\\left',
    '\\left(',
    '\\right',
    '\\begin',
    '\\begin{',
    '\\end{}',
    '\\mathbb',
    '\\mathbb{',
    '$',
    '$$',
    '&&&',
    '~~~',
    '\\,\\,\\,',
    '_^_^_^',
    '\\hat',
    '\\boldsymbol',
    '\\bigl',
    '\\left\\right',
    'x^{y^{z^{w',
    ' ',
    '中文',
    '\\text{中文}',
  ];

  it.each(HOSTILE)('never throws on %j', (source) => {
    expect(() => parseLatex(source)).not.toThrow();
    const expr = parseLatex(source);
    expect(expr.body).toBeDefined();
    expect(typeof expr.degraded).toBe('boolean');
  });

  it('parses every prefix of a streaming equation without throwing', () => {
    // The transcript re-parses the equation on every delta. A throw here takes
    // the whole answer down mid-stream, so this is the one that matters most.
    const full =
      '\\frac{\\sqrt{x^2+y^2}}{\\sum_{i=1}^{n} \\alpha_i} = ' +
      '\\left(\\hat{\\beta} \\cdot \\mathbb{R}^{n}\\right) \\text{ for } \\theta \\to \\infty';
    for (let i = 0; i <= full.length; i += 1) {
      const prefix = full.slice(0, i);
      expect(() => parseLatex(prefix)).not.toThrow();
      expect(parseLatex(prefix).body).toBeDefined();
    }
  });

  it('parses every prefix of an environment without throwing', () => {
    const full = '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}';
    for (let i = 0; i <= full.length; i += 1) {
      expect(() => parseLatex(full.slice(0, i))).not.toThrow();
    }
  });

  it('always terminates on a long run of unmatched openers', () => {
    // Guards the advance assertion in the sequence loop: any branch that failed
    // to consume a character would hang here rather than fail a test.
    expect(() => parseLatex('\\left('.repeat(200))).not.toThrow();
    expect(() => parseLatex('{'.repeat(500))).not.toThrow();
  });
});
