/**
 * A file another app asked this one to open.
 *
 * Android's "Open with" list is an `ACTION_VIEW` intent, and the URI it carries arrives
 * in JavaScript through the same `Linking` channel as `jarvis://` deep links — so every
 * URL the app is opened with reaches one place and this module decides which of them is
 * a file to attach. The decision is separated from the doing for the usual reason: it is
 * a trust boundary, and a trust boundary should be readable and testable without a
 * device.
 *
 * **Only `content://` is accepted, and that is the whole point.** A content URI comes
 * from another app's document provider with a read grant attached, and cannot name a
 * path inside this app. A `file://` URI can — `file:///data/data/<package>/…` is this
 * app's own private storage, including its database — so an intent carrying one would be
 * asking the app to read its own files into a message the user might then send to a
 * model. Android has forbidden apps from handing out `file://` URIs since Nougat, so
 * refusing them costs nothing that works anyway.
 *
 * Nothing here sends. An inbound file lands in the composer exactly as a picked one
 * does, which is the same rule `app/new.tsx` follows for `jarvis://new?q=…`: an intent
 * is an untrusted request from another app, and one that could spend money on the user's
 * API key without a tap would be a hole rather than a feature.
 *
 * The Android *share sheet* is a different intent — `ACTION_SEND`, whose file arrives as
 * a parcelled `EXTRA_STREAM` rather than as the intent's data URI. React Native's
 * `Linking` does not expose extras, so sharing *to* this app needs a native module and
 * is deliberately not pretended at here.
 */

/** Longest file name kept. A provider's display name is not a trusted length. */
const MAX_NAME = 120;

/** A name is only useful if it carries an extension — that is what types the file. */
const EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

export type Incoming =
  /** A file to attach. `name` is empty when the URI carried none — ask the provider. */
  | { kind: 'file'; uri: string; name: string }
  /** Not a file hand-off: a deep link, a dev-server URL, anything else. Say nothing. */
  | { kind: 'ignored' }
  /** A file hand-off this app will not accept, with the sentence to show. */
  | { kind: 'refused'; why: string };

const IGNORED: Incoming = { kind: 'ignored' };

/** Trims a long name without destroying the extension the type is read from. */
function capped(name: string): string {
  if (name.length <= MAX_NAME) return name;
  const dot = name.lastIndexOf('.');
  return `${name.slice(0, MAX_NAME - (name.length - dot))}${name.slice(dot)}`;
}

/**
 * The file name inside a content URI, or `''` when it holds none.
 *
 * A SAF document id is a colon-separated pair whose second half may be a path —
 * `primary:Download/report.pdf` — while a downloads-provider id is `msf:42` and a media
 * id is a bare number. Only the first of those three contains a name, so this returns
 * one when it is there and nothing when it is not, rather than inventing `42.bin`.
 */
export function nameFromUri(uri: string): string {
  const path = uri.replace(/[?#].*$/, '');
  const segment = path.slice(path.lastIndexOf('/') + 1);
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    /* A malformed escape is not worth a failure; the raw segment still might parse. */
  }
  const cut = Math.max(decoded.lastIndexOf('/'), decoded.lastIndexOf(':'), decoded.lastIndexOf('\\'));
  const name = cut >= 0 ? decoded.slice(cut + 1) : decoded;
  return EXTENSION.test(name) ? capped(name) : '';
}

/**
 * What to do with a URL the app was opened with.
 *
 * `scheme` is the app's own, so its deep links are recognised as *not* being files —
 * passed in rather than imported to keep this module free of app configuration.
 */
export function incomingFile(url: string, scheme = 'jarvis'): Incoming {
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();

  if (lower.startsWith(`${scheme}:`)) return IGNORED;

  if (lower.startsWith('content://')) {
    return { kind: 'file', uri: trimmed, name: nameFromUri(trimmed) };
  }

  if (lower.startsWith('file://')) {
    return {
      kind: 'refused',
      why:
        'That file was handed over as a direct path rather than through the sharing system, ' +
        'which this app does not accept. Attach it from the composer instead.',
    };
  }

  return IGNORED;
}
