/**
 * Artifact preview: the parts that have to hold.
 *
 * The document is a security boundary, so the tests are mostly about the policy being
 * present, first, and not weakenable by the content it wraps.
 */

import { artifactDocument, artifactKind } from '@/chat/artifact';

describe('artifactKind', () => {
  it('offers HTML and SVG, by the tags people type', () => {
    expect(artifactKind('html', '<p>hi</p>')).toBe('html');
    expect(artifactKind('HTML', '<p>hi</p>')).toBe('html');
    expect(artifactKind(' htm ', '<p>hi</p>')).toBe('html');
    expect(artifactKind('svg', '<svg/>')).toBe('svg');
  });

  it('offers nothing for source that is read, not rendered', () => {
    expect(artifactKind('python', 'print(1)')).toBeNull();
    expect(artifactKind('markdown', '# hi')).toBeNull();
    expect(artifactKind('bash', 'echo "<svg>"')).toBeNull();
    expect(artifactKind(undefined, '<p>hi</p>')).toBeNull();
  });

  it('offers nothing for an empty fence', () => {
    expect(artifactKind('html', '   \n ')).toBeNull();
  });
});

describe('artifactDocument', () => {
  it('carries a default-src none policy', () => {
    const document = artifactDocument('<p>hi</p>', 'html');
    expect(document).toContain("default-src 'none'");
    expect(document).toContain('Content-Security-Policy');
  });

  it('permits no network source at all', () => {
    const document = artifactDocument('<p>hi</p>', 'html');
    const policy = /content="([^"]+)"/.exec(document.slice(document.indexOf('Content-Security-Policy')))?.[1] ?? '';
    expect(policy).not.toMatch(/https?:/);
    expect(policy).not.toMatch(/\*/);
    // `img-src data:` and `font-src data:` are the only sources named, and neither
    // carries a request off the device.
    expect(policy).toContain('img-src data:');
    expect(policy).not.toMatch(/connect-src/);
  });

  it('allows inline script but not somebody else’s', () => {
    const policy = artifactDocument('<p>hi</p>', 'html');
    expect(policy).toContain("script-src 'unsafe-inline'");
    expect(policy).not.toMatch(/script-src[^;]*https/);
  });

  it('wraps an SVG fragment in a document', () => {
    const document = artifactDocument('<svg viewBox="0 0 1 1"></svg>', 'svg');
    expect(document.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(document).toContain('<svg viewBox="0 0 1 1"></svg>');
  });

  it('injects into an existing head rather than nesting a second document', () => {
    const document = artifactDocument('<html><head><title>T</title></head><body>x</body></html>', 'html');
    expect(document.match(/<html/gi)).toHaveLength(1);
    expect(document).toContain('<title>T</title>');
    // The policy has to precede the author's own head content: the first policy in a
    // document wins, and one placed after a `<meta>` of theirs could be widened.
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<title>'));
  });

  it('injects after an <html> with no head', () => {
    const document = artifactDocument('<html><body>x</body></html>', 'html');
    expect(document.match(/<html/gi)).toHaveLength(1);
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<body>'));
  });

  it('keeps a bare fragment’s markup intact', () => {
    const document = artifactDocument('<p>hi &amp; bye</p>', 'html');
    expect(document).toContain('<p>hi &amp; bye</p>');
  });
});
