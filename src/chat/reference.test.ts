import { appendQuote, QUOTE_CHAR_LIMIT, quoteMessage } from '@/chat/reference';

describe('quoteMessage', () => {
  it('attributes the quote to its conversation and speaker', () => {
    const quote = quoteMessage({ title: 'Taxes', role: 'assistant', text: 'File by April.' });
    expect(quote).toBe('> From “Taxes” (the assistant):\n> File by April.');
  });

  it('names the user as "you"', () => {
    expect(quoteMessage({ title: 'T', role: 'user', text: 'hi' })).toContain('(you)');
  });

  it('quotes every line, including the blank ones', () => {
    const quote = quoteMessage({ title: 'T', role: 'user', text: 'one\n\ntwo' });
    // A blank line left unquoted ends the blockquote, so the second half would
    // render — and read to the model — as text said in this conversation.
    expect(quote.split('\n').every((line) => line.startsWith('>'))).toBe(true);
  });

  it('trims past the limit and says where the rest is', () => {
    const quote = quoteMessage({ title: 'Notes', role: 'user', text: 'word '.repeat(50) }, 40);
    expect(quote).toContain('Trimmed here');
    expect(quote).toContain('“Notes”');
    expect(quote.length).toBeLessThan(200);
  });

  it('leaves a message inside the limit alone', () => {
    const text = 'short enough';
    expect(quoteMessage({ title: 'T', role: 'user', text })).toContain(text);
    expect(quoteMessage({ title: 'T', role: 'user', text })).not.toContain('Trimmed');
  });

  it('cuts at a word boundary', () => {
    const quote = quoteMessage({ title: 'T', role: 'user', text: 'alpha bravo charlie delta echo' }, 20);
    expect(quote).not.toContain('cha\n');
    expect(quote).toContain('alpha bravo');
  });

  it('caps by default', () => {
    const quote = quoteMessage({ title: 'T', role: 'user', text: 'x'.repeat(QUOTE_CHAR_LIMIT * 2) });
    expect(quote).toContain('Trimmed here');
  });
});

describe('appendQuote', () => {
  it('leaves the caret after the quote in an empty draft', () => {
    expect(appendQuote('', '> q')).toBe('> q\n\n');
  });

  it('keeps what was already typed, under the quote', () => {
    expect(appendQuote('what about this?', '> q')).toBe('> q\n\nwhat about this?');
  });

  it('does not stack blank lines from a half-typed draft', () => {
    expect(appendQuote('\n\n  ', '> q')).toBe('> q\n\n');
  });
});
