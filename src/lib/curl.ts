/**
 * A debug log request, as a `curl` command.
 *
 * The point is to be able to take one turn out of the app and replay it against the
 * gateway from a terminal — the fastest way to find out whether a bad answer was the
 * prompt or the app. So the command is built from the log entry, which means it is
 * built from what actually went over the wire rather than from what the request
 * builder was asked for.
 *
 * The key is not in it, and cannot be: `@/lib/log` redacts at the boundary, so the
 * entry never held one. The placeholder is left in place and named in the leading
 * comment rather than dropped, because a command that 401s with an obvious hole in it
 * is easier to fix than one that 401s with the header missing.
 */

import type { RequestEntry } from './log';
import { safeStringify } from './log';

/** `'` cannot be escaped inside a POSIX single-quoted string; it has to be closed. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function toCurl(entry: RequestEntry): string {
  const parts = [`curl ${shellQuote(entry.url)}`];
  if (entry.method !== 'GET') parts.push(`-X ${entry.method}`);
  // Streaming responses: without this curl buffers and the terminal shows nothing
  // until the turn is over, which defeats the point of replaying a stream.
  if (entry.headers.accept?.includes('event-stream')) parts.push('-N');

  for (const [name, value] of Object.entries(entry.headers)) {
    parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
  }

  if (entry.body !== undefined) {
    const body = typeof entry.body === 'string' ? entry.body : safeStringify(entry.body);
    parts.push(`--data-raw ${shellQuote(body)}`);
  }

  return [
    '# The key is redacted. Put yours in the header below before running this.',
    parts.join(' \\\n  '),
  ].join('\n');
}
