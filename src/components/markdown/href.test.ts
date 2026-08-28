import { safeHref } from '@/components/markdown/href';

/**
 * The characters `safeHref` removes.
 *
 * Built from codepoints rather than written as literals: as literals these are
 * invisible, and a test whose input cannot be read is not evidence of anything.
 * The list is deliberately a duplicate of the implementation's — it is the claim
 * being checked, not a shared constant.
 */
const CODEPOINTS = [
  0x0000, // NUL
  0x0009, // tab
  0x000a, // newline
  0x000d, // carriage return
  0x0020, // space
  0x001b, // escape
  0x009d, // C1 control
  0x00ad, // soft hyphen
  0x200b, // zero-width space
  0x200e, // left-to-right mark
  0x2028, // line separator
  0x202e, // right-to-left override
  0x2060, // word joiner
  0xfeff, // byte-order mark
];

const INVISIBLE = CODEPOINTS.map((code) => String.fromCodePoint(code));
const BOM = String.fromCodePoint(0xfeff);
const ZWSP = String.fromCodePoint(0x200b);

describe('safeHref', () => {
  it('allows the schemes a chat link plausibly means', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('http://example.com/path?q=1#frag')).toBe('http://example.com/path?q=1#frag');
    expect(safeHref('mailto:someone@example.com')).toBe('mailto:someone@example.com');
    expect(safeHref('tel:+1-555-0100')).toBe('tel:+1-555-0100');
  });

  it('returns null for nothing to open', () => {
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref('')).toBeNull();
    expect(safeHref('   ')).toBeNull();
  });

  it('preserves the case of the path and query', () => {
    // Only the scheme test is case-insensitive; a path is not, and a link that
    // silently lowercases one is a link to somewhere else.
    expect(safeHref('https://Example.com/Path/To/File?Q=Value')).toBe(
      'https://Example.com/Path/To/File?Q=Value',
    );
  });

  it('refuses the schemes that reach code', () => {
    for (const raw of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'blob:https://example.com/uuid',
      'about:blank',
    ]) {
      expect(safeHref(raw)).toBeNull();
    }
  });

  it('refuses the schemes Android would resolve for us', () => {
    // `intent://` addresses another app's components by name, and `file://` and
    // `content://` reach into our own sandbox. The platform will happily oblige.
    for (const raw of [
      'intent://scan/#Intent;scheme=zxing;end',
      'file:///data/data/com.example/databases/chat.db',
      'content://com.android.contacts/contacts',
      'android-app://com.example',
      'ftp://host/file',
      'ws://host',
    ]) {
      expect(safeHref(raw)).toBeNull();
    }
  });

  it('refuses a scheme with no target after it', () => {
    expect(safeHref('http://')).toBeNull();
    expect(safeHref('https://')).toBeNull();
    expect(safeHref('https:///etc/passwd')).toBeNull();
    expect(safeHref('mailto:')).toBeNull();
    expect(safeHref('tel:')).toBeNull();
  });

  it('refuses relative and fragment links', () => {
    // Models write these constantly, aimed at documentation that does not exist
    // here. There is nowhere for them to resolve against, so they render as text.
    for (const raw of ['/docs/getting-started', './notes.md', '../up', 'notes.md', '#section-2']) {
      expect(safeHref(raw)).toBeNull();
    }
  });

  it('sees through whitespace inside a scheme', () => {
    // The classic: a browser strips these before reading the scheme, so testing
    // the raw string would pass a link the platform then treats as javascript.
    for (const raw of [
      'java\nscript:alert(1)',
      'java\tscript:alert(1)',
      'java\rscript:alert(1)',
      'jav ascript:alert(1)',
      'j a v a s c r i p t:alert(1)',
      ' javascript:alert(1)',
    ]) {
      expect(safeHref(raw)).toBeNull();
    }
  });

  it('sees through invisible characters inside a scheme', () => {
    for (const char of INVISIBLE) {
      expect(safeHref(`java${char}script:alert(1)`)).toBeNull();
      expect(safeHref(`${char}javascript:alert(1)`)).toBeNull();
      expect(safeHref(`j${char}a${char}v${char}a${char}script:alert(1)`)).toBeNull();
    }
  });

  it('does not decode percent escapes or entities into a scheme', () => {
    // Decoding here would be the bug: `%6a%61vascript:` is not a scheme to the
    // platform either, and a decoder would turn it into one.
    expect(safeHref('%6a%61vascript:alert(1)')).toBeNull();
    expect(safeHref('&#106;avascript:alert(1)')).toBeNull();
    expect(safeHref('java&Tab;script:alert(1)')).toBeNull();
    expect(safeHref('java&#10;script:alert(1)')).toBeNull();
  });

  it('accepts an allowed scheme that only needed trimming', () => {
    expect(safeHref('  https://example.com  ')).toBe('https://example.com');
    expect(safeHref('\nhttps://example.com')).toBe('https://example.com');
    expect(safeHref(`${BOM}https://example.com`)).toBe('https://example.com');
    expect(safeHref(`https://example.com${ZWSP}`)).toBe('https://example.com');
  });

  it('strips a raw space rather than opening a malformed URL', () => {
    // A URL cannot contain an unescaped space; an author who means one writes
    // `%20` or wraps the target in angle brackets. Asserted because it is a
    // visible behaviour, not because it is the only defensible choice.
    expect(safeHref('https://example.com/a b')).toBe('https://example.com/ab');
  });

  it('never returns a string containing a character it strips', () => {
    for (const char of INVISIBLE) {
      const out = safeHref(`https://example.com/a${char}b`);
      expect(out).toBe('https://example.com/ab');
      expect(out?.includes(char)).toBe(false);
    }
  });

  it('is stable under a second pass', () => {
    // The renderer may hand a value back through on re-render; cleaning must be
    // idempotent or a legitimate link could erode.
    for (const raw of ['https://example.com/a', 'mailto:a@b.co', '  https://x.dev/y  ']) {
      const once = safeHref(raw);
      expect(once).not.toBeNull();
      expect(safeHref(once as string)).toBe(once);
    }
  });
});
