/**
 * The slice of `node:sqlite` the database tests use.
 *
 * Declared locally rather than by installing `@types/node`: the tests need one
 * built-in module, and pulling the whole Node global type set into a React
 * Native app has a habit of shadowing RN's own `setTimeout`, `Buffer` and
 * `console` declarations with subtly different signatures — a large change to
 * the types the *app* compiles against, to type two test files.
 *
 * Deliberately narrow. If a test needs more of the API, widen this to match the
 * documented signature rather than loosening what is here to `any`.
 */

declare module 'node:sqlite' {
  interface StatementSync {
    run(...params: (string | number | null)[]): { changes: number; lastInsertRowid: number };
    get(...params: (string | number | null)[]): unknown;
    all(...params: (string | number | null)[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
