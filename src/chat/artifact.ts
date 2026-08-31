/**
 * Artifacts: rendering a code block instead of only reading it.
 *
 * A model that writes an SVG chart or a small HTML page has written something that
 * only means anything rendered, and the transcript shows it as source. This module is
 * the pure half of the preview: which fences can be rendered at all, and the document
 * they are rendered inside.
 *
 * There is no new content block and no wire change. An artifact is a *view* of a fence
 * that is already in the transcript, so every message ever stored gets the button and
 * nothing about the request changes.
 *
 * The document is the security boundary, and it is built here so it can be tested
 * without a device. Three things do the work:
 *
 * 1. **A `default-src 'none'` CSP.** The content came from a model, and a model that
 *    was told what to write by a web page it fetched or a document in a project can be
 *    told to write `<img src="https://…?data=">`. With no network sources permitted
 *    there is nothing for the page to talk to, so a hostile artifact has nothing to
 *    exfiltrate the transcript *to*.
 * 2. **Inline script is allowed, remote script is not.** An interactive artifact is
 *    most of the point, and inline code that cannot reach the network or the app's
 *    storage is a calculator in a locked room. Loading somebody else's script is the
 *    part that is not survivable, and that is what `script-src` refuses.
 * 3. **No `<base>`, no navigation.** Kept honest by the WebView host, not here: this
 *    module cannot stop a link, so the host blocks every load that is not the document
 *    itself. See `@/components/ArtifactPreview`.
 */

/** What a fence can be shown as, or `null` when it can only be read. */
export type ArtifactKind = 'html' | 'svg';

/**
 * Fence languages that are worth rendering, by the tag people actually type.
 *
 * Deliberately short. A language earns a place here by being *unreadable* as source —
 * a chart, a diagram, a laid-out page — not by being renderable in principle. Python
 * is not here because running it is a different feature with a different threat model
 * (`run_code`), and Markdown is not here because the transcript already renders it.
 */
const KINDS: Record<string, ArtifactKind> = {
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  svg: 'svg',
};

/**
 * Whether this fence can be previewed, and as what.
 *
 * The tag is trusted over the content: sniffing for `<svg` would offer a preview for a
 * shell snippet that happens to echo one, and a fence whose tag is wrong is a fence
 * whose author did not want it rendered.
 */
export function artifactKind(lang: string | undefined, code: string): ArtifactKind | null {
  if (!code.trim()) return null;
  const tag = (lang ?? '').trim().toLowerCase();
  return KINDS[tag] ?? null;
}

/**
 * The content security policy every artifact is rendered under.
 *
 * `data:` is permitted for images and fonts because an inline SVG or a base64 sprite is
 * self-contained — it carries no request, so there is no channel in it. Everything that
 * would reach off the device is absent rather than restricted: no `connect-src`, no
 * `frame-src`, no `form-action` beyond the `'none'` default.
 */
const CSP =
  "default-src 'none'; " +
  "style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; " +
  'img-src data:; ' +
  'font-src data:; ' +
  "form-action 'none'; " +
  "base-uri 'none'";

/** Enough CSS to make a bare fragment legible on a phone without restyling its content. */
const FRAME_CSS =
  'html,body{margin:0;padding:0;background:#fff;color:#111;' +
  'font:16px/1.5 -apple-system,Roboto,sans-serif;overflow-wrap:break-word}' +
  'body{padding:12px}svg,img,canvas,video{max-width:100%;height:auto}';

/**
 * The document to load into the WebView.
 *
 * HTML is used as the author wrote it, with the policy and the frame styles injected
 * ahead of it rather than around it: a page with its own `<head>` still gets the CSP
 * first, because the first policy in a document wins and a second one can only narrow
 * it. SVG is wrapped, because an SVG on its own is a fragment and a WebView handed one
 * as `text/html` renders it at whatever size it likes.
 */
export function artifactDocument(code: string, kind: ArtifactKind): string {
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${FRAME_CSS}</style>`;
  if (kind === 'svg') {
    return `<!DOCTYPE html><html><head>${head}</head><body>${code}</body></html>`;
  }
  // Injected rather than concatenated when the author supplied a `<head>`: appending a
  // second document around theirs would nest `<html>` and leave the policy after the
  // content it is meant to constrain. A page with an `<html>` but no `<head>` gets the
  // same treatment for the same reason.
  const match = /<head[^>]*>/i.exec(code) ?? /<html[^>]*>/i.exec(code);
  if (match) {
    const at = match.index + match[0].length;
    return code.slice(0, at) + head + code.slice(at);
  }
  return `<!DOCTYPE html><html><head>${head}</head><body>${code}</body></html>`;
}
