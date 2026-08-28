/**
 * Markdown → a small block AST, ready for React Native rendering.
 *
 * `marked` handles the parsing; this module's job is to turn its token stream
 * into something narrow enough to render with confidence. Three reasons for the
 * translation rather than rendering marked's tokens directly:
 *
 * 1. **It is pure and testable.** No React Native imports, so the whole parser
 *    runs in the `node` Jest environment.
 * 2. **The token union is closed.** marked's `Token` type is open-ended and every
 *    renderer has to guess at what it might receive; a closed union means the
 *    component's switch is exhaustive and the compiler says so.
 * 3. **Math is not markdown.** `$x_1$` is emphasis to a markdown parser, and
 *    `$$\begin{bmatrix}...$$` is a mess. Math is tokenised before inline parsing
 *    happens, by the extensions below, so the LaTeX arrives intact.
 *
 * `breaks: true` is deliberate. Standard markdown collapses a single newline into
 * a space, but models write chat prose with meaningful line breaks all the time,
 * and swallowing them makes the answer look wrong rather than looking like a
 * markdown subtlety.
 */

import { Marked } from 'marked';
import type { MarkedExtension, Token, Tokens } from 'marked';

/* -------------------------------------------------------------------------- */
/* The AST                                                                     */
/* -------------------------------------------------------------------------- */

export type Align = 'left' | 'center' | 'right';

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'math'; latex: string }
  | { kind: 'strong'; tokens: InlineToken[] }
  | { kind: 'em'; tokens: InlineToken[] }
  | { kind: 'del'; tokens: InlineToken[] }
  | { kind: 'link'; href: string; tokens: InlineToken[] }
  | { kind: 'image'; href: string; alt: string }
  | { kind: 'break' };

export interface ListItem {
  blocks: MdBlock[];
  /** Present only for GFM task-list items. */
  checked?: boolean;
}

export type MdBlock =
  | { kind: 'paragraph'; tokens: InlineToken[] }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; tokens: InlineToken[] }
  | { kind: 'code'; code: string; lang?: string }
  | { kind: 'math'; latex: string }
  | { kind: 'quote'; blocks: MdBlock[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'table'; head: InlineToken[][]; rows: InlineToken[][][]; align: (Align | null)[] }
  | { kind: 'rule' };

/* -------------------------------------------------------------------------- */
/* Math tokenisers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `$$…$$` or `\[…\]`, as its own block.
 *
 * Matched at block level so a display equation is not wrapped in a paragraph,
 * which would leave it competing with the surrounding text for line height.
 */
const BLOCK_MATH = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/;

/**
 * `$…$` or `\(…\)`, inline.
 *
 * The `$` form needs guarding or every price in a paragraph becomes an equation.
 * Two rules, both from the usual KaTeX auto-render heuristics: no whitespace just
 * inside either delimiter, and no digit immediately after the closing `$`. That
 * leaves `$5 and $10` alone — its closing delimiter is preceded by a space — while
 * still matching `$x^2$`.
 */
const INLINE_MATH = /^(?:\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)|\\\(([\s\S]+?)\\\))/;

const MATH_TOKEN_BLOCK = 'mathBlock';
const MATH_TOKEN_INLINE = 'mathInline';

const mathExtension: MarkedExtension = {
  extensions: [
    {
      name: MATH_TOKEN_BLOCK,
      level: 'block',
      start: (src: string) => {
        const dollars = src.indexOf('$$');
        const bracket = src.indexOf('\\[');
        if (dollars < 0) return bracket < 0 ? undefined : bracket;
        return bracket < 0 ? dollars : Math.min(dollars, bracket);
      },
      tokenizer(src: string) {
        const match = BLOCK_MATH.exec(src);
        if (!match) return undefined;
        return { type: MATH_TOKEN_BLOCK, raw: match[0], text: (match[1] ?? match[2] ?? '').trim() };
      },
    },
    {
      name: MATH_TOKEN_INLINE,
      level: 'inline',
      start: (src: string) => {
        const dollar = src.indexOf('$');
        const paren = src.indexOf('\\(');
        if (dollar < 0) return paren < 0 ? undefined : paren;
        return paren < 0 ? dollar : Math.min(dollar, paren);
      },
      tokenizer(src: string) {
        const match = INLINE_MATH.exec(src);
        if (!match) return undefined;
        return { type: MATH_TOKEN_INLINE, raw: match[0], text: (match[1] ?? match[2] ?? '').trim() };
      },
    },
  ],
};

/**
 * A private parser instance.
 *
 * `marked.use()` mutates a module-level singleton, so extending the default
 * export would leak the math tokenisers into anything else that imports `marked`.
 */
const parser = new Marked({ gfm: true, breaks: true }, mathExtension);

/* -------------------------------------------------------------------------- */
/* Translation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parses markdown into blocks.
 *
 * Safe to call on a partial document: an unterminated fence lexes as a code
 * block, which is what streaming needs — the alternative is a paragraph of
 * backticks that snaps into a code block when the closing fence arrives.
 */
export function parseMarkdown(source: string): MdBlock[] {
  if (!source.trim()) return [];
  return fromTokens(parser.lexer(source));
}

function fromTokens(tokens: readonly Token[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  for (const token of tokens) {
    const block = fromToken(token);
    if (block) blocks.push(...block);
  }
  return blocks;
}

/**
 * One marked token → zero or more blocks.
 *
 * Returns an array because `text` tokens inside loose list items can carry a
 * whole sub-document, and because unhandled tokens collapse to nothing.
 */
function fromToken(token: Token): MdBlock[] | null {
  switch (token.type) {
    case 'space':
      return null;

    case 'paragraph': {
      const paragraph = token as Tokens.Paragraph;
      return [{ kind: 'paragraph', tokens: fromInline(paragraph.tokens ?? []) }];
    }

    case 'text': {
      // Tight list items and table-free plain runs arrive as bare text. When the
      // item is loose, marked nests real blocks inside instead.
      const text = token as Tokens.Text;
      if (text.tokens?.length) return [{ kind: 'paragraph', tokens: fromInline(text.tokens) }];
      return [{ kind: 'paragraph', tokens: [{ kind: 'text', text: text.text }] }];
    }

    case 'heading': {
      const heading = token as Tokens.Heading;
      const level = Math.min(6, Math.max(1, heading.depth)) as 1 | 2 | 3 | 4 | 5 | 6;
      return [{ kind: 'heading', level, tokens: fromInline(heading.tokens ?? []) }];
    }

    case 'code': {
      const code = token as Tokens.Code;
      const lang = code.lang?.trim().split(/\s+/)[0];
      return [{ kind: 'code', code: code.text, ...(lang ? { lang: lang.toLowerCase() } : {}) }];
    }

    case 'blockquote': {
      const quote = token as Tokens.Blockquote;
      return [{ kind: 'quote', blocks: fromTokens(quote.tokens ?? []) }];
    }

    case 'list': {
      const list = token as Tokens.List;
      return [
        {
          kind: 'list',
          ordered: list.ordered,
          start: typeof list.start === 'number' ? list.start : 1,
          items: list.items.map((item) => ({
            blocks: fromTokens(item.tokens ?? []),
            ...(item.task ? { checked: Boolean(item.checked) } : {}),
          })),
        },
      ];
    }

    case 'table': {
      const table = token as Tokens.Table;
      return [
        {
          kind: 'table',
          head: table.header.map((cell) => fromInline(cell.tokens ?? [])),
          rows: table.rows.map((row) => row.map((cell) => fromInline(cell.tokens ?? []))),
          align: table.align.map((value) => value ?? null),
        },
      ];
    }

    case 'hr':
      return [{ kind: 'rule' }];

    case MATH_TOKEN_BLOCK:
      return [{ kind: 'math', latex: (token as Tokens.Generic).text as string }];

    case 'html': {
      // There is no HTML renderer here and there should not be one. Showing the
      // markup verbatim is more honest than dropping content the model wrote.
      const html = (token as Tokens.HTML).raw.trim();
      return html ? [{ kind: 'code', code: html, lang: 'html' }] : null;
    }

    default:
      return null;
  }
}

function fromInline(tokens: readonly Token[]): InlineToken[] {
  const out: InlineToken[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'escape': {
        const text = token as Tokens.Text;
        // Nested tokens appear when a text run contains an extension match.
        if (text.tokens?.length) out.push(...fromInline(text.tokens));
        else out.push({ kind: 'text', text: decodeEntities(text.text) });
        break;
      }
      case 'codespan':
        out.push({ kind: 'code', text: decodeEntities((token as Tokens.Codespan).text) });
        break;
      case 'strong':
        out.push({ kind: 'strong', tokens: fromInline((token as Tokens.Strong).tokens ?? []) });
        break;
      case 'em':
        out.push({ kind: 'em', tokens: fromInline((token as Tokens.Em).tokens ?? []) });
        break;
      case 'del':
        out.push({ kind: 'del', tokens: fromInline((token as Tokens.Del).tokens ?? []) });
        break;
      case 'link': {
        const link = token as Tokens.Link;
        out.push({ kind: 'link', href: link.href, tokens: fromInline(link.tokens ?? []) });
        break;
      }
      case 'image': {
        const image = token as Tokens.Image;
        out.push({ kind: 'image', href: image.href, alt: image.text });
        break;
      }
      case 'br':
        out.push({ kind: 'break' });
        break;
      case MATH_TOKEN_INLINE:
        out.push({ kind: 'math', latex: (token as Tokens.Generic).text as string });
        break;
      case 'html':
        out.push({ kind: 'text', text: (token as Tokens.HTML).raw });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Undoes the HTML escaping marked applies to text runs.
 *
 * marked escapes for an HTML target; there is no HTML here, so `&amp;` in the
 * output would be a bug the user sees. Only the five entities marked itself
 * produces are handled — this is not a general entity decoder.
 */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/* -------------------------------------------------------------------------- */
/* Plain text                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Flattens inline tokens back to text.
 *
 * Used for a table cell's accessibility label and for measuring column widths,
 * where the styling is irrelevant but the length is not.
 */
export function inlineText(tokens: readonly InlineToken[]): string {
  let out = '';
  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
      case 'code':
        out += token.text;
        break;
      case 'math':
        out += token.latex;
        break;
      case 'image':
        out += token.alt;
        break;
      case 'break':
        out += ' ';
        break;
      default:
        out += inlineText(token.tokens);
        break;
    }
  }
  return out;
}
