import {
  buildFtsQuery,
  buildLikePattern,
  excerpt,
  highlightTerms,
  parseQuery,
  splitOnMatches,
} from '@/db/search';

describe('parseQuery', () => {
  it('splits bare terms on whitespace', () => {
    expect(parseQuery('context window')).toMatchObject({ phrases: [], terms: ['context', 'window'] });
  });

  it('extracts quoted phrases', () => {
    expect(parseQuery('"context window" pressure')).toMatchObject({
      phrases: ['context window'],
      terms: ['pressure'],
    });
  });

  it('prefix-matches the last term while the user is still typing', () => {
    expect(parseQuery('conte').prefixLast).toBe(true);
  });

  it('stops prefix-matching once a space is typed', () => {
    expect(parseQuery('context ').prefixLast).toBe(false);
  });

  it('does not prefix-match after a closing quote', () => {
    expect(parseQuery('"exact"').prefixLast).toBe(false);
  });

  it('keeps the tail of an unterminated quote', () => {
    // Typing an opening quote should not make results vanish until it is closed.
    expect(parseQuery('"half a phrase')).toMatchObject({ phrases: ['half a phrase'], terms: [] });
  });

  it('ignores empty quotes', () => {
    expect(parseQuery('"" hello')).toMatchObject({ phrases: [], terms: ['hello'] });
  });

  it('handles an empty string', () => {
    expect(parseQuery('')).toEqual({ phrases: [], terms: [], prefixLast: false });
  });

  it('handles whitespace only', () => {
    expect(parseQuery('   ')).toEqual({ phrases: [], terms: [], prefixLast: false });
  });
});

describe('buildFtsQuery', () => {
  it('quotes every term and ANDs them implicitly', () => {
    expect(buildFtsQuery('context window ')).toBe('"context" "window"');
  });

  it('appends a prefix wildcard outside the quotes', () => {
    // `"conte*"` would search for a literal asterisk; the star must be outside.
    expect(buildFtsQuery('conte')).toBe('"conte"*');
  });

  it('emits phrases before terms', () => {
    expect(buildFtsQuery('"drop oldest" strategy ')).toBe('"drop oldest" "strategy"');
  });

  it('neutralises FTS5 operators typed by the user', () => {
    // Unquoted, each of these would change the query's meaning or be a syntax
    // error. Quoted, they are literal text.
    expect(buildFtsQuery('AND ')).toBe('"AND"');
    expect(buildFtsQuery('NEAR ')).toBe('"NEAR"');
    expect(buildFtsQuery('a OR b ')).toBe('"a" "OR" "b"');
    expect(buildFtsQuery('-excluded ')).toBe('"-excluded"');
    expect(buildFtsQuery('^anchor ')).toBe('"^anchor"');
    expect(buildFtsQuery('(group) ')).toBe('"(group)"');
    expect(buildFtsQuery('col:value ')).toBe('"col:value"');
  });

  it('treats stray double quotes as delimiters, never leaking them unbalanced', () => {
    // Phrases are emitted before bare terms; order is irrelevant to FTS5 since
    // the fragments are ANDed, but it is worth pinning so the output is stable.
    expect(buildFtsQuery('say "hi" ')).toBe('"hi" "say"');
    // `a"b` opens an unterminated quote, so `b` becomes a phrase and sorts first.
    expect(buildFtsQuery('a"b ')).toBe('"b" "a"');
  });

  it('always produces a balanced expression, whatever is typed', () => {
    // The property that matters: FTS5 answers a syntax error with an exception,
    // not with zero rows, so a malformed expression crashes the search screen.
    const nasty = [
      '"', '""', '"""', 'a"', '"a', 'a""b', '" "', 'AND OR NOT', '*', '**', '^', '-', '(',
      ')', '()', 'a AND (b OR c)', 'NEAR(a b, 3)', 'col : val', '\\', 'a\\"b', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢',
      '数据"分析', '  "  ', 'a*b', '"a"*b',
    ];
    for (const input of nasty) {
      const query = buildFtsQuery(input);
      if (query === null) continue;
      const quoteCount = (query.match(/"/g) ?? []).length;
      expect(quoteCount % 2).toBe(0);
      // Every fragment is a quoted string, optionally followed by a prefix star.
      expect(query).toMatch(/^(?:"(?:[^"]|"")*"\*? ?)+$/);
    }
  });

  it('returns null when there is nothing searchable', () => {
    expect(buildFtsQuery('')).toBeNull();
    expect(buildFtsQuery('   ')).toBeNull();
    expect(buildFtsQuery('!!! ???')).toBeNull();
    expect(buildFtsQuery('""')).toBeNull();
  });

  it('accepts non-Latin scripts', () => {
    expect(buildFtsQuery('数据分析 ')).toBe('"数据分析"');
    expect(buildFtsQuery('привет ')).toBe('"привет"');
  });

  it('keeps digits, which are searchable', () => {
    expect(buildFtsQuery('404 ')).toBe('"404"');
  });
});

describe('buildLikePattern', () => {
  it('wraps the query in wildcards', () => {
    expect(buildLikePattern('analysis')).toBe('%analysis%');
  });

  it('collapses internal whitespace', () => {
    expect(buildLikePattern('  two   words  ')).toBe('%two words%');
  });

  it('escapes LIKE wildcards so they match literally', () => {
    expect(buildLikePattern('100%')).toBe('%100\\%%');
    expect(buildLikePattern('a_b')).toBe('%a\\_b%');
    expect(buildLikePattern('c:\\path')).toBe('%c:\\\\path%');
  });

  it('returns null when there is nothing searchable', () => {
    expect(buildLikePattern('')).toBeNull();
    expect(buildLikePattern('  ')).toBeNull();
    expect(buildLikePattern('---')).toBeNull();
  });

  it('handles the CJK case the FTS tokenizer cannot', () => {
    // The whole reason the fallback exists: unicode61 makes 数据分析报告 one
    // token, so a substring search for 分析 needs LIKE.
    expect(buildLikePattern('分析')).toBe('%分析%');
  });
});

describe('highlightTerms', () => {
  it('returns longest first so nested matches are not left unmarked', () => {
    expect(highlightTerms('context "context window"')).toEqual(['context window', 'context']);
  });

  it('drops punctuation-only fragments', () => {
    expect(highlightTerms('--- hello')).toEqual(['hello']);
  });
});

describe('excerpt', () => {
  it('returns short text unchanged', () => {
    expect(excerpt('a short message', 'short')).toBe('a short message');
  });

  it('collapses newlines so the row stays one line', () => {
    expect(excerpt('line one\n\nline two', 'line')).toBe('line one line two');
  });

  it('centres the window on the match', () => {
    const text = `${'x'.repeat(300)} needle ${'y'.repeat(300)}`;
    const result = excerpt(text, 'needle', 60);
    expect(result).toContain('needle');
    expect(result.startsWith('…')).toBe(true);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(62);
  });

  it('falls back to the head when the term is not present', () => {
    const result = excerpt('z'.repeat(400), 'absent', 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith('…')).toBe(true);
  });

  it('does not prepend an ellipsis when the match is at the start', () => {
    const result = excerpt(`needle ${'y'.repeat(300)}`, 'needle', 60);
    expect(result.startsWith('…')).toBe(false);
  });
});

describe('splitOnMatches', () => {
  it('marks the matched run', () => {
    expect(splitOnMatches('the context window', 'context ')).toEqual([
      { text: 'the ', match: false },
      { text: 'context', match: true },
      { text: ' window', match: false },
    ]);
  });

  it('matches case-insensitively but preserves the original casing', () => {
    expect(splitOnMatches('Context', 'context ')).toEqual([{ text: 'Context', match: true }]);
  });

  it('prefers the longest match at a position so no character is emitted twice', () => {
    const parts = splitOnMatches('context window here', 'context "context window"');
    expect(parts.map((p) => p.text).join('')).toBe('context window here');
    expect(parts.find((p) => p.match)?.text).toBe('context window');
  });

  it('reassembles to the original text in every case', () => {
    const samples = ['', 'no match at all', 'aaa', 'AbAbAb', '数据分析报告'];
    for (const sample of samples) {
      for (const query of ['a', 'ab', '分析', 'match', '']) {
        expect(splitOnMatches(sample, query).map((p) => p.text).join('')).toBe(sample);
      }
    }
  });

  it('returns a single unmatched run when the query has nothing searchable', () => {
    expect(splitOnMatches('hello', '!!!')).toEqual([{ text: 'hello', match: false }]);
  });

  it('handles a match at the very end', () => {
    expect(splitOnMatches('find me', 'me ')).toEqual([
      { text: 'find ', match: false },
      { text: 'me', match: true },
    ]);
  });
});
