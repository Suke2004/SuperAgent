/**
 * Markdown turned into a page a printer can paginate.
 *
 * Pure, and separate from `@/chat/files` for the same reason `@/chat/export` is
 * separate from `@/chat/deliver`: this is where the escaping and the stripping live,
 * and neither should need a file system or a print service to test.
 */

import { Marked } from 'marked';

/** Rendering only — no extensions, so `parse` is synchronous and returns a string. */
const printer = new Marked({ gfm: true, breaks: false });

/**
 * Active content, removed.
 *
 * The Markdown here was written by a model, possibly from a page it fetched, and it
 * is about to be rendered in a WebView. That is a scripting context, so the tags
 * that can execute in one go — along with inline `on…` handlers and `javascript:`
 * URLs — before anything is printed. Nothing in a document needs them.
 */
export function stripActiveContent(html: string): string {
  return html
    .replace(/<(script|iframe|object|embed|link|meta)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '$1="#"');
}

/** HTML-escapes a string for use in text content or an attribute. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The page, styled for print.
 *
 * Points rather than pixels, a serif body and `@page` margins: this is going to A4
 * or Letter, and a stylesheet written for a phone screen produces a PDF that looks
 * like a screenshot of a phone screen. Tables get borders because a Markdown table
 * with no rules is unreadable once it is a page.
 */
export function printableHtml(title: string, markdown: string): string {
  const body = stripActiveContent(printer.parse(markdown, { async: false }) as string);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 18mm 16mm; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; }
  h1, h2, h3, h4 { font-family: Helvetica, Arial, sans-serif; line-height: 1.25; page-break-after: avoid; }
  h1 { font-size: 20pt; margin: 0 0 12pt; }
  h2 { font-size: 15pt; margin: 18pt 0 6pt; }
  h3 { font-size: 12.5pt; margin: 14pt 0 4pt; }
  p, li { orphans: 2; widows: 2; }
  code, pre { font-family: 'Roboto Mono', Consolas, monospace; font-size: 9.5pt; }
  pre { background: #f4f3ef; padding: 8pt 10pt; border-radius: 3pt; white-space: pre-wrap; page-break-inside: avoid; }
  code { background: #f4f3ef; padding: 1pt 3pt; border-radius: 2pt; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 10pt 0; padding-left: 10pt; border-left: 2pt solid #cfcbc0; color: #444; }
  table { border-collapse: collapse; width: 100%; margin: 10pt 0; page-break-inside: avoid; }
  th, td { border: 0.5pt solid #b8b4a8; padding: 4pt 6pt; text-align: left; vertical-align: top; }
  th { background: #f4f3ef; font-family: Helvetica, Arial, sans-serif; font-size: 10pt; }
  img { max-width: 100%; }
  hr { border: none; border-top: 0.5pt solid #cfcbc0; margin: 14pt 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
