/**
 * Every URL the app is opened with, before the router sees it.
 *
 * expo-router calls this for the launch URL and for each one that arrives while running,
 * and routes to whatever it returns. It exists here for one reason: an Android "open
 * with" intent arrives as a `content://` URI, which matches no route in this app, so
 * without this hook opening a PDF with SuperAgent would land on the not-found screen.
 *
 * The decision — whether a URL is a file hand-off at all, and whether it is one this app
 * will touch — is `@/chat/incoming`, which is pure and tested. This file is only the
 * plumbing: a file becomes `/new?file=…`, which resolves a conversation and stages the
 * attachment in its composer, and everything else is passed through untouched so
 * `jarvis://` deep links and the dev server keep working.
 *
 * Errors are caught rather than allowed out: a throw here happens before any React tree
 * exists, so it takes the app down with no screen to say why.
 */

import { incomingFile } from '@/chat/incoming';
import { log } from '@/lib/log';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const incoming = incomingFile(path);
    if (incoming.kind === 'file') {
      const query = new URLSearchParams({ file: incoming.uri, name: incoming.name });
      return `/new?${query.toString()}`;
    }
    if (incoming.kind === 'refused') {
      return `/new?${new URLSearchParams({ refused: incoming.why }).toString()}`;
    }
    return path;
  } catch (error) {
    log.warn('incoming', 'could not read an inbound url', error);
    return path;
  }
}
