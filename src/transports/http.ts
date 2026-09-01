/**
 * Shared HTTP plumbing for both transports.
 *
 * Owns the things that must behave identically on both paths:
 *
 *  - an honest, static User-Agent (never another client's identity: the gateway
 *    enforces a client allowlist and circumventing it is a bannable offence),
 *  - retry policy — 429/5xx/network only, and only *before* the first byte of a
 *    stream, because retrying mid-stream would duplicate already-rendered tokens,
 *  - the drop-a-rejected-parameter-and-retry-once behaviour,
 *  - a connect timeout distinct from an idle timeout, since a legitimate stream
 *    can run for minutes but must not hang forever between chunks,
 *  - debug logging of every request, with the key redacted at the write boundary.
 *
 * `fetch` is injected. In the app it is `expo/fetch`, which can read a streaming
 * response body; React Native's global `fetch` cannot, and buffers the whole
 * response instead. In tests it is a plain mock, which is what keeps the entire
 * suite runnable in a `node` environment.
 */

import { GatewayError, classifyHttpError, classifyThrown } from './errors';
import { DEFAULT_RETRY_POLICY, NO_RETRY_POLICY, withRetry, type RetryPolicy, type RetryAttempt } from './retry';
import { SseParser, type SseEvent } from './sse';
import { Utf8StreamDecoder } from './utf8';
import { debugLog, type RequestHandle } from '../lib/log';
import type { FetchLike, HeadersLike, ResponseLike, RequestInitLike, StreamReaderLike } from './fetchTypes';
import type { TransportKind } from './types';

/**
 * Honest and static. Identifies this app and nothing else.
 *
 * If the gateway's allowlist rejects it, the fix is to get the app approved — not
 * to pretend to be something else. The 401 diagnostic says exactly that.
 */
export const USER_AGENT = 'AgentRouterMobile/1.0 (Android)';

/** Time to wait for response headers. A stream may then run far longer. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Maximum silence between stream chunks before we treat the stream as dead. */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/**
 * The spec asks for "retry once without it". One drop keeps that promise literal
 * and, more importantly, bounds the extra round trips spent against an
 * undocumented rate limit. Two bad parameters surface as a second error naming
 * the second parameter, which is clearer than silently retrying four times.
 */
export const MAX_PARAM_DROPS = 1;

/* -------------------------------------------------------------------------- */
/* Structural fetch types                                                      */
/* -------------------------------------------------------------------------- */

// Declared in `fetchTypes.ts` and re-exported here, so callers can keep importing
// them from the module that uses them.
export type {
  FetchLike,
  HeadersLike,
  ReadableStreamLike,
  RequestInitLike,
  ResponseLike,
  StreamReaderLike,
} from './fetchTypes';

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export interface HttpClientOptions {
  transport: TransportKind;
  baseUrl: string;
  apiKey: string;
  fetchImpl: FetchLike;
  /** Auth style. The gateway wants Bearer on both paths. */
  authHeader?: 'bearer' | 'x-api-key';
  /** Static extra headers, e.g. `anthropic-version`. Must never contain the key. */
  headers?: Record<string, string>;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  retryPolicy?: RetryPolicy;
}

export interface ParamDropInfo {
  param: string;
  /** The gateway's own message, verbatim. */
  message: string;
}

export interface SendOptions {
  /** Path relative to the base URL, e.g. `/messages` or `/chat/completions`. */
  path: string;
  method?: string;
  /** Body object. Treated as immutable; a rejected key is removed from a copy. */
  body?: Record<string, unknown>;
  /**
   * Per-request headers merged over the client's static set, e.g. `anthropic-beta`
   * for a model that needs a specific beta flag. Must never contain the key.
   */
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
  /** Top-level body keys that may be dropped if the gateway rejects them. */
  optionalParams?: readonly string[];
  onParamDropped?: (info: ParamDropInfo) => void;
  onRetry?: (info: RetryAttempt) => void;
  /** Called with the debug log id of every request opened, including retries. */
  onRequest?: (id: string) => void;
  retryPolicy?: RetryPolicy;
}

interface OpenedRequest {
  response: ResponseLike;
  entry: RequestHandle;
  cleanup: () => void;
}

export class HttpClient {
  readonly transport: TransportKind;
  readonly baseUrl: string;

  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly authHeader: 'bearer' | 'x-api-key';
  private readonly extraHeaders: Record<string, string>;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly retryPolicy: RetryPolicy;

  constructor(options: HttpClientOptions) {
    this.transport = options.transport;
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl;
    this.authHeader = options.authHeader ?? 'bearer';
    this.extraHeaders = options.headers ?? {};
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  url(path: string): string {
    if (!path) return this.baseUrl;
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private buildHeaders(streaming: boolean, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: streaming ? 'text/event-stream' : 'application/json',
      ...this.extraHeaders,
      ...(extra ?? {}),
    };
    // Credential and identity headers are enforced here, not merely defaulted.
    // `safeHeaders` in the providers store screens what a user can save, but this is
    // the only place every request passes through: a lowercase `authorization` used
    // to slip past the capitalised default and leave the native layer to pick
    // between two conflicting entries, and a `User-Agent` set here would be exactly
    // the client impersonation this app refuses to do.
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase();
      if (lower === 'authorization' || lower === 'x-api-key' || lower === 'user-agent') delete headers[name];
    }
    headers['User-Agent'] = USER_AGENT;
    // Auth goes on last so no caller-supplied header can displace it.
    if (this.authHeader === 'bearer') headers.Authorization = `Bearer ${this.apiKey}`;
    else headers['x-api-key'] = this.apiKey;
    return headers;
  }

  /* ---------------------------------------------------------------------- */
  /* JSON                                                                    */
  /* ---------------------------------------------------------------------- */

  /** Non-streaming request. Retries per policy, and drops a rejected param once. */
  async json<T>(options: SendOptions): Promise<T> {
    let body = options.body;
    let drops = 0;
    let droppedParam: string | undefined;

    for (;;) {
      try {
        return await this.jsonOnce<T>(options, body, droppedParam);
      } catch (error) {
        const gatewayError = error instanceof GatewayError ? error : GatewayError.wrap(error);
        const dropped = this.tryDropParam(gatewayError, options, body, drops);
        if (!dropped) throw gatewayError;
        drops += 1;
        body = dropped.body;
        droppedParam = dropped.info.param;
        options.onParamDropped?.(dropped.info);
      }
    }
  }

  private async jsonOnce<T>(
    options: SendOptions,
    body: Record<string, unknown> | undefined,
    droppedParam: string | undefined,
  ): Promise<T> {
    const policy = options.retryPolicy ?? this.retryPolicy;
    return withRetry(
      async () => {
        const opened = await this.send(options, body, false, droppedParam);
        try {
          const text = await opened.response.text();
          if (!opened.response.ok) {
            const error = this.toGatewayError(opened.response, text, options, body);
            opened.entry.fail(error);
            throw error;
          }
          opened.entry.finish(text);
          return parseJsonBody<T>(text, this.url(options.path));
        } finally {
          opened.cleanup();
        }
      },
      policy,
      this.retryHooks(options),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* SSE                                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Streaming request, yielding parsed SSE events.
   *
   * Retries and parameter drops apply only to failures raised before the first
   * event is yielded. Once tokens have reached the caller, a retry would
   * re-render text the user has already seen, so a mid-stream failure is
   * surfaced instead of being papered over.
   */
  async *sse(options: SendOptions): AsyncGenerator<SseEvent, void, undefined> {
    const policy = options.retryPolicy ?? this.retryPolicy;
    let body = options.body;
    let drops = 0;
    let droppedParam: string | undefined;

    for (;;) {
      let opened: OpenedRequest;
      try {
        opened = await withRetry(
          async () => {
            const attempt = await this.send(options, body, true, droppedParam);
            if (!attempt.response.ok) {
              const text = await attempt.response.text().catch(() => '');
              const error = this.toGatewayError(attempt.response, text, options, body);
              attempt.entry.fail(error);
              attempt.cleanup();
              throw error;
            }
            return attempt;
          },
          policy,
          this.retryHooks(options),
        );
      } catch (error) {
        const gatewayError = error instanceof GatewayError ? error : GatewayError.wrap(error);
        const dropped = this.tryDropParam(gatewayError, options, body, drops);
        if (!dropped) throw gatewayError;
        drops += 1;
        body = dropped.body;
        droppedParam = dropped.info.param;
        options.onParamDropped?.(dropped.info);
        continue;
      }

      yield* this.readSse(opened, options);
      return;
    }
  }

  private async *readSse(opened: OpenedRequest, options: SendOptions): AsyncGenerator<SseEvent, void, undefined> {
    const { response, entry, cleanup } = opened;
    const url = this.url(options.path);
    const parser = new SseParser();
    const decoder = new Utf8StreamDecoder();

    if (!response.body) {
      // Either the gateway ignored `stream: true`, or the injected fetch cannot
      // expose a streaming body. Parse the buffered text so the request still
      // succeeds, and record which it was — this is exactly the failure mode
      // where naive SSE handling "works" but never renders incrementally.
      const text = await response.text();
      entry.finish(text);
      cleanup();
      debugLog.message(
        'warn',
        'transport',
        'Response had no readable body stream; parsed the buffered text instead. ' +
          'In the app this means the injected fetch is not expo/fetch, and streaming will not be incremental.',
        { url },
      );
      for (const event of parser.push(text)) yield event;
      for (const event of parser.flush()) yield event;
      return;
    }

    const reader = response.body.getReader();
    let finished = false;
    try {
      for (;;) {
        const chunk = await this.readWithIdleTimeout(reader, url, options.signal);
        if (chunk.done) break;
        if (!chunk.value || chunk.value.length === 0) continue;

        const text = decoder.decode(chunk.value);
        if (!text) continue;
        entry.streamChunk(text);
        for (const event of parser.push(text)) yield event;
      }

      const tail = decoder.flush();
      if (tail) {
        entry.streamChunk(tail);
        for (const event of parser.push(tail)) yield event;
      }
      for (const event of parser.flush()) yield event;
      finished = true;
      entry.finish();
    } catch (error) {
      const gatewayError = classifyThrown(error, { url, transport: this.transport });
      entry.fail(gatewayError);
      throw gatewayError;
    } finally {
      if (!finished) {
        // The consumer stopped early (the stop button, or a thrown error). Cancel
        // so the socket closes now instead of leaking until the gateway times out.
        try {
          await reader.cancel('consumer stopped');
        } catch {
          /* already closed */
        }
      }
      cleanup();
    }
  }

  /**
   * Read one chunk, failing if the stream goes silent for too long.
   *
   * A stalled socket otherwise leaves the UI in "streaming" forever, with no way
   * to tell a slow model from a dead connection.
   */
  private async readWithIdleTimeout(
    reader: StreamReaderLike,
    url: string,
    signal?: AbortSignal,
  ): Promise<{ done: boolean; value?: Uint8Array | undefined }> {
    if (signal?.aborted) throw new GatewayError({ kind: 'aborted', message: 'Request stopped.', url });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new GatewayError({
                kind: 'network',
                message: `The gateway sent nothing for ${Math.round(
                  this.idleTimeoutMs / 1000,
                )}s, so the stream was abandoned.`,
                hint: 'The connection stalled mid-response. Retry, or try the backup domain from Settings → Providers.',
                url,
              }),
            );
          }, this.idleTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Send                                                                    */
  /* ---------------------------------------------------------------------- */

  private async send(
    options: SendOptions,
    body: Record<string, unknown> | undefined,
    streaming: boolean,
    droppedParam: string | undefined,
  ): Promise<OpenedRequest> {
    const url = this.url(options.path);
    const method = options.method ?? (body ? 'POST' : 'GET');
    const headers = this.buildHeaders(streaming, options.extraHeaders);
    const serialised = body ? JSON.stringify(body) : undefined;

    const entry = debugLog.request({
      transport: this.transport,
      method,
      url,
      headers,
      ...(body ? { body } : {}),
      ...(droppedParam ? { droppedParam } : {}),
    });
    options.onRequest?.(entry.id);

    // Connect timeout only. Once headers arrive the idle timeout takes over, so a
    // legitimately long stream is never cut off by a total-duration limit.
    const controller = new AbortController();
    let timedOut = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.connectTimeoutMs);
    const clearConnectTimer = () => {
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
    };

    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();

    const cleanup = () => {
      clearConnectTimer();
      options.signal?.removeEventListener('abort', onExternalAbort);
    };

    const init: RequestInitLike = { method, headers, signal: controller.signal };
    if (serialised !== undefined) init.body = serialised;

    let response: ResponseLike;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      cleanup();
      // A connect-timeout abort and a user abort look identical at this level, and
      // the difference matters: one is retryable, the other must never be.
      const gatewayError = options.signal?.aborted
        ? new GatewayError({ kind: 'aborted', message: 'Request stopped.', url, cause: error })
        : timedOut
          ? new GatewayError({
              kind: 'network',
              message: `No response from the gateway within ${Math.round(this.connectTimeoutMs / 1000)}s.`,
              hint: 'The gateway did not answer. Check connectivity, then try the backup domain (https://ps.air-outer.com).',
              url,
              cause: error,
            })
          : classifyThrown(error, { url, transport: this.transport });
      entry.fail(gatewayError);
      throw gatewayError;
    }

    // Headers are in; the connect timeout has done its job.
    clearConnectTimer();
    entry.gotResponse(response.status, response.statusText, collectHeaders(response.headers));

    return { response, entry, cleanup };
  }

  private retryHooks(options: SendOptions) {
    return {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    };
  }

  private toGatewayError(
    response: ResponseLike,
    text: string,
    options: SendOptions,
    body: Record<string, unknown> | undefined,
  ): GatewayError {
    return classifyHttpError({
      status: response.status,
      statusText: response.statusText,
      body: text,
      headers: collectHeaders(response.headers),
      sentParams: presentOptionalKeys(body, options.optionalParams),
      url: this.url(options.path),
      transport: this.transport,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Parameter drop                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Decide whether `error` is a rejected-parameter failure worth retrying without.
   *
   * Assume any optional parameter may be silently dropped or rejected: this is the
   * "rejected" half. Returns the reduced body, or null when the error isn't one we
   * can usefully retry — including when the named parameter isn't in the body,
   * since removing nothing would produce an identical request.
   */
  private tryDropParam(
    error: GatewayError,
    options: SendOptions,
    body: Record<string, unknown> | undefined,
    dropsSoFar: number,
  ): { body: Record<string, unknown>; info: ParamDropInfo } | null {
    if (dropsSoFar >= MAX_PARAM_DROPS) return null;
    if (error.kind !== 'unsupported_param') return null;
    if (!body || !error.param) return null;

    const allowed = options.optionalParams ?? [];
    if (allowed.length > 0 && !allowed.includes(error.param)) return null;
    if (!(error.param in body)) return null;

    const reduced = { ...body };
    delete reduced[error.param];

    debugLog.message('warn', 'transport', `Dropped rejected parameter "${error.param}" and retried once.`, {
      param: error.param,
      gatewayMessage: error.message,
      url: this.url(options.path),
    });
    return { body: reduced, info: { param: error.param, message: error.message } };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function collectHeaders(headers: HeadersLike): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  // Fall back to probing only the headers we actually read.
  for (const name of ['request-id', 'x-request-id', 'x-oneapi-request-id', 'retry-after', 'content-type']) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

function presentOptionalKeys(
  body: Record<string, unknown> | undefined,
  optionalParams: readonly string[] | undefined,
): readonly string[] {
  if (!body) return [];
  if (!optionalParams) return Object.keys(body);
  return optionalParams.filter((key) => key in body);
}

function parseJsonBody<T>(text: string, url: string): T {
  if (!text.trim()) {
    throw new GatewayError({
      kind: 'parse',
      message: 'The gateway returned a success status with an empty body.',
      hint: 'Open the debug log to see the raw response.',
      url,
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new GatewayError({
      kind: 'parse',
      message: `The gateway returned a success status but the body was not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      hint: 'Open the debug log to see the raw bytes. A proxy or captive portal may be rewriting the response.',
      raw: text.slice(0, 2000),
      url,
    });
  }
}

export { NO_RETRY_POLICY };
