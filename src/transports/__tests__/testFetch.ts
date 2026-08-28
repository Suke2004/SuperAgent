/**
 * A `FetchLike` test double.
 *
 * The transports take an injected fetch, which is what lets the whole transport
 * layer be tested in a plain `node` Jest environment with no React Native in
 * sight. This file is the other half of that bargain: enough of a Response to
 * satisfy `HttpClient`, and a stream implementation that hands back bytes in
 * whatever chunk boundaries a test asks for.
 *
 * Not named `*.test.ts`, so Jest treats it as a helper rather than a suite.
 */

import type { FetchLike, HeadersLike, ReadableStreamLike, RequestInitLike, ResponseLike } from '../fetchTypes';

export interface MockCall {
  url: string;
  init: RequestInitLike;
  /** The parsed request body, for asserting on wire shape. */
  body: Record<string, unknown> | undefined;
}

export function headers(values: Record<string, string> = {}): HeadersLike {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    get: (name) => lower.get(name.toLowerCase()) ?? null,
    forEach: (callback) => {
      for (const [key, value] of lower) callback(value, key);
    },
  };
}

/**
 * Headers without `forEach`, to exercise the probe-only fallback in
 * `collectHeaders`. Some fetch polyfills really do ship this way.
 */
export function headersWithoutForEach(values: Record<string, string> = {}): HeadersLike {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

export function jsonResponse(payload: unknown, status = 200, extraHeaders: Record<string, string> = {}): ResponseLike {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: headers({ 'content-type': 'application/json', ...extraHeaders }),
    text: () => Promise.resolve(text),
  };
}

/** A gateway-shaped error response: `{"error":{"message":...,"type":...}}`. */
export function gatewayErrorResponse(
  message: string,
  status: number,
  type = 'new_api_error',
  extraHeaders: Record<string, string> = {},
): ResponseLike {
  return jsonResponse({ error: { message, type } }, status, extraHeaders);
}

/**
 * A streaming response whose body yields exactly `chunks`, in order.
 *
 * Chunk boundaries are the point: a real gateway splits wherever the network
 * decides, so tests need to be able to split an SSE frame down the middle.
 */
export function sseResponse(
  chunks: string[],
  status = 200,
  extraHeaders: Record<string, string> = {},
): ResponseLike & { cancelled: () => string | undefined } {
  const encoder = new TextEncoder();
  const queue = chunks.map((chunk) => encoder.encode(chunk));
  let position = 0;
  let cancelReason: string | undefined;

  const body: ReadableStreamLike = {
    getReader: () => ({
      read: () => {
        if (cancelReason !== undefined || position >= queue.length) return Promise.resolve({ done: true });
        const value = queue[position];
        position += 1;
        return Promise.resolve({ done: false, value });
      },
      cancel: (reason?: unknown) => {
        cancelReason = String(reason);
      },
    }),
  };

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: headers({ 'content-type': 'text/event-stream', ...extraHeaders }),
    text: () => Promise.resolve(chunks.join('')),
    body,
    cancelled: () => cancelReason,
  };
}

/**
 * A 200 response with no readable body — what the stock React Native `fetch`
 * produces. `HttpClient` must still parse the buffered text rather than hang or
 * return nothing, because this is the failure mode that looks like it works.
 */
export function bufferedResponse(text: string): ResponseLike {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: headers({ 'content-type': 'text/event-stream' }),
    text: () => Promise.resolve(text),
    body: null,
  };
}

/** A stream that yields some events, then throws — a broken connection mid-reply. */
export function brokenSseResponse(chunks: string[], error: Error): ResponseLike {
  const encoder = new TextEncoder();
  const queue = chunks.map((chunk) => encoder.encode(chunk));
  let position = 0;

  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: headers({ 'content-type': 'text/event-stream' }),
    text: () => Promise.resolve(chunks.join('')),
    body: {
      getReader: () => ({
        read: () => {
          if (position >= queue.length) return Promise.reject(error);
          const value = queue[position];
          position += 1;
          return Promise.resolve({ done: false, value });
        },
        cancel: () => undefined,
      }),
    },
  };
}

export type MockResponder = ResponseLike | Error | ((call: MockCall) => ResponseLike | Error | Promise<ResponseLike>);

export interface MockFetch {
  fetch: FetchLike;
  calls: MockCall[];
  /** Bodies of every call, in order. Sugar for the common assertion. */
  bodies: () => (Record<string, unknown> | undefined)[];
  lastBody: () => Record<string, unknown> | undefined;
}

/**
 * A fetch that replays `responders` in order, one per call.
 *
 * Running out of responders throws rather than returning something plausible: a
 * test that makes an unexpected extra request should fail loudly, since an extra
 * request usually means a retry loop that shouldn't have run.
 */
export function createMockFetch(responders: MockResponder[]): MockFetch {
  const calls: MockCall[] = [];
  let index = 0;

  const fetch: FetchLike = async (url, init) => {
    const call: MockCall = {
      url,
      init,
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>),
    };
    calls.push(call);

    const responder = responders[index];
    index += 1;
    if (responder === undefined) {
      throw new Error(`Unexpected fetch call #${calls.length} to ${url} — the mock has no response left for it.`);
    }

    const resolved = typeof responder === 'function' ? await responder(call) : responder;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  };

  return {
    fetch,
    calls,
    bodies: () => calls.map((call) => call.body),
    lastBody: () => calls[calls.length - 1]?.body,
  };
}

/** Frame one SSE event the way both gateways do. */
export function sseFrame(data: unknown, event?: string): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`;
}

/** Drain an async generator into an array. */
export async function collect<T>(source: AsyncGenerator<T, void, undefined>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}
