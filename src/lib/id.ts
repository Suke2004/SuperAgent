/**
 * Local id generation.
 *
 * Deliberately dependency-free: this module is imported by pure-logic code that
 * runs under Jest in a `node` environment, so it must not pull in `expo-crypto`.
 * These ids only need to be unique within one device's SQLite file, not
 * cryptographically random. PKCE and OAuth state use `expo-crypto` directly.
 */

let counter = 0;

/** Monotonic-ish, sortable, collision-free-in-practice local id. */
export function newId(prefix = ''): string {
  counter = (counter + 1) & 0xffff;
  const time = Date.now().toString(36);
  const seq = counter.toString(36).padStart(4, '0');
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}${time}-${seq}-${rand}`;
}

/** Short id for things a human reads in the UI (e.g. a debug request label). */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}
