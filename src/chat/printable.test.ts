import { printableHtml, stripActiveContent } from '@/chat/printable';

describe('stripActiveContent', () => {
  it('removes what can execute in a WebView', () => {
    // This HTML is rendered by `expo-print` in a real WebView, and the Markdown that
    // produced it was written by a model — possibly from a page it fetched. Scripts
    // are not a document feature.
    const out = stripActiveContent(
      '<p>ok</p><script>fetch("http://evil")</script><iframe src="http://evil"></iframe>',
    );
    expect(out).toBe('<p>ok</p>');
  });

  it('removes inline handlers', () => {
    expect(stripActiveContent('<p onclick="steal()">hi</p>')).toBe('<p>hi</p>');
    expect(stripActiveContent("<img src=x onerror='steal()' />")).toBe('<img src=x />');
  });

  it('defuses a javascript: URL', () => {
    expect(stripActiveContent('<a href="javascript:steal()">x</a>')).toBe('<a href="#">x</a>');
  });

  it('leaves an ordinary document alone', () => {
    const html = '<h1>Title</h1>\n<p>Body with <strong>emphasis</strong> and <a href="https://x.test">a link</a>.</p>';
    expect(stripActiveContent(html)).toBe(html);
  });
});

describe('printableHtml', () => {
  it('renders Markdown, not the Markdown source', () => {
    const html = printableHtml('Report', '# Heading\n\n- one\n- two\n');
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<li>one</li>');
    expect(html).not.toContain('# Heading');
  });

  it('renders GFM tables, which is most of why a PDF is asked for', () => {
    const html = printableHtml('t', '| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('escapes the title rather than injecting it', () => {
    expect(printableHtml('</title><script>x</script>', 'body')).not.toContain('<script>');
  });

  it('carries print styling, so the PDF is a page and not a screenshot', () => {
    expect(printableHtml('t', 'x')).toContain('@page');
  });
});
