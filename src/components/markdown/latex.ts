/**
 * LaTeX → a small math AST, for rendering with React Native text and views.
 *
 * There is no KaTeX here and there should not be one. KaTeX needs a DOM and a
 * font loader; the alternatives on React Native are a WebView per equation,
 * which is a scroll-performance disaster in a transcript, or a native SVG
 * typesetter, which is a project of its own. So this covers the subset models
 * actually emit in chat — fractions, scripts, roots, Greek, operators, the
 * common named functions — and everything outside that subset falls back to the
 * raw LaTeX source, visibly, as a {@link MathNode} of kind `raw`.
 *
 * The fallback is the important part. A renderer that silently drops
 * `\begin{bmatrix}` shows the reader a confident wrong answer; one that shows
 * `\begin{bmatrix}…` shows them something they can copy into a tool that
 * handles it. {@link MathExpr.degraded} is set whenever any part fell back, so
 * the component can offer that copy affordance rather than pretending.
 *
 * Pure by design — no React Native imports, same as {@link ./blocks} and
 * {@link ./highlight}, so it runs in the fast `node` Jest environment. It is
 * also called on every prefix of a streaming equation, so it must never throw
 * and must never loop: see {@link MAX_DEPTH}, {@link MAX_SOURCE} and the
 * advance assertion in {@link parseSequence}.
 *
 * Deliberate deviations from real TeX, all in the direction of what the author
 * evidently meant:
 *
 * - `x^12` renders as x¹² rather than TeX's x¹2. A model that writes an
 *   unbraced multi-digit exponent means the whole number.
 * - Sizing commands (`\big`, `\dfrac` vs `\tfrac`) are parsed and discarded;
 *   one size of fraction is enough on a phone.
 * - `\left(…\right)` is kept as its own node so the component can scale the
 *   delimiters, but nothing else about TeX's stretchy-delimiter rules survives.
 */

/* -------------------------------------------------------------------------- */
/* The AST                                                                     */
/* -------------------------------------------------------------------------- */

export type AccentKind =
  | 'hat'
  | 'bar'
  | 'vec'
  | 'tilde'
  | 'dot'
  | 'ddot'
  | 'check'
  | 'acute'
  | 'grave'
  | 'breve'
  | 'ring';

/**
 * One piece of an expression.
 *
 * Every slot holds exactly one node. Several-nodes-in-a-row is expressed one
 * way only — a `group` — which means the renderer has a single recursive entry
 * point and the compiler can check its switch is exhaustive. {@link groupOf}
 * collapses a one-element group away, so the common shapes stay flat.
 */
export type MathNode =
  /** A variable. Rendered italic, as TeX does. */
  | { kind: 'ident'; text: string }
  | { kind: 'number'; text: string }
  /** Upright literal text: `\text{…}`, `\mathrm{…}`, named functions, uppercase Greek. Whitespace is significant. */
  | { kind: 'text'; text: string; bold?: true; italic?: true; mono?: true }
  /** A binary operator, or a relation when `rel` is set — relations get wider space around them. */
  | { kind: 'op'; text: string; rel?: true }
  | { kind: 'punct'; text: string }
  /** A large operator: `∑`, `∫`, or a word like `lim`. Takes its scripts above and below in display style. */
  | { kind: 'bigop'; text: string; word?: true }
  /** Explicit space, in em. Negative for `\!`. */
  | { kind: 'space'; em: number }
  | { kind: 'group'; nodes: MathNode[] }
  | { kind: 'style'; body: MathNode; bold?: true; italic?: true }
  | { kind: 'scripted'; base: MathNode; sup?: MathNode; sub?: MathNode }
  | { kind: 'frac'; num: MathNode; den: MathNode }
  /** `\binom` — stacked, parenthesised, no rule. */
  | { kind: 'binom'; top: MathNode; bottom: MathNode }
  | { kind: 'root'; radicand: MathNode; index?: MathNode }
  /** `wide` marks `\overline`/`\widehat`, which span the whole base rather than sitting over its centre. */
  | { kind: 'accent'; accent: AccentKind; base: MathNode; wide?: true }
  /** `\left…\right`. Either delimiter may be empty, from `\left.`. */
  | { kind: 'delimited'; open: string; close: string; body: MathNode }
  /** Unrenderable source, shown verbatim. */
  | { kind: 'raw'; latex: string };

export interface MathExpr {
  body: MathNode;
  /** True when any part of the source fell back to `raw`. */
  degraded: boolean;
  /** The original LaTeX, for copy-to-clipboard and the accessibility label. */
  source: string;
}

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Nesting cap before the whole expression falls back.
 *
 * `\frac{\frac{\frac{…` a few hundred deep is a stack overflow, and a stack
 * overflow here takes the transcript down mid-answer. Nothing legible on a
 * phone is nested deeper than this.
 */
const MAX_DEPTH = 32;

/** Source longer than this is not going to render usefully; show it as source. */
const MAX_SOURCE = 4000;

/* -------------------------------------------------------------------------- */
/* Symbol tables                                                               */
/* -------------------------------------------------------------------------- */

/** Lowercase Greek is italic in TeX, so it maps to `ident`. */
const GREEK_LOWER: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ϵ',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  omicron: 'ο',
  pi: 'π',
  varpi: 'ϖ',
  rho: 'ρ',
  varrho: 'ϱ',
  sigma: 'σ',
  varsigma: 'ς',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'ϕ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
};

/** Uppercase Greek is upright in TeX, so it maps to `text`. */
const GREEK_UPPER: Record<string, string> = {
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
};

/** Binary operators: thin space either side. */
const BINARY_OPS: Record<string, string> = {
  pm: '±',
  mp: '∓',
  times: '×',
  div: '÷',
  cdot: '⋅',
  ast: '∗',
  star: '⋆',
  circ: '∘',
  bullet: '∙',
  oplus: '⊕',
  ominus: '⊖',
  otimes: '⊗',
  oslash: '⊘',
  odot: '⊙',
  cap: '∩',
  cup: '∪',
  sqcap: '⊓',
  sqcup: '⊔',
  uplus: '⊎',
  setminus: '∖',
  smallsetminus: '∖',
  wedge: '∧',
  vee: '∨',
  land: '∧',
  lor: '∨',
  neg: '¬',
  lnot: '¬',
  triangleleft: '◁',
  triangleright: '▷',
  bigtriangleup: '△',
  amalg: '⨿',
  dagger: '†',
  ddagger: '‡',
  wr: '≀',
};

/** Relations and arrows: wider space either side. */
const RELATIONS: Record<string, string> = {
  leq: '≤',
  le: '≤',
  geq: '≥',
  ge: '≥',
  neq: '≠',
  ne: '≠',
  equiv: '≡',
  approx: '≈',
  approxeq: '≊',
  sim: '∼',
  simeq: '≃',
  cong: '≅',
  propto: '∝',
  ll: '≪',
  gg: '≫',
  lll: '⋘',
  ggg: '⋙',
  subset: '⊂',
  subseteq: '⊆',
  subsetneq: '⊊',
  supset: '⊃',
  supseteq: '⊇',
  supsetneq: '⊋',
  sqsubseteq: '⊑',
  sqsupseteq: '⊒',
  in: '∈',
  notin: '∉',
  ni: '∋',
  perp: '⊥',
  parallel: '∥',
  nparallel: '∦',
  mid: '∣',
  nmid: '∤',
  models: '⊨',
  vdash: '⊢',
  dashv: '⊣',
  prec: '≺',
  preceq: '⪯',
  succ: '≻',
  succeq: '⪰',
  doteq: '≐',
  asymp: '≍',
  bowtie: '⋈',
  lesssim: '≲',
  gtrsim: '≳',
  nless: '≮',
  ngtr: '≯',
  nleq: '≰',
  ngeq: '≱',
  nsubseteq: '⊈',
  ncong: '≇',
  nsim: '≁',
  triangleq: '≜',
  coloneq: '≔',

  to: '→',
  rightarrow: '→',
  Rightarrow: '⇒',
  leftarrow: '←',
  gets: '←',
  Leftarrow: '⇐',
  leftrightarrow: '↔',
  Leftrightarrow: '⇔',
  longrightarrow: '⟶',
  longleftarrow: '⟵',
  longleftrightarrow: '⟷',
  Longrightarrow: '⟹',
  Longleftarrow: '⟸',
  implies: '⟹',
  impliedby: '⟸',
  iff: '⟺',
  mapsto: '↦',
  longmapsto: '⟼',
  hookrightarrow: '↪',
  hookleftarrow: '↩',
  uparrow: '↑',
  downarrow: '↓',
  updownarrow: '↕',
  Uparrow: '⇑',
  Downarrow: '⇓',
  nearrow: '↗',
  searrow: '↘',
  swarrow: '↙',
  nwarrow: '↖',
  rightharpoonup: '⇀',
  leftharpoonup: '↼',
  rightleftharpoons: '⇌',
  nrightarrow: '↛',
  leadsto: '⇝',
};

/** Standalone symbols. Ordinary atoms — no operator spacing. */
const SYMBOLS: Record<string, string> = {
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  forall: '∀',
  exists: '∃',
  nexists: '∄',
  emptyset: '∅',
  varnothing: '∅',
  aleph: 'ℵ',
  beth: 'ℶ',
  hbar: 'ℏ',
  hslash: 'ℏ',
  ell: 'ℓ',
  Re: 'ℜ',
  Im: 'ℑ',
  wp: '℘',
  prime: '′',
  degree: '°',
  angle: '∠',
  measuredangle: '∡',
  triangle: '△',
  square: '□',
  blacksquare: '■',
  diamond: '⋄',
  Diamond: '◇',
  flat: '♭',
  sharp: '♯',
  natural: '♮',
  clubsuit: '♣',
  diamondsuit: '♢',
  heartsuit: '♡',
  spadesuit: '♠',
  surd: '√',
  top: '⊤',
  bot: '⊥',
  therefore: '∴',
  because: '∵',
  checkmark: '✓',
  dots: '…',
  ldots: '…',
  cdots: '⋯',
  vdots: '⋮',
  ddots: '⋱',
  dotsc: '…',
  dotsb: '⋯',
  imath: 'ı',
  jmath: 'ȷ',
  circledR: '®',
  copyright: '©',
  pounds: '£',
  euro: '€',
  S: '§',
  P: '¶',
};

/** Large operators. Scripts go above and below in display style. */
const BIG_OPS: Record<string, string> = {
  sum: '∑',
  prod: '∏',
  coprod: '∐',
  int: '∫',
  iint: '∬',
  iiint: '∭',
  oint: '∮',
  oiint: '∯',
  bigcup: '⋃',
  bigcap: '⋂',
  bigsqcup: '⨆',
  bigvee: '⋁',
  bigwedge: '⋀',
  bigoplus: '⨁',
  bigotimes: '⨂',
  bigodot: '⨀',
  biguplus: '⨄',
};

/**
 * Word-shaped large operators — upright, and they take limits.
 *
 * `argmax`/`argmin` are not real LaTeX (they want `\operatorname*`), but models
 * write them constantly and rendering the word beats rendering the source.
 */
const BIG_WORDS = new Set([
  'lim',
  'limsup',
  'liminf',
  'max',
  'min',
  'sup',
  'inf',
  'gcd',
  'lcm',
  'argmax',
  'argmin',
  'Pr',
  'det',
]);

/** Named functions: upright, no limits. `\log_2 x` still works — the script attaches as a subscript. */
const FUNCTIONS = new Set([
  'sin',
  'cos',
  'tan',
  'cot',
  'sec',
  'csc',
  'arcsin',
  'arccos',
  'arctan',
  'arccot',
  'sinh',
  'cosh',
  'tanh',
  'coth',
  'sech',
  'csch',
  'log',
  'ln',
  'lg',
  'exp',
  'dim',
  'ker',
  'deg',
  'arg',
  'hom',
  'tr',
  'rank',
  'diag',
  'sgn',
  'erf',
  'mod',
  'bmod',
  'pmod',
]);

const ACCENTS: Record<string, { accent: AccentKind; wide?: true }> = {
  hat: { accent: 'hat' },
  widehat: { accent: 'hat', wide: true },
  bar: { accent: 'bar' },
  overline: { accent: 'bar', wide: true },
  vec: { accent: 'vec' },
  overrightarrow: { accent: 'vec', wide: true },
  tilde: { accent: 'tilde' },
  widetilde: { accent: 'tilde', wide: true },
  dot: { accent: 'dot' },
  ddot: { accent: 'ddot' },
  check: { accent: 'check' },
  acute: { accent: 'acute' },
  grave: { accent: 'grave' },
  breve: { accent: 'breve' },
  mathring: { accent: 'ring' },
};

/** Commands whose argument is read as literal text rather than parsed as math. */
const TEXT_COMMANDS: Record<string, { bold?: true; italic?: true; mono?: true }> = {
  text: {},
  textrm: {},
  textnormal: {},
  mathrm: {},
  operatorname: {},
  textbf: { bold: true },
  mathbf: { bold: true },
  textit: { italic: true },
  texttt: { mono: true },
  mathtt: { mono: true },
  textsf: {},
  mathsf: {},
  mbox: {},
};

/** Explicit spacing, in em. */
const SPACES: Record<string, number> = {
  ',': 0.167,
  thinspace: 0.167,
  ':': 0.222,
  ';': 0.278,
  thickspace: 0.278,
  '!': -0.167,
  negthinspace: -0.167,
  ' ': 0.333,
  enspace: 0.5,
  quad: 1,
  qquad: 2,
};

/** Escapes that stand for themselves. */
const LITERAL_ESCAPES: Record<string, string> = {
  '{': '{',
  '}': '}',
  $: '$',
  '%': '%',
  '&': '&',
  '#': '#',
  _: '_',
  '^': '^',
};

const BLACKBOARD: Record<string, string> = {
  A: '𝔸',
  B: '𝔹',
  C: 'ℂ',
  D: '𝔻',
  E: '𝔼',
  F: '𝔽',
  G: '𝔾',
  H: 'ℍ',
  I: '𝕀',
  J: '𝕁',
  K: '𝕂',
  L: '𝕃',
  M: '𝕄',
  N: 'ℕ',
  O: '𝕆',
  P: 'ℙ',
  Q: 'ℚ',
  R: 'ℝ',
  S: '𝕊',
  T: '𝕋',
  U: '𝕌',
  V: '𝕍',
  W: '𝕎',
  X: '𝕏',
  Y: '𝕐',
  Z: 'ℤ',
  '1': '𝟙',
};

const CALLIGRAPHIC: Record<string, string> = {
  A: '𝒜',
  B: 'ℬ',
  C: '𝒞',
  D: '𝒟',
  E: 'ℰ',
  F: 'ℱ',
  G: '𝒢',
  H: 'ℋ',
  I: 'ℐ',
  J: '𝒥',
  K: '𝒦',
  L: 'ℒ',
  M: 'ℳ',
  N: '𝒩',
  O: '𝒪',
  P: '𝒫',
  Q: '𝒬',
  R: 'ℛ',
  S: '𝒮',
  T: '𝒯',
  U: '𝒰',
  V: '𝒱',
  W: '𝒲',
  X: '𝒳',
  Y: '𝒴',
  Z: '𝒵',
};

/** Named delimiters usable after `\left`, `\right` and the `\big` family. */
const DELIMITERS: Record<string, string> = {
  '(': '(',
  ')': ')',
  '[': '[',
  ']': ']',
  '|': '|',
  '/': '/',
  '<': '⟨',
  '>': '⟩',
  '.': '',
  lbrace: '{',
  rbrace: '}',
  '\\{': '{',
  '\\}': '}',
  lbrack: '[',
  rbrack: ']',
  langle: '⟨',
  rangle: '⟩',
  lvert: '|',
  rvert: '|',
  vert: '|',
  lVert: '‖',
  rVert: '‖',
  Vert: '‖',
  '\\|': '‖',
  lceil: '⌈',
  rceil: '⌉',
  lfloor: '⌊',
  rfloor: '⌋',
  uparrow: '↑',
  downarrow: '↓',
  backslash: '\\',
};

/** Sizing prefixes. Parsed so the delimiter after them survives; the size is dropped. */
const SIZE_PREFIXES = new Set([
  'big',
  'Big',
  'bigg',
  'Bigg',
  'bigl',
  'Bigl',
  'biggl',
  'Biggl',
  'bigr',
  'Bigr',
  'biggr',
  'Biggr',
  'bigm',
  'Bigm',
  'middle',
]);

/** Commands that change size or style and can simply be dropped. */
const IGNORED = new Set([
  'displaystyle',
  'textstyle',
  'scriptstyle',
  'scriptscriptstyle',
  'limits',
  'nolimits',
  'mathopen',
  'mathclose',
  'mathord',
  'mathbin',
  'mathrel',
  'mathpunct',
  'mathinner',
  'nobreak',
  'allowbreak',
  'relax',
  'small',
  'normalsize',
  'large',
  'Large',
]);

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/** Thrown internally to abandon a parse and show the whole expression as source. */
class Unrenderable extends Error {}

/**
 * Own-property table lookup.
 *
 * The tables above are object literals, so they inherit from `Object.prototype`
 * — and `\constructor` is a syntactically valid command name. A plain
 * `TABLE[name]` would hand back `Object`'s constructor function and put it in the
 * AST as a `text` node. Garbled streams produce exactly this sort of thing.
 */
function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

interface Cursor {
  src: string;
  i: number;
  depth: number;
  degraded: boolean;
}

/**
 * Parses a LaTeX fragment.
 *
 * Never throws. Safe on a partial expression — an unclosed `\frac{a` yields a
 * fraction with an empty denominator, which is what a streaming equation should
 * look like a few tokens before it is finished.
 */
export function parseLatex(source: string): MathExpr {
  const trimmed = source.trim();
  if (!trimmed) return { body: { kind: 'group', nodes: [] }, degraded: false, source };
  if (trimmed.length > MAX_SOURCE) {
    return { body: { kind: 'raw', latex: trimmed }, degraded: true, source };
  }

  const cursor: Cursor = { src: trimmed, i: 0, depth: 0, degraded: false };
  try {
    const body = groupOf(parseSequence(cursor, 'top'));
    return { body, degraded: cursor.degraded, source };
  } catch {
    // Either an environment we don't typeset, or nesting past MAX_DEPTH. Both
    // mean the same thing to the reader: here is the source, deal with it as you
    // see fit. Catching everything rather than just Unrenderable is deliberate —
    // a bug in this parser must not take the transcript down.
    return { body: { kind: 'raw', latex: trimmed }, degraded: true, source };
  }
}

/** Wraps a node list as a single node, collapsing the one-element case. */
function groupOf(nodes: MathNode[]): MathNode {
  if (nodes.length === 1) return nodes[0] as MathNode;
  return { kind: 'group', nodes };
}

/* -------------------------------------------------------------------------- */
/* Sequences                                                                   */
/* -------------------------------------------------------------------------- */

type SeqMode = 'top' | 'brace' | 'right';

/**
 * Parses nodes until the mode's terminator.
 *
 * `brace` consumes its closing `}`; `right` stops with `\right` unconsumed so
 * the caller can read the closing delimiter.
 */
function parseSequence(c: Cursor, mode: SeqMode): MathNode[] {
  if (c.depth > MAX_DEPTH) throw new Unrenderable();
  c.depth += 1;
  const out: MathNode[] = [];

  for (;;) {
    skipWhitespace(c);
    if (c.i >= c.src.length) break;

    const before = c.i;
    const ch = c.src[c.i] as string;

    if (ch === '}') {
      if (mode === 'brace') {
        c.i += 1;
        break;
      }
      // A stray close brace. Showing it beats dropping it: it is usually a sign
      // the model's braces are unbalanced, and the reader can see that.
      c.i += 1;
      out.push({ kind: 'punct', text: '}' });
    } else if (mode === 'right' && atRight(c)) {
      break;
    } else if (ch === '^' || ch === '_' || ch === "'") {
      attachScript(c, out);
    } else {
      const atom = parseAtom(c);
      if (atom) out.push(atom);
    }

    // Every branch above must consume at least one character. If one ever fails
    // to, this turns a hung render into a visible fallback.
    if (c.i === before) throw new Unrenderable();
  }

  c.depth -= 1;
  return out;
}

function skipWhitespace(c: Cursor): void {
  while (c.i < c.src.length) {
    const ch = c.src[c.i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') c.i += 1;
    else break;
  }
}

function startsWith(c: Cursor, text: string): boolean {
  return c.src.startsWith(text, c.i);
}

/**
 * Is the cursor on a `\right` that closes a `\left`?
 *
 * A prefix test alone is wrong: `\rightarrow` also starts with `\right`, so
 * `\left( x \rightarrow y \right)` would end its group at the arrow. The
 * following character must not be a letter — and at end of input there is no
 * following character, which counts as a match so a truncated stream still
 * closes.
 */
function atRight(c: Cursor): boolean {
  if (!startsWith(c, '\\right')) return false;
  return !LETTERS.test(c.src[c.i + '\\right'.length] ?? '');
}

/* -------------------------------------------------------------------------- */
/* Scripts                                                                     */
/* -------------------------------------------------------------------------- */

const PRIMES = ['', '′', '″', '‴', '⁗'];

/**
 * Consumes `^`, `_` or a run of `'` and attaches it to the preceding atom.
 *
 * Handled here rather than as a postfix loop inside {@link parseAtom} so that
 * `x^2_1` fills both slots of one `scripted` node, and a second `^` nests
 * instead of overwriting.
 */
function attachScript(c: Cursor, out: MathNode[]): void {
  const ch = c.src[c.i] as string;
  let slot: 'sup' | 'sub';
  let value: MathNode;

  if (ch === "'") {
    let count = 0;
    while (c.i < c.src.length && c.src[c.i] === "'") {
      count += 1;
      c.i += 1;
    }
    slot = 'sup';
    value =
      count < PRIMES.length
        ? { kind: 'text', text: PRIMES[count] as string }
        : { kind: 'text', text: "'".repeat(count) };
  } else {
    c.i += 1;
    slot = ch === '^' ? 'sup' : 'sub';
    value = parseScriptArg(c);
  }

  const prev = out.length > 0 ? (out[out.length - 1] as MathNode) : undefined;

  if (prev && prev.kind === 'scripted' && prev[slot] === undefined) {
    // `x^2_1` — same base, other slot.
    if (slot === 'sup') prev.sup = value;
    else prev.sub = value;
    return;
  }

  const base: MathNode = prev ?? { kind: 'group', nodes: [] };
  if (prev) out.pop();
  out.push(
    slot === 'sup'
      ? { kind: 'scripted', base, sup: value }
      : { kind: 'scripted', base, sub: value },
  );
}

/**
 * The argument of `^` or `_`.
 *
 * A brace group, or a single atom. Note that an unbraced number is taken whole:
 * see the deviation note at the top of the file.
 */
function parseScriptArg(c: Cursor): MathNode {
  skipWhitespace(c);
  if (c.i >= c.src.length) return { kind: 'group', nodes: [] };
  if (c.src[c.i] === '{') {
    c.i += 1;
    return groupOf(parseSequence(c, 'brace'));
  }
  return parseAtom(c) ?? { kind: 'group', nodes: [] };
}

/* -------------------------------------------------------------------------- */
/* Atoms                                                                       */
/* -------------------------------------------------------------------------- */

const DIGITS = /[0-9]/;
const LETTERS = /[A-Za-z]/;

function parseAtom(c: Cursor): MathNode | null {
  const ch = c.src[c.i] as string;

  if (ch === '\\') return parseCommand(c);

  if (ch === '{') {
    c.i += 1;
    return groupOf(parseSequence(c, 'brace'));
  }

  if (DIGITS.test(ch) || (ch === '.' && DIGITS.test(c.src[c.i + 1] ?? ''))) {
    const start = c.i;
    while (c.i < c.src.length && DIGITS.test(c.src[c.i] as string)) c.i += 1;
    if (c.src[c.i] === '.' && DIGITS.test(c.src[c.i + 1] ?? '')) {
      c.i += 1;
      while (c.i < c.src.length && DIGITS.test(c.src[c.i] as string)) c.i += 1;
    }
    return { kind: 'number', text: c.src.slice(start, c.i) };
  }

  if (LETTERS.test(ch)) {
    // One letter at a time: `ab` is a times b, and each gets its own italic run.
    c.i += 1;
    return { kind: 'ident', text: ch };
  }

  c.i += 1;

  switch (ch) {
    case '+':
      return { kind: 'op', text: '+' };
    case '-':
      // U+2212. A hyphen is visibly too short next to digits.
      return { kind: 'op', text: '−' };
    case '*':
      return { kind: 'op', text: '*' };
    case '/':
      return { kind: 'op', text: '/' };
    case '=':
    case '<':
    case '>':
    case ':':
      return { kind: 'op', text: ch, rel: true };
    case '~':
      return { kind: 'space', em: 0.333 };
    case '&':
    case '$':
      // Alignment markers and stray dollars only reach here in malformed input.
      return raw(c, ch);
    case ',':
    case ';':
    case '.':
    case '!':
    case '?':
    case '(':
    case ')':
    case '[':
    case ']':
    case '|':
      return { kind: 'punct', text: ch };
    default:
      // Anything else — unicode operators the model wrote directly, CJK in a
      // `\text`-less expression — renders upright and unstyled.
      return { kind: 'text', text: ch };
  }
}

function raw(c: Cursor, latex: string): MathNode {
  c.degraded = true;
  return { kind: 'raw', latex };
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

function parseCommand(c: Cursor): MathNode | null {
  const start = c.i;
  c.i += 1; // the backslash

  if (c.i >= c.src.length) return raw(c, '\\');

  const first = c.src[c.i] as string;

  // A non-letter escape is always exactly one character.
  if (!LETTERS.test(first)) {
    c.i += 1;
    if (first === '\\') {
      // A row break. Only appears inside environments, which we don't typeset.
      throw new Unrenderable();
    }
    const space = lookup(SPACES, first);
    if (space !== undefined) return { kind: 'space', em: space };
    const literal = lookup(LITERAL_ESCAPES, first);
    if (literal !== undefined) {
      return first === '{' || first === '}'
        ? { kind: 'punct', text: literal }
        : { kind: 'text', text: literal };
    }
    return raw(c, `\\${first}`);
  }

  while (c.i < c.src.length && LETTERS.test(c.src[c.i] as string)) c.i += 1;
  const name = c.src.slice(start + 1, c.i);

  /* Environments — the whole expression falls back. Half a rendered matrix is
   * worse than none: the reader cannot tell which half is missing. */
  if (name === 'begin' || name === 'end') throw new Unrenderable();

  if (IGNORED.has(name)) return null;

  if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
    const num = readArg(c);
    const den = readArg(c);
    return { kind: 'frac', num, den };
  }

  if (name === 'binom' || name === 'dbinom' || name === 'tbinom' || name === 'choose') {
    const top = readArg(c);
    const bottom = readArg(c);
    return { kind: 'binom', top, bottom };
  }

  if (name === 'sqrt') {
    const index = readOptionalArg(c);
    const radicand = readArg(c);
    return index ? { kind: 'root', radicand, index } : { kind: 'root', radicand };
  }

  const accent = lookup(ACCENTS, name);
  if (accent) {
    const base = readArg(c);
    return accent.wide
      ? { kind: 'accent', accent: accent.accent, base, wide: true }
      : { kind: 'accent', accent: accent.accent, base };
  }

  const textStyle = lookup(TEXT_COMMANDS, name);
  if (textStyle) {
    const text = readRawArg(c);
    return { kind: 'text', text, ...textStyle };
  }

  if (name === 'mathbb' || name === 'mathcal' || name === 'mathscr') {
    const table = name === 'mathbb' ? BLACKBOARD : CALLIGRAPHIC;
    const arg = readRawArg(c);
    const mapped = [...arg].map((letter) => lookup(table, letter) ?? letter).join('');
    return { kind: 'text', text: mapped };
  }

  if (name === 'boldsymbol' || name === 'bm' || name === 'mathit' || name === 'pmb') {
    const body = readArg(c);
    return name === 'mathit'
      ? { kind: 'style', body, italic: true }
      : { kind: 'style', body, bold: true };
  }

  if (name === 'left') {
    return parseDelimited(c);
  }

  if (name === 'right') {
    // Unmatched: `\left` never opened, or it opened outside this group.
    readDelimiter(c);
    return raw(c, '\\right');
  }

  if (SIZE_PREFIXES.has(name)) {
    // `\bigl(` and friends: keep the delimiter, drop the size.
    const delim = readDelimiter(c);
    return delim === null ? null : { kind: 'punct', text: delim };
  }

  const space = lookup(SPACES, name);
  if (space !== undefined) return { kind: 'space', em: space };

  const greekLower = lookup(GREEK_LOWER, name);
  if (greekLower) return { kind: 'ident', text: greekLower };

  const greekUpper = lookup(GREEK_UPPER, name);
  if (greekUpper) return { kind: 'text', text: greekUpper };

  const binary = lookup(BINARY_OPS, name);
  if (binary) return { kind: 'op', text: binary };

  const relation = lookup(RELATIONS, name);
  if (relation) return { kind: 'op', text: relation, rel: true };

  const symbol = lookup(SYMBOLS, name);
  if (symbol) return { kind: 'text', text: symbol };

  const bigop = lookup(BIG_OPS, name);
  if (bigop) return { kind: 'bigop', text: bigop };

  if (BIG_WORDS.has(name)) return { kind: 'bigop', text: name, word: true };

  if (FUNCTIONS.has(name)) return { kind: 'text', text: name };

  // Unknown. Consume any brace arguments with it, so the fallback shows
  // `\substack{a\\b}` rather than `\substack` followed by a stray `a b`.
  const consumedTo = consumeArgs(c);
  return raw(c, c.src.slice(start, consumedTo));
}

/**
 * Swallows the brace groups following an unknown command.
 *
 * Returns the index just past them. Bracket options are taken too, since
 * `\includegraphics[width=…]{…}`-shaped commands would otherwise leak their
 * options into the expression as punctuation.
 */
function consumeArgs(c: Cursor): number {
  for (;;) {
    const save = c.i;
    skipWhitespace(c);
    const ch = c.src[c.i];
    if (ch === '{') {
      c.i = skipBalanced(c.src, c.i, '{', '}');
    } else if (ch === '[') {
      c.i = skipBalanced(c.src, c.i, '[', ']');
    } else {
      c.i = save;
      return save;
    }
  }
}

/**
 * Index just past the group starting at `from`.
 *
 * Escaped delimiters don't nest, and an unterminated group runs to the end —
 * which is the streaming case, and stopping there is right.
 */
function skipBalanced(src: string, from: number, open: string, close: string): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return src.length;
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A required argument: a brace group, or the single token standing in for one.
 *
 * Unbraced, TeX takes exactly one token, and here that matters: `\frac12` means
 * a half. Taking the whole digit run instead would give twelve over nothing,
 * which renders as a visibly broken fraction. This is the opposite choice from
 * {@link parseScriptArg}, and for the same reason — each construct is read the
 * way it is unambiguously meant.
 */
function readArg(c: Cursor): MathNode {
  skipWhitespace(c);
  if (c.i >= c.src.length) return { kind: 'group', nodes: [] };
  if (c.src[c.i] === '{') {
    c.i += 1;
    return groupOf(parseSequence(c, 'brace'));
  }
  const ch = c.src[c.i] as string;
  if (DIGITS.test(ch)) {
    c.i += 1;
    return { kind: 'number', text: ch };
  }
  if (c.depth > MAX_DEPTH) throw new Unrenderable();
  c.depth += 1;
  const atom = parseAtom(c);
  c.depth -= 1;
  return atom ?? { kind: 'group', nodes: [] };
}

/** `\sqrt[3]{…}`'s optional index. */
function readOptionalArg(c: Cursor): MathNode | null {
  skipWhitespace(c);
  if (c.src[c.i] !== '[') return null;
  const end = skipBalanced(c.src, c.i, '[', ']');
  const inner = c.src.slice(c.i + 1, Math.max(c.i + 1, end - 1));
  c.i = end;
  const sub: Cursor = { src: inner, i: 0, depth: c.depth + 1, degraded: false };
  const nodes = parseSequence(sub, 'top');
  if (sub.degraded) c.degraded = true;
  return groupOf(nodes);
}

/**
 * A literal argument, unparsed.
 *
 * `\text{a b}` keeps its space, so the content cannot go through the math
 * tokeniser, which discards whitespace. Nested braces are unwrapped rather than
 * shown, since `\text{a{b}c}` means `abc`.
 */
function readRawArg(c: Cursor): string {
  skipWhitespace(c);
  if (c.i >= c.src.length) return '';

  if (c.src[c.i] !== '{') {
    // `\mathrm d` — a single token, per TeX's argument rules.
    if (c.src[c.i] === '\\') {
      const start = c.i;
      c.i += 1;
      if (LETTERS.test(c.src[c.i] ?? '')) {
        while (c.i < c.src.length && LETTERS.test(c.src[c.i] as string)) c.i += 1;
      } else {
        c.i += 1;
      }
      const name = c.src.slice(start + 1, c.i);
      return lookup(GREEK_LOWER, name) ?? lookup(GREEK_UPPER, name) ?? lookup(SYMBOLS, name) ?? name;
    }
    const ch = c.src[c.i] as string;
    c.i += 1;
    return ch;
  }

  const end = skipBalanced(c.src, c.i, '{', '}');
  // `end - 1` drops the closing brace; when the group is unterminated there is
  // no closing brace and `end` is the end of the source, so clamp.
  const closed = end <= c.src.length && c.src[end - 1] === '}';
  const inner = c.src.slice(c.i + 1, closed ? end - 1 : end);
  c.i = end;
  return unwrapBraces(inner);
}

function unwrapBraces(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (ch === '\\') {
      const next = text[i + 1];
      if (next !== undefined && lookup(LITERAL_ESCAPES, next) !== undefined) {
        out += next;
        i += 1;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '{' || ch === '}') continue;
    out += ch;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Delimiters                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Reads the delimiter after `\left`, `\right` or a size prefix.
 *
 * Returns the glyph, `''` for `\left.` (an invisible delimiter, used for
 * one-sided cases), or `null` when what follows is not a delimiter at all.
 */
function readDelimiter(c: Cursor): string | null {
  skipWhitespace(c);
  if (c.i >= c.src.length) return null;
  const ch = c.src[c.i] as string;

  if (ch === '\\') {
    const start = c.i;
    let j = c.i + 1;
    if (LETTERS.test(c.src[j] ?? '')) {
      while (j < c.src.length && LETTERS.test(c.src[j] as string)) j += 1;
      const name = c.src.slice(start + 1, j);
      const named = lookup(DELIMITERS, name);
      if (named === undefined) return null;
      c.i = j;
      return named;
    }
    const escaped = lookup(DELIMITERS, c.src.slice(start, start + 2));
    if (escaped === undefined) return null;
    c.i = start + 2;
    return escaped;
  }

  const direct = lookup(DELIMITERS, ch);
  if (direct === undefined) return null;
  c.i += 1;
  return direct;
}

function parseDelimited(c: Cursor): MathNode {
  const open = readDelimiter(c) ?? '';
  const body = groupOf(parseSequence(c, 'right'));

  if (atRight(c)) {
    c.i += '\\right'.length;
    const close = readDelimiter(c) ?? '';
    return { kind: 'delimited', open, close, body };
  }

  // Unterminated — the stream has not reached `\right` yet. Render what there is
  // with an empty closing delimiter rather than falling back the whole thing,
  // because on the next token it will be complete.
  return { kind: 'delimited', open, close: '', body };
}
