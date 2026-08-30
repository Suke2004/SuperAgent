/**
 * The MCP client: one request, one short-lived session.
 *
 * Two transports, both HTTP:
 *
 *  - **Streamable HTTP** (the current spec). POST the JSON-RPC message; the answer
 *    comes back either as `application/json` or as an SSE stream carrying it. Both
 *    are handled, because which one you get is the server's choice, not ours.
 *  - **HTTP+SSE** (the 2024-11-05 spec, still what a lot of deployments serve). GET
 *    the URL to open a stream, read the `endpoint` event for a POST URL, then POST
 *    messages there and read the replies off the GET stream.
 *
 * There is no stdio path and no code that could grow one: {@link parseServerUrl}
 * rejects the scheme at the field the user types it into.
 *
 * ponytail: one session per call — initialize, the call, close. A tool that keeps
 * per-session state on the server (a cursor, a temp directory) will not see it
 * again on the next call. Hold the session open across calls if that turns out to
 * matter; it costs one round trip per call today and no lifecycle bugs.
 */

import {
  initializeParams,
  MCP_PROTOCOL_VERSION,
  negotiatedVersion,
  nextCursor,
  parseRpcMessage,
  promptsFrom,
  renderCallResult,
  resourcesFrom,
  rpcNotification,
  rpcRequest,
  serverIdentity,
  toolsFrom,
} from './protocol';
import type { McpCallResult, McpPrompt, McpResource, McpTool, McpTransportKind } from './protocol';
import { USER_AGENT } from '@/transports/http';
import { SseParser } from '@/transports/sse';
import { Utf8StreamDecoder } from '@/transports/utf8';
import type { FetchLike, RequestInitLike, ResponseLike } from '@/transports/fetchTypes';

/** Time to wait for headers. MCP calls are requests, not long-lived streams. */
export const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Ceiling on one whole call, including a tool that runs for a while.
 *
 * A tool that never returns must not hang the turn: the loop needs an answer to put
 * in a `tool_result`, and "the server timed out" is an answer.
 */
export const CALL_TIMEOUT_MS = 60_000;

/** Bound on `tools/list` paging, so a server cannot page this app forever. */
const MAX_PAGES = 20;

export class McpError extends Error {
  constructor(
    message: string,
    /** True when re-authenticating could fix it: a 401 or a 403 from the server. */
    readonly needsAuth = false,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export interface McpClientOptions {
  url: string;
  transport: McpTransportKind;
  fetchImpl: FetchLike;
  /** Bearer token, when the server uses one. Never logged; never persisted here. */
  token?: string;
  /** Extra headers the user configured, e.g. `X-Api-Key`. */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface Discovery {
  serverInfo: string;
  protocolVersion: string;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
}

export class McpClient {
  private readonly options: McpClientOptions;
  private nextId = 1;

  constructor(options: McpClientOptions) {
    this.options = options;
  }

  /**
   * Everything the settings screen needs, in one session.
   *
   * `resources/list` and `prompts/list` are optional: a server that does not
   * implement them answers `-32601`, which is not a connection failure and must not
   * be presented as one.
   */
  async discover(): Promise<Discovery> {
    return this.session(async (session) => {
      const tools: McpTool[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result: Record<string, unknown> = await session.call(
          'tools/list',
          cursor ? { cursor } : undefined,
        );
        tools.push(...toolsFrom(result));
        cursor = nextCursor(result);
        if (!cursor) break;
      }

      const resources = await session.optional('resources/list');
      const prompts = await session.optional('prompts/list');

      return {
        serverInfo: session.serverInfo,
        protocolVersion: session.protocolVersion,
        tools,
        resources: resources ? resourcesFrom(resources) : [],
        prompts: prompts ? promptsFrom(prompts) : [],
      };
    });
  }

  /**
   * Call one tool.
   *
   * Errors become error *results*: a thrown exception here would leave the model's
   * `tool_use` unanswered, and an unanswered call makes every later request in the
   * conversation invalid. The `needsAuth` case is the exception the store catches,
   * because "your token expired" is not something the model can act on.
   */
  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    return this.session(async (session) => {
      const result = await session.call('tools/call', {
        name,
        arguments: (args ?? {}) as Record<string, unknown>,
      });
      return renderCallResult(result);
    });
  }

  /** Read one resource, as text. */
  async readResource(uri: string): Promise<McpCallResult> {
    return this.session(async (session) => {
      const result = await session.call('resources/read', { uri });
      const contents = Array.isArray(result.contents) ? result.contents : [];
      const text = contents
        .map((entry) =>
          typeof entry === 'object' && entry !== null && typeof (entry as { text?: unknown }).text === 'string'
            ? (entry as { text: string }).text
            : '',
        )
        .filter(Boolean)
        .join('\n');
      return { content: text || 'The resource was empty.' };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Session                                                               */
  /* ---------------------------------------------------------------------- */

  private async session<T>(body: (session: Session) => Promise<T>): Promise<T> {
    const session =
      this.options.transport === 'sse' ? await this.openLegacySession() : await this.openStreamableSession();
    try {
      return await body(session);
    } finally {
      session.close();
    }
  }

  private headers(accept: string, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: accept,
      'User-Agent': USER_AGENT,
      ...(this.options.headers ?? {}),
      ...(extra ?? {}),
    };
    // Auth last, so no configured header can displace it.
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    return headers;
  }

  private async fetchWithTimeout(url: string, init: RequestInitLike, ms: number): Promise<ResponseLike> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await this.options.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw new McpError(
        controller.signal.aborted
          ? `The server did not answer within ${Math.round(ms / 1000)}s.`
          : `The server could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Streamable HTTP: every message is a POST to the one URL.
   *
   * `Mcp-Session-Id` from the initialize response is echoed on later requests, which
   * is what makes the three calls in `discover` one session rather than three.
   */
  private async openStreamableSession(): Promise<Session> {
    const url = this.options.url;
    let sessionId: string | null = null;
    let version = MCP_PROTOCOL_VERSION;

    const post = async (message: unknown, id: number | null, timeoutMs: number): Promise<Record<string, unknown>> => {
      const response = await this.fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: this.headers('application/json, text/event-stream', {
            'MCP-Protocol-Version': version,
            ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
          }),
          body: JSON.stringify(message),
        },
        timeoutMs,
      );

      if (!response.ok) throw await httpFailure(response);
      const header = response.headers.get('mcp-session-id');
      if (header) sessionId = header;
      // A notification gets a 202 with no body, and nothing is waiting on it.
      if (id === null) return {};
      return readRpcResult(response, id);
    };

    /** One request, with its id captured before the POST rather than after it. */
    const request = async (
      method: string,
      params: Record<string, unknown> | undefined,
      timeoutMs: number,
    ): Promise<Record<string, unknown>> => {
      const id = this.nextId++;
      return post(rpcRequest(id, method, params), id, timeoutMs);
    };

    const initialise = await request('initialize', initializeParams(), CONNECT_TIMEOUT_MS);
    version = negotiatedVersion(initialise);
    // Required by the spec, and some servers reject calls made before it.
    await post(rpcNotification('notifications/initialized'), null, CONNECT_TIMEOUT_MS).catch(() => ({}));

    const timeoutMs = this.options.timeoutMs ?? CALL_TIMEOUT_MS;
    return {
      serverInfo: serverIdentity(initialise),
      protocolVersion: version,
      call: (method, params) => request(method, params, timeoutMs),
      optional: (method) => optional(() => request(method, undefined, timeoutMs)),
      close: () => {
        if (!sessionId) return;
        // Best effort: the session expires on its own, and a failed DELETE must not
        // turn a successful call into an error.
        void this.fetchWithTimeout(
          url,
          { method: 'DELETE', headers: this.headers('application/json', { 'Mcp-Session-Id': sessionId }) },
          CONNECT_TIMEOUT_MS,
        ).catch(() => undefined);
      },
    };
  }

  /**
   * HTTP+SSE: a GET stream for replies, a POST endpoint for requests.
   *
   * The stream is opened once per session and read by whichever call is waiting, so
   * a server that interleaves log notifications with replies is fine — the reader
   * skips anything that is not the id it wants.
   */
  private async openLegacySession(): Promise<Session> {
    const response = await this.fetchWithTimeout(
      this.options.url,
      { method: 'GET', headers: this.headers('text/event-stream') },
      CONNECT_TIMEOUT_MS,
    );
    if (!response.ok) throw await httpFailure(response);
    if (!response.body) {
      throw new McpError(
        'The SSE stream had no readable body. This build cannot stream, so the HTTP+SSE transport will not work — ' +
          'try the Streamable HTTP transport instead.',
      );
    }

    const events = new EventStream(response.body.getReader());
    const endpointEvent = await events.next(CONNECT_TIMEOUT_MS, (event) => event.event === 'endpoint');
    if (!endpointEvent) throw new McpError('The server opened a stream but never sent its POST endpoint.');
    const endpoint = new URL(endpointEvent.data.trim(), this.options.url).toString();

    const send = async (message: unknown): Promise<void> => {
      const posted = await this.fetchWithTimeout(
        endpoint,
        { method: 'POST', headers: this.headers('application/json'), body: JSON.stringify(message) },
        CONNECT_TIMEOUT_MS,
      );
      if (!posted.ok) throw await httpFailure(posted);
    };

    const timeoutMs = this.options.timeoutMs ?? CALL_TIMEOUT_MS;
    const call = async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const id = this.nextId++;
      await send(rpcRequest(id, method, params));
      return events.awaitResult(id, timeoutMs);
    };

    const id = this.nextId++;
    await send(rpcRequest(id, 'initialize', initializeParams()));
    const initialise = await events.awaitResult(id, CONNECT_TIMEOUT_MS);
    await send(rpcNotification('notifications/initialized')).catch(() => undefined);

    return {
      serverInfo: serverIdentity(initialise),
      protocolVersion: negotiatedVersion(initialise),
      call,
      optional: (method) => optional(() => call(method)),
      close: () => events.cancel(),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Session plumbing                                                            */
/* -------------------------------------------------------------------------- */

interface Session {
  serverInfo: string;
  protocolVersion: string;
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Null when the server does not implement the method. */
  optional(method: string): Promise<Record<string, unknown> | null>;
  close(): void;
}

/** `-32601 Method not found` means "not offered", which is not a failure. */
async function optional(run: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown> | null> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpError && !error.needsAuth && /not (found|supported|implemented)|-32601/i.test(error.message)) {
      return null;
    }
    if (error instanceof McpError && error.needsAuth) throw error;
    return null;
  }
}

async function httpFailure(response: ResponseLike): Promise<McpError> {
  const text = await response.text().catch(() => '');
  const needsAuth = response.status === 401 || response.status === 403;
  const detail = text.trim().slice(0, 300);
  return new McpError(
    needsAuth
      ? `The server refused the request (${response.status}). It needs authorisation${detail ? `: ${detail}` : '.'}`
      : `The server answered ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`,
    needsAuth,
  );
}

/**
 * Read one JSON-RPC result out of a POST response, JSON or SSE.
 *
 * A Streamable HTTP server may answer either way for the same request, so the
 * content type decides rather than the caller.
 */
async function readRpcResult(response: ResponseLike, id: number): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text();
    const message = parseRpcMessage(text);
    return resultOf(message, id, text);
  }

  if (!response.body) {
    // Buffered by a non-streaming fetch: parse the whole thing as SSE text.
    const parser = new SseParser();
    const text = await response.text();
    for (const event of [...parser.push(text), ...parser.flush()]) {
      const message = parseRpcMessage(event.data);
      if (message.kind !== 'other' && (message.id === id || message.id === null)) return resultOf(message, id, text);
    }
    throw new McpError('The server ended the stream without answering.');
  }

  const events = new EventStream(response.body.getReader());
  try {
    return await events.awaitResult(id, CALL_TIMEOUT_MS);
  } finally {
    events.cancel();
  }
}

function resultOf(message: ReturnType<typeof parseRpcMessage>, id: number, raw: string): Record<string, unknown> {
  if (message.kind === 'result' && message.id === id) return message.result;
  if (message.kind === 'error') throw new McpError(message.message);
  throw new McpError(`The server sent something other than an answer: ${raw.slice(0, 200)}`);
}

/**
 * An SSE body as awaitable events.
 *
 * Pull-based rather than an async generator with a queue: every consumer here is
 * "read until the message I want arrives or the clock runs out", and a generator
 * would need the same timeout race wrapped around it anyway.
 */
class EventStream {
  private readonly parser = new SseParser();
  private readonly decoder = new Utf8StreamDecoder();
  private pending: { event?: string; data: string }[] = [];
  private done = false;

  constructor(private readonly reader: { read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>; cancel(reason?: unknown): Promise<void> | void }) {}

  async next(timeoutMs: number, match: (event: { event?: string; data: string }) => boolean): Promise<{ event?: string; data: string } | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.pending.findIndex(match);
      if (index >= 0) return this.pending.splice(index, 1)[0] ?? null;
      if (this.done) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new McpError(`The server sent nothing for ${Math.round(timeoutMs / 1000)}s.`);
      await this.pump(remaining);
    }
  }

  async awaitResult(id: number, timeoutMs: number): Promise<Record<string, unknown>> {
    const event = await this.next(timeoutMs, (candidate) => {
      const message = parseRpcMessage(candidate.data);
      return message.kind !== 'other' && message.id === id;
    });
    if (!event) throw new McpError('The stream closed before the server answered.');
    return resultOf(parseRpcMessage(event.data), id, event.data);
  }

  private async pump(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      this.reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new McpError(`The server sent nothing for ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });

    if (chunk.done) {
      this.done = true;
      const tail = this.decoder.flush();
      if (tail) this.pending.push(...this.parser.push(tail));
      this.pending.push(...this.parser.flush());
      return;
    }
    if (!chunk.value?.length) return;
    const text = this.decoder.decode(chunk.value);
    if (text) this.pending.push(...this.parser.push(text));
  }

  cancel(): void {
    try {
      void this.reader.cancel('done');
    } catch {
      /* already closed */
    }
  }
}
