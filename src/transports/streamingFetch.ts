/**
 * The streaming `fetch`, isolated in one file.
 *
 * React Native's global `fetch` is built on XMLHttpRequest and has no readable
 * `response.body`. Using it for SSE appears to work — events parse, text renders —
 * and then you notice the whole reply lands at once, because the body was buffered
 * to completion first. `expo/fetch` is a real streaming implementation and exposes
 * `response.body` as a ReadableStream.
 *
 * This module exists so nothing else in the codebase imports `expo/fetch`, which
 * keeps the transports (and their tests) free of any React Native dependency. It
 * is the only place that touches the runtime's fetch.
 */

// `expo/fetch` is a subpath export of the `expo` package, resolved by Metro.
import { fetch as expoFetch } from 'expo/fetch';

import type { FetchLike, RequestInitLike, ResponseLike } from './fetchTypes';

/**
 * The app's fetch. Cast rather than adapted: `expo/fetch` already matches the
 * structural shape {@link FetchLike} describes, and wrapping it would add a layer
 * that could only get in the way of the stream.
 */
export const streamingFetch: FetchLike = ((url: string, init: RequestInitLike) =>
  expoFetch(url, init as Parameters<typeof expoFetch>[1]) as unknown as Promise<ResponseLike>) as FetchLike;

/**
 * True when the injected fetch can actually stream.
 *
 * Called once at startup and reported in Settings, because a silent fallback to
 * the buffering `fetch` is the single most confusing failure mode in this app: the
 * only symptom is that streaming stops feeling like streaming.
 */
export function supportsStreaming(): boolean {
  return typeof expoFetch === 'function';
}
