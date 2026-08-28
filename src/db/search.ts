/**
 * Search query construction.
 *
 * Kept free of `expo-sqlite` imports so it can be unit tested in node: every
 * function here is a pure string transform, and getting them wrong is how a
 * search box turns into a crash. FTS5 `MATCH` expressions are a small query
 * language, and raw user input is not valid in it — an unbalanced double quote
 * or a bare `NEAR` is a syntax error, not zero results.
 *
 * Two matching strategies exist side by side, and the reason is the tokenizer:
 *
 *   - FTS5's `unicode61` tokenizer splits on non-letters, which is right for
 *     English and Russian and useless for Chinese, where a whole clause is one
 *     unbroken run of "letters" and therefore one token. Searching 分析 would
 *     match nothing in a document containing 数据分析报告.
 *   - `LIKE '%q%'` handles that case and short fragments, at the cost of a table
 *     scan.
 *
 * The gateway accepts Chinese, so the CJK case is real rather than theoretical.
 * The data access layer runs FTS first and falls back to LIKE when FTS finds
 * nothing; on a personal-scale database the second pass is imperceptible, and
 * the alternative — a trigram index — cannot match the 2-character words that
 * make up most Chinese queries.
 */

/** Anything with at least one letter or digit is worth searching for. */
const MEANINGFUL = /[\p{L}\p{N}]/u;

interface ParsedQuery {
  /** Quoted phrases the user asked for explicitly. */
  phrases: string[];
  /** Bare whitespace-separated terms. */
  terms: string[];
  /**
   * True when the input ends mid-word, so the last term should prefix-match.
   * Typing "conte" should find "context" while the user is still typing.
   */
  prefixLast: boolean;
}

/** Splits raw input into explicit phrases and bare terms. */
export function parseQuery(raw: string): ParsedQuery {
  const phrases: string[] = [];
  const terms: string[] = [];
  let index = 0;
  let sawTrailingQuote = false;

  while (index < raw.length) {
    const char = raw[index] as string;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '"') {
      const close = raw.indexOf('"', index + 1);
      if (close === -1) {
        // Unterminated quote: treat the remainder as a phrase anyway rather
        // than discarding what the user typed.
        const rest = raw.slice(index + 1).trim();
        if (rest) phrases.push(rest);
        break;
      }
      const phrase = raw.slice(index + 1, close).trim();
      if (phrase) phrases.push(phrase);
      index = close + 1;
      sawTrailingQuote = index >= raw.length;
      continue;
    }

    let end = index;
    while (end < raw.length && !/\s/.test(raw[end] as string) && raw[end] !== '"') end += 1;
    terms.push(raw.slice(index, end));
    index = end;
    sawTrailingQuote = false;
  }

  const endsWithSpace = /\s$/.test(raw);
  return { phrases, terms, prefixLast: terms.length > 0 && !endsWithSpace && !sawTrailingQuote };
}

/** Escapes a string for use inside an FTS5 double-quoted phrase. */
function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Builds an FTS5 `MATCH` expression, or `null` when the input has nothing
 * searchable in it.
 *
 * Every fragment is double-quoted, which is what makes this safe: inside a
 * quoted FTS5 string the only special character is `"` itself, so operators the
 * user happened to type — `AND`, `NOT`, `*`, `^`, `-`, `(` — are matched
 * literally instead of changing the query's meaning.
 *
 * Fragments are implicitly ANDed, which is what a search box should do.
 */
export function buildFtsQuery(raw: string): string | null {
  const { phrases, terms, prefixLast } = parseQuery(raw);
  const parts: string[] = [];

  for (const phrase of phrases) {
    if (MEANINGFUL.test(phrase)) parts.push(quote(phrase));
  }

  terms.forEach((term, i) => {
    if (!MEANINGFUL.test(term)) return;
    const isLast = i === terms.length - 1;
    parts.push(isLast && prefixLast ? `${quote(term)}*` : quote(term));
  });

  return parts.length ? parts.join(' ') : null;
}

/**
 * Builds a `LIKE` pattern for the fallback pass.
 *
 * `%` and `_` are wildcards in LIKE and have to be neutralised, which needs an
 * explicit `ESCAPE` clause in the SQL — see {@link LIKE_ESCAPE}.
 */
export function buildLikePattern(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (!collapsed || !MEANINGFUL.test(collapsed)) return null;
  const escaped = collapsed.replace(/[\\%_]/g, (match) => `\\${match}`);
  return `%${escaped}%`;
}

/** The escape character {@link buildLikePattern} uses. Pass to `ESCAPE`. */
export const LIKE_ESCAPE = '\\';

/**
 * The terms a result should highlight, longest first.
 *
 * Longest-first matters: highlighting "context" before "context window" would
 * leave the second word unmarked when both are present.
 */
export function highlightTerms(raw: string): string[] {
  const { phrases, terms } = parseQuery(raw);
  return [...phrases, ...terms]
    .filter((value) => MEANINGFUL.test(value))
    .sort((a, b) => b.length - a.length);
}

/**
 * A one-line excerpt centred on the first match.
 *
 * Written here rather than using FTS5's `snippet()` because the LIKE fallback
 * has no snippet function, and two different-looking result lists depending on
 * which pass matched would be worse than one slightly cruder one.
 */
export function excerpt(text: string, raw: string, maxLength = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;

  const needles = highlightTerms(raw);
  let at = -1;
  const lower = flat.toLowerCase();
  for (const needle of needles) {
    at = lower.indexOf(needle.toLowerCase());
    if (at !== -1) break;
  }

  if (at === -1) return `${flat.slice(0, maxLength - 1).trimEnd()}…`;

  // Leave a third of the window ahead of the match so there is trailing context.
  const start = Math.max(0, at - Math.floor(maxLength / 3));
  const end = Math.min(flat.length, start + maxLength);
  const slice = flat.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${slice}${end < flat.length ? '…' : ''}`;
}

/**
 * Splits text into alternating plain and matched runs for highlighted rendering.
 *
 * Case-insensitive, and overlapping matches are resolved by taking the longest
 * one at each position, so no character is emitted twice.
 */
export function splitOnMatches(text: string, raw: string): { text: string; match: boolean }[] {
  const needles = highlightTerms(raw).map((n) => n.toLowerCase());
  if (!needles.length) return [{ text, match: false }];

  const lower = text.toLowerCase();
  const out: { text: string; match: boolean }[] = [];
  let cursor = 0;
  let plainStart = 0;

  while (cursor < text.length) {
    let hitLength = 0;
    for (const needle of needles) {
      if (needle && lower.startsWith(needle, cursor)) {
        hitLength = Math.max(hitLength, needle.length);
      }
    }

    if (hitLength === 0) {
      cursor += 1;
      continue;
    }

    if (cursor > plainStart) out.push({ text: text.slice(plainStart, cursor), match: false });
    out.push({ text: text.slice(cursor, cursor + hitLength), match: true });
    cursor += hitLength;
    plainStart = cursor;
  }

  if (plainStart < text.length) out.push({ text: text.slice(plainStart), match: false });
  return out.length ? out : [{ text, match: false }];
}
