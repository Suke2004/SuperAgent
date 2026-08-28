/**
 * Prism/refractor output → coloured spans, one array per line.
 *
 * Deliberately knows nothing about refractor. It takes the HAST tree as data,
 * described by the minimal structural types below, for two reasons: the mapping
 * from token classes to colours is the part worth testing and it tests fine
 * against hand-built fixtures, and refractor is ESM-only with a large transitive
 * dependency tree, so keeping it out of the pure layer keeps the whole test suite
 * in the fast `node` environment. The component imports refractor and passes the
 * tree in — the same injection the transports use for `fetch`.
 *
 * Output is per line because a code block scrolls horizontally rather than
 * wrapping, which means one non-wrapping `<Text>` per line.
 */

/* -------------------------------------------------------------------------- */
/* The bit of HAST that matters                                                */
/* -------------------------------------------------------------------------- */

export interface HastText {
  type: 'text';
  value: string;
}

export interface HastElement {
  type: 'element';
  tagName: string;
  properties?: { className?: readonly string[] | string } | undefined;
  children: readonly HastNode[];
}

export interface HastRoot {
  type: 'root';
  children: readonly HastNode[];
}

export type HastNode = HastText | HastElement | HastRoot | { type: string };

/* -------------------------------------------------------------------------- */
/* Colour roles                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The palette a code block draws from.
 *
 * Twelve roles rather than Prism's forty-odd token classes: a phone screen at 13pt
 * cannot usefully distinguish more than this, and every extra role is another
 * colour to keep legible against both themes.
 */
export type TokenColor =
  | 'plain'
  | 'comment'
  | 'keyword'
  | 'string'
  | 'number'
  | 'function'
  | 'type'
  | 'operator'
  | 'punctuation'
  | 'variable'
  | 'deleted'
  | 'inserted';

/**
 * Prism token class → colour role.
 *
 * Ordered by specificity in {@link classToColor}, not here: a token carries
 * several classes (`token`, `class-name`, `maybe-class-name`) and the most
 * specific match should win.
 */
const CLASS_COLORS: Record<string, TokenColor> = {
  comment: 'comment',
  prolog: 'comment',
  doctype: 'comment',
  cdata: 'comment',

  keyword: 'keyword',
  atrule: 'keyword',
  important: 'keyword',
  'keyword-control': 'keyword',
  selector: 'keyword',
  tag: 'keyword',
  'attr-name': 'type',

  string: 'string',
  char: 'string',
  'template-string': 'string',
  'attr-value': 'string',
  regex: 'string',
  url: 'string',

  number: 'number',
  boolean: 'number',
  constant: 'number',
  symbol: 'number',
  literal: 'number',

  function: 'function',
  method: 'function',
  'function-variable': 'function',
  decorator: 'function',
  annotation: 'function',

  'class-name': 'type',
  'maybe-class-name': 'type',
  builtin: 'type',
  namespace: 'type',
  entity: 'type',

  operator: 'operator',
  arrow: 'operator',
  spread: 'operator',

  punctuation: 'punctuation',
  'interpolation-punctuation': 'punctuation',

  variable: 'variable',
  parameter: 'variable',
  property: 'variable',
  'literal-property': 'variable',
  'property-access': 'variable',

  deleted: 'deleted',
  inserted: 'inserted',
};

/**
 * Classes that never decide a colour on their own.
 *
 * `token` is on every span, and `language-*` marks an embedded sub-language.
 */
function isStructural(name: string): boolean {
  return name === 'token' || name.startsWith('language-');
}

/**
 * Classes whose children start again from plain rather than inheriting.
 *
 * `${…}` inside a template literal is a nested expression, not more string: Prism
 * nests `token interpolation` inside `token template-string`, and without a reset
 * the variable inside the braces would come out string-coloured.
 */
const RESET_CLASSES = new Set(['interpolation']);

function isReset(classNames: readonly string[]): boolean {
  return classNames.some((name) => RESET_CLASSES.has(name));
}

/**
 * The colour for one span's class list.
 *
 * The *last* recognised class wins. Prism emits general classes before specific
 * ones — `token function` rather than `function token` — so taking the last match
 * picks the specific one without needing a specificity table.
 */
export function classToColor(classNames: readonly string[]): TokenColor {
  let color: TokenColor = 'plain';
  for (const name of classNames) {
    if (isStructural(name)) continue;
    const mapped = CLASS_COLORS[name];
    if (mapped) color = mapped;
  }
  return color;
}

/* -------------------------------------------------------------------------- */
/* Flattening                                                                  */
/* -------------------------------------------------------------------------- */

export interface HighlightSpan {
  text: string;
  color: TokenColor;
}

function classListOf(node: HastElement): readonly string[] {
  const raw = node.properties?.className;
  if (!raw) return [];
  return typeof raw === 'string' ? raw.split(/\s+/).filter(Boolean) : raw;
}

/**
 * Walks a highlighted tree into lines of coloured spans.
 *
 * Newlines are split out as the walk goes rather than by a second pass over
 * joined text, so a token that straddles a line boundary — a block comment, a
 * template string — keeps its colour on both sides.
 *
 * Adjacent spans of the same colour are merged. A 400-line file highlights to
 * several thousand Prism tokens, and every one of them would otherwise be a
 * separate `<Text>` node for React Native to lay out.
 */
export function highlightLines(root: HastNode): HighlightSpan[][] {
  const lines: HighlightSpan[][] = [[]];

  const push = (text: string, color: TokenColor): void => {
    if (!text) return;
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) lines.push([]);
      const part = parts[i] as string;
      if (!part) continue;
      const line = lines[lines.length - 1] as HighlightSpan[];
      const last = line[line.length - 1];
      if (last && last.color === color) last.text += part;
      else line.push({ text: part, color });
    }
  };

  const walk = (node: HastNode, inherited: TokenColor): void => {
    if (node.type === 'text') {
      push((node as HastText).value, inherited);
      return;
    }
    if (node.type === 'element') {
      const element = node as HastElement;
      const classNames = classListOf(element);
      const own = classToColor(classNames);
      // An unclassified wrapper keeps its parent's colour rather than resetting
      // to plain, which is how nested spans inside a string stay string-coloured.
      const color = own !== 'plain' ? own : isReset(classNames) ? 'plain' : inherited;
      for (const child of element.children) walk(child, color);
      return;
    }
    if (node.type === 'root') {
      for (const child of (node as HastRoot).children) walk(child, inherited);
    }
  };

  walk(root, 'plain');
  return lines;
}

/**
 * Splits unhighlighted source into the same shape.
 *
 * Used when the language is unknown, when highlighting is skipped for size, and
 * while a fenced block is still streaming.
 */
export function plainLines(code: string): HighlightSpan[][] {
  return code.split('\n').map((line) => (line ? [{ text: line, color: 'plain' as TokenColor }] : []));
}
