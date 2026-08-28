/**
 * Link and image targets from model output, checked before they reach `openURL`.
 *
 * Everything rendered in a transcript was written by a model, and a link is the
 * one markdown construct that hands a string to the operating system. Android
 * will resolve an intent for schemes we have no business opening — `intent://`
 * targets another app's components, `file://` reaches our own sandbox — so this
 * is a scheme allowlist, not a blocklist.
 */

/**
 * The schemes a chat link may plausibly and safely mean.
 *
 * `https?` additionally requires a host character after the slashes, so a bare
 * `http://` is rejected rather than handed to the platform to guess at.
 */
const ALLOWED = /^(?:https?:\/\/[^/]|mailto:.|tel:.)/;

/**
 * Characters that must not survive into a URL: C0 and C1 controls, space, the
 * soft hyphen, and the zero-width and bidi-override family.
 *
 * Browsers strip tab, newline and NUL *before* reading the scheme, which is what
 * makes `java\nscript:` work as an attack. Stripping them first means the scheme
 * test sees what the platform would see. Spaces go too — a URL cannot contain one
 * unescaped, so anything relying on a raw space is malformed or evasive.
 *
 * Built from a string rather than written as a literal so the source stays
 * reviewable: as a literal this is a run of invisible bytes, one of them a NUL.
 */
const STRIPPED = new RegExp(
  '[\\u0000-\\u0020\\u007f-\\u009f\\u00ad\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\ufeff]',
  'g',
);

/**
 * The URL to open, or `null` to render the label as plain text instead.
 */
export function safeHref(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(STRIPPED, '');
  if (!cleaned) return null;
  // Lowercased only for the test: the path and query are case-sensitive.
  if (!ALLOWED.test(cleaned.toLowerCase())) return null;
  return cleaned;
}
