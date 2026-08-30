/**
 * The MCP client against a scripted server.
 *
 * The properties worth pinning are the ones a real server will eventually break:
 * a session id that has to be echoed, an optional method answered `-32601`, a reply
 * that arrives as SSE instead of JSON, an expired token that has to be distinguished
 * from a server that is merely broken, and a tool that never answers.
 *
 * The injected `fetch` is a plain function returning plain objects — the reason
 * `@/transports/fetchTypes` is structural.
 */

import { McpClient, McpError } from '@/mcp/client';
import type { McpClientOptions } from '@/mcp/client';
import type { FetchLike, RequestInitLike, ResponseLike } from '@/transports/fetchTypes';

interface Call {
  url: string;
  init: RequestInitLike;
  body: Record<string, unknown>;
}

function json(value: unknown, extra: Record<string, string> = {}): ResponseLike {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(value),
  };
}

/** An SSE body a streaming fetch would hand back: one chunk, then end. */
function sseStream(frames: readonly string[]): ResponseLike {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    text: async () => frames.join(''),
    body: {
      getReader: () => ({
        read: async () =>
          index < frames.length
            ? { done: false, value: encoder.encode(frames[index++]) }
            : { done: true, value: undefined },
        cancel: () => undefined,
      }),
    },
  };
}

function failure(status: number, statusText: string, body = ''): ResponseLike {
  return {
    ok: false,
    status,
    statusText,
    headers: { get: () => null },
    text: async () => body,
  };
}

const INITIALISE = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: '2025-06-18',
    serverInfo: { name: 'scripted', version: '1.2.3' },
    capabilities: {},
  },
};

/**
 * A Streamable HTTP server: one handler per method, called with the parsed body.
 * Anything unscripted answers `-32601`, which is what a real server does.
 */
function streamableServer(
  handlers: Record<string, (params: Record<string, unknown>, id: number) => ResponseLike>,
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, init, body });
    if (init.method === 'DELETE') return json({});
    const method = String(body.method ?? '');
    const id = typeof body.id === 'number' ? body.id : 0;
    if (body.id === undefined) return json({}); // a notification
    if (method === 'initialize') {
      return json({ ...INITIALISE, id }, { 'mcp-session-id': 'sess-42' });
    }
    const handler = handlers[method];
    if (!handler) return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    return handler((body.params ?? {}) as Record<string, unknown>, id);
  };
  return { fetchImpl, calls };
}

function client(fetchImpl: FetchLike, overrides: Partial<McpClientOptions> = {}) {
  return new McpClient({
    url: 'https://mcp.example.com/mcp',
    transport: 'http',
    fetchImpl,
    ...overrides,
  });
}

describe('streamable HTTP', () => {
  it('discovers tools across pages and tolerates the optional methods being absent', async () => {
    const { fetchImpl, calls } = streamableServer({
      'tools/list': (params, id) =>
        json({
          jsonrpc: '2.0',
          id,
          result: params.cursor
            ? { tools: [{ name: 'second', inputSchema: { type: 'object' } }] }
            : { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'page2' },
        }),
      'prompts/list': (_params, id) => json({ jsonrpc: '2.0', id, result: { prompts: [{ name: 'summarise' }] } }),
    });

    const discovery = await client(fetchImpl).discover();

    expect(discovery.tools.map((tool) => tool.name)).toEqual(['first', 'second']);
    expect(discovery.serverInfo).toContain('scripted');
    expect(discovery.protocolVersion).toBe('2025-06-18');
    // `resources/list` was unscripted, so it answered -32601: no resources, no throw.
    expect(discovery.resources).toEqual([]);
    expect(discovery.prompts.map((prompt) => prompt.name)).toEqual(['summarise']);

    // The session id from initialize is echoed on every later request, which is what
    // makes those four calls one session rather than four.
    const later = calls.filter((call) => call.body.method && call.body.method !== 'initialize');
    expect(later.length).toBeGreaterThan(0);
    for (const call of later) expect(call.init.headers['Mcp-Session-Id']).toBe('sess-42');
    // And the session is released rather than left to expire.
    expect(calls.some((call) => call.init.method === 'DELETE')).toBe(true);
  });

  it('sends the bearer token, and no configured header can displace it', async () => {
    const { fetchImpl, calls } = streamableServer({
      'tools/call': (_params, id) => json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } }),
    });

    await client(fetchImpl, { token: 'tok-secret', headers: { Authorization: 'Bearer wrong', 'X-Trace': 'on' } }).callTool(
      'search',
      { q: 'pelicans' },
    );

    const call = calls.find((entry) => entry.body.method === 'tools/call');
    expect(call?.init.headers.Authorization).toBe('Bearer tok-secret');
    expect(call?.init.headers['X-Trace']).toBe('on');
    expect(call?.body.params).toEqual({ name: 'search', arguments: { q: 'pelicans' } });
  });

  it('reads a reply that comes back as SSE rather than JSON', async () => {
    const { fetchImpl } = streamableServer({
      'tools/call': (_params, id) =>
        sseStream([
          'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n',
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'from the stream' }] } })}\n\n`,
        ]),
    });

    const result = await client(fetchImpl).callTool('search', undefined);
    expect(result.content).toContain('from the stream');
    expect(result.isError).toBeUndefined();
  });

  it('reads an SSE reply that a non-streaming fetch buffered', async () => {
    const { fetchImpl } = streamableServer({
      'tools/call': (_params, id) => {
        const buffered = sseStream([
          `data: ${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'buffered' }] } })}\n\n`,
        ]);
        return { ...buffered, body: undefined };
      },
    });

    const result = await client(fetchImpl).callTool('search', {});
    expect(result.content).toContain('buffered');
  });

  it('turns a tool error result into an error result rather than an exception', async () => {
    const { fetchImpl } = streamableServer({
      'tools/call': (_params, id) =>
        json({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'no such repo' }] } }),
    });

    const result = await client(fetchImpl).callTool('search', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no such repo');
  });

  it('marks a 401 as needing authorisation, and a 500 as not', async () => {
    const unauthorised: FetchLike = async () => failure(401, 'Unauthorized', 'token expired');
    await expect(client(unauthorised).callTool('search', {})).rejects.toMatchObject({
      needsAuth: true,
      message: expect.stringContaining('401'),
    });

    const broken: FetchLike = async () => failure(500, 'Internal Server Error', 'boom');
    const error = await client(broken)
      .callTool('search', {})
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).needsAuth).toBe(false);
    expect((error as McpError).message).toContain('500');
  });

  it('reports a JSON-RPC error from the server as an McpError', async () => {
    const { fetchImpl } = streamableServer({
      'tools/call': (_params, id) => json({ jsonrpc: '2.0', id, error: { code: -32000, message: 'tool exploded' } }),
    });
    await expect(client(fetchImpl).callTool('search', {})).rejects.toThrow(/tool exploded/);
  });

  it('gives up on a server that never answers, with a message the loop can pass on', async () => {
    const { fetchImpl } = streamableServer({});
    // Initialize is answered; the call itself is not, which is the shape of a tool
    // that hangs. The call timeout is the configurable one, so it can be tiny here.
    const hangsOnCall: FetchLike = (url, init) => {
      const body = init.body ? (JSON.parse(init.body) as { method?: string }) : {};
      if (body.method !== 'tools/call') return fetchImpl(url, init);
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };

    const error = await client(hangsOnCall, { timeoutMs: 20 })
      .callTool('search', {})
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).message).toMatch(/did not answer within/);
  });

  it('says the server could not be reached when the fetch itself fails', async () => {
    const dead: FetchLike = async () => {
      throw new Error('Network request failed');
    };
    await expect(client(dead).callTool('search', {})).rejects.toThrow(/could not be reached: Network request failed/);
  });

  it('reads a resource as text, and says so when it is empty', async () => {
    const { fetchImpl } = streamableServer({
      'resources/read': (_params, id) =>
        json({ jsonrpc: '2.0', id, result: { contents: [{ text: 'one' }, { blob: 'ignored' }, { text: 'two' }] } }),
    });
    expect((await client(fetchImpl).readResource('file:///a')).content).toBe('one\ntwo');

    const empty = streamableServer({
      'resources/read': (_params, id) => json({ jsonrpc: '2.0', id, result: { contents: [] } }),
    });
    expect((await client(empty.fetchImpl).readResource('file:///a')).content).toBe('The resource was empty.');
  });
});

describe('HTTP+SSE', () => {
  /**
   * The legacy transport, scripted: a GET stream that answers whatever has been
   * POSTed to the endpoint it advertises.
   */
  function legacyServer(results: Record<string, (id: number) => unknown>): { fetchImpl: FetchLike; posts: Call[] } {
    const encoder = new TextEncoder();
    const queue: string[] = ['event: endpoint\ndata: /messages/1\n\n'];
    let wake: (() => void) | null = null;
    const posts: Call[] = [];

    const push = (frame: string): void => {
      queue.push(frame);
      wake?.();
    };

    const fetchImpl: FetchLike = async (url, init) => {
      if (init.method === 'GET') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => 'text/event-stream' },
          text: async () => '',
          body: {
            getReader: () => ({
              read: async () => {
                if (!queue.length) await new Promise<void>((resolve) => (wake = resolve));
                return { done: false, value: encoder.encode(queue.shift() ?? '') };
              },
              cancel: () => undefined,
            }),
          },
        };
      }

      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      posts.push({ url, init, body });
      const id = typeof body.id === 'number' ? body.id : 0;
      const method = String(body.method ?? '');
      if (body.id !== undefined) {
        const result = results[method]?.(id) ?? { protocolVersion: '2024-11-05', serverInfo: { name: 'legacy' } };
        push(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
      }
      return json({}, {});
    };

    return { fetchImpl, posts };
  }

  it('reads the endpoint event, then talks to the endpoint it named', async () => {
    const { fetchImpl, posts } = legacyServer({
      'tools/call': (_id) => ({ content: [{ type: 'text', text: 'legacy answer' }] }),
    });

    const result = await new McpClient({
      url: 'https://mcp.example.com/sse',
      transport: 'sse',
      fetchImpl,
    }).callTool('search', { q: 'x' });

    expect(result.content).toContain('legacy answer');
    expect(posts.every((post) => post.url === 'https://mcp.example.com/messages/1')).toBe(true);
    expect(posts.map((post) => post.body.method)).toContain('initialize');
  });

  it('refuses a stream it cannot read rather than hanging', async () => {
    const noBody: FetchLike = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'text/event-stream' },
      text: async () => '',
      body: null,
    });

    await expect(
      new McpClient({ url: 'https://mcp.example.com/sse', transport: 'sse', fetchImpl: noBody }).discover(),
    ).rejects.toThrow(/cannot stream/);
  });
});
