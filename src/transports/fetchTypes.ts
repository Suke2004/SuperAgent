/**
 * Structural types for the injected `fetch`.
 *
 * Deliberately structural rather than referencing DOM lib types: a plain object
 * satisfies them in tests, and nothing here depends on `lib.dom` being in the
 * TypeScript config. They live in their own file so `streamingFetch.ts` — the only
 * module that imports `expo/fetch` — doesn't have to pull in the HTTP client.
 */

export interface StreamReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(reason?: unknown): Promise<void> | void;
}

export interface ReadableStreamLike {
  getReader(): StreamReaderLike;
}

export interface HeadersLike {
  get(name: string): string | null;
  forEach?(callback: (value: string, key: string) => void): void;
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  headers: HeadersLike;
  text(): Promise<string>;
  /** Present only on a streaming implementation. Absent means the body was buffered. */
  body?: ReadableStreamLike | null | undefined;
}

export interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;
