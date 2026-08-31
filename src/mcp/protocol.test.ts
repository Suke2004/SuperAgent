/**
 * The MCP wire, tested where getting it wrong is expensive.
 *
 * Not a restatement of the schema: the cases here are the ones that come from a
 * server this app does not control — a name that both APIs would reject, a call
 * result that is an image, a `stdio:` URL pasted out of a desktop config, and an
 * approval policy interacting with the global confirmation switch.
 */

import {
  authServerMetadataUrls,
  authorizeUrl,
  base64UrlFrom,
  bridgeTools,
  callbackCarriesState,
  decideApproval,
  describeArguments,
  failedCall,
  initializeParams,
  MAX_TOOL_IMAGE_BASE64,
  MAX_TOOL_NAME,
  MCP_PROTOCOL_VERSION,
  negotiatedVersion,
  nextCursor,
  parseCallbackUrl,
  parseRpcMessage,
  parseServerUrl,
  promptsFrom,
  protectedResourceUrls,
  qualifyToolName,
  renderCallResult,
  renderPromptMessages,
  resourcesFrom,
  rpcNotification,
  rpcRequest,
  serverIdentity,
  slugFromHost,
  toolsFrom,
  verifierFrom,
} from './protocol';
import type { McpTool } from './protocol';

const tool = (name: string, description = 'Does a thing.'): McpTool => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {} },
});

describe('JSON-RPC framing', () => {
  it('builds a request with an id and a notification without one', () => {
    expect(rpcRequest(1, 'tools/list')).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(rpcNotification('notifications/initialized')).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  });

  it('reads a result, an error, and treats anything else as noise', () => {
    expect(parseRpcMessage('{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}')).toEqual({
      kind: 'result',
      id: 7,
      result: { tools: [] },
    });
    expect(parseRpcMessage('{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"No such method"}}')).toEqual({
      kind: 'error',
      id: 7,
      code: -32601,
      message: 'No such method',
    });
    // A log notification mid-call must not look like the answer we are waiting for.
    expect(parseRpcMessage('{"jsonrpc":"2.0","method":"notifications/message"}')).toEqual({ kind: 'other' });
    expect(parseRpcMessage('not json at all')).toEqual({ kind: 'other' });
    expect(parseRpcMessage('[1,2,3]')).toEqual({ kind: 'other' });
  });

  it('keeps the version the server chose, and falls back to ours', () => {
    expect(initializeParams().protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(negotiatedVersion({ protocolVersion: '2024-11-05' })).toBe('2024-11-05');
    expect(negotiatedVersion({})).toBe(MCP_PROTOCOL_VERSION);
    expect(serverIdentity({ serverInfo: { name: 'files', version: '0.3.1' } })).toBe('files 0.3.1');
    expect(serverIdentity({})).toBe('');
  });
});

describe('reading what a server advertises', () => {
  it('drops entries that could never be called and defaults a missing schema', () => {
    const tools = toolsFrom({
      tools: [
        { name: 'search', description: 'Searches.', inputSchema: { type: 'object' } },
        { name: '   ', description: 'Nameless.' },
        { description: 'No name field at all.' },
        'not an object',
        { name: 'ping' },
      ],
    });
    expect(tools.map((t) => t.name)).toEqual(['search', 'ping']);
    expect(tools[1]?.inputSchema).toEqual({ type: 'object', properties: {} });
    expect(tools[1]?.description).toBe('');
  });

  it('reads resources and prompts, and reports a page cursor', () => {
    expect(resourcesFrom({ resources: [{ uri: 'file:///a' }, { name: 'no uri' }] })).toEqual([
      { uri: 'file:///a', name: 'file:///a', description: '' },
    ]);
    expect(promptsFrom({ prompts: [{ name: 'review', description: 'Reviews a diff.' }] })).toEqual([
      { name: 'review', description: 'Reviews a diff.', arguments: [] },
    ]);
    // Declared arguments are kept: they are what the composer asks for before
    // `prompts/get`, and a server that omits them declares none.
    expect(
      promptsFrom({
        prompts: [{ name: 'daily', arguments: [{ name: 'date', required: true }, { description: 'nameless' }] }],
      }),
    ).toEqual([
      { name: 'daily', description: '', arguments: [{ name: 'date', description: '', required: true }] },
    ]);
    expect(nextCursor({ nextCursor: 'page2' })).toBe('page2');
    expect(nextCursor({})).toBeNull();
    expect(toolsFrom({})).toEqual([]);
  });
});

describe('bridging tools into a request', () => {
  it('produces names both APIs accept', () => {
    const name = qualifyToolName('GitHub (Enterprise)', 'Search Issues/PRs');
    expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(name).toBe('mcp_github-enterprise_search-issues-prs');
  });

  it('truncates to the API limit', () => {
    const name = qualifyToolName('server', 'x'.repeat(200));
    expect(name).toHaveLength(MAX_TOOL_NAME);
  });

  it('includes only the enabled tools, in a stable order', () => {
    const bridged = bridgeTools([
      { serverId: 's1', slug: 'files', tools: [tool('read'), tool('write')], enabled: ['read'] },
      { serverId: 's2', slug: 'issues', tools: [tool('list')], enabled: ['list', 'absent'] },
    ]);
    expect(bridged.map((b) => b.wireName)).toEqual(['mcp_files_read', 'mcp_issues_list']);
    expect(bridged[0]).toMatchObject({ serverId: 's1', tool: 'read' });
    expect(bridged[1]?.definition.name).toBe('mcp_issues_list');
  });

  it('keeps two tools apart when truncation collides', () => {
    const long = 'a'.repeat(80);
    const bridged = bridgeTools([
      { serverId: 's1', slug: 'x', tools: [tool(long), tool(`${long}b`)], enabled: [long, `${long}b`] },
    ]);
    const [first, second] = bridged.map((b) => b.wireName);
    expect(first).not.toBe(second);
    expect(second).toHaveLength(MAX_TOOL_NAME);
    // The mapping is kept, so the original name is still what gets called.
    expect(bridged[1]?.tool).toBe(`${long}b`);
  });
});

describe('a call result', () => {
  it('carries an image back rather than describing it away', () => {
    // The bug this replaces: a screenshot server's result reached the model as the
    // words "not shown", so it was told the call worked and given nothing to look at.
    expect(
      renderCallResult({
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          { type: 'text', text: 'second' },
        ],
      }),
    ).toEqual({
      content: 'first\n[image: image/png, attached below]\nsecond',
      images: [{ mediaType: 'image/png', data: 'AAAA' }],
    });
  });

  it('still describes what it cannot carry', () => {
    // Audio has nowhere to go on either transport; an unknown image type and one
    // over the ceiling would both be sent as bytes no model will accept.
    expect(renderCallResult({ content: [{ type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }] })).toEqual({
      content: '[audio: audio/wav, not shown]',
    });
    expect(renderCallResult({ content: [{ type: 'image', mimeType: 'image/tiff', data: 'AAAA' }] })).toEqual({
      content: '[image: image/tiff, not shown]',
    });
    expect(
      renderCallResult({
        content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(MAX_TOOL_IMAGE_BASE64 + 1) }],
      }),
    ).toEqual({ content: '[image: image/png, not shown]' });
  });

  it('reads a prompt back as one piece of text', () => {
    expect(
      renderPromptMessages({ messages: [{ role: 'user', content: { type: 'text', text: 'Review this.' } }] }),
    ).toBe('Review this.');
    // More than one message keeps its roles: the draft is a single message, and
    // without the labels a two-turn prompt reads as one run-on paragraph.
    expect(
      renderPromptMessages({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Ask' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
        ],
      }),
    ).toBe('user: Ask\n\nassistant: Answer');
    expect(renderPromptMessages({})).toBe('');
    expect(renderPromptMessages({ messages: [{ role: 'user', content: [{ type: 'image', data: 'AAAA' }] }] })).toBe('');
  });

  it('passes a tool-level failure through as an error result', () => {
    expect(renderCallResult({ isError: true, content: [{ type: 'text', text: 'no such file' }] })).toEqual({
      content: 'no such file',
      isError: true,
    });
    expect(failedCall('The server timed out.')).toEqual({ content: 'The server timed out.', isError: true });
  });

  it('never returns empty content, because an empty tool_result is invalid', () => {
    expect(renderCallResult({ content: [] }).content).toBe('The tool returned no content.');
    expect(renderCallResult({ content: [], structuredContent: { rows: 2 } }).content).toBe('{"rows":2}');
  });

  it('inlines an embedded text resource and links anything else', () => {
    expect(renderCallResult({ content: [{ type: 'resource', resource: { uri: 'file:///a', text: 'body' } }] })).toEqual(
      { content: 'body' },
    );
    expect(renderCallResult({ content: [{ type: 'resource_link', uri: 'file:///b' }] })).toEqual({
      content: '[resource: file:///b]',
    });
  });
});

describe('the approval gate', () => {
  it('asks by default and remembers an always-allow', () => {
    expect(decideApproval(undefined, 'mcp_files_read', true)).toBe('ask');
    expect(decideApproval({ mcp_files_read: 'always' }, 'mcp_files_read', true)).toBe('allow');
    expect(decideApproval(undefined, 'mcp_files_read', false)).toBe('allow');
  });

  it('keeps a denied tool denied when confirmations are switched off', () => {
    // The off switch means "stop asking", never "grant what I refused".
    expect(decideApproval({ mcp_files_write: 'deny' }, 'mcp_files_write', false)).toBe('deny');
  });

  it('shows arguments in full', () => {
    expect(describeArguments({ path: '/etc/hosts' })).toBe('{\n  "path": "/etc/hosts"\n}');
    expect(describeArguments(undefined)).toBe('(no arguments)');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeArguments(cyclic)).toBe('[object Object]');
  });
});

describe('the server URL', () => {
  it('accepts http and https and derives a slug', () => {
    expect(parseServerUrl(' https://mcp.api.github.com/v1/mcp ')).toEqual({
      ok: true,
      url: 'https://mcp.api.github.com/v1/mcp',
      origin: 'https://mcp.api.github.com',
      slug: 'github',
    });
    expect(parseServerUrl('http://192.168.1.9:3000/mcp').ok).toBe(true);
    expect(slugFromHost('localhost')).toBe('localhost');
  });

  it('refuses stdio by name rather than calling it invalid', () => {
    const rejected = parseServerUrl('stdio:npx -y @modelcontextprotocol/server-filesystem');
    expect(rejected).toEqual({ ok: false, reason: expect.stringContaining('HTTP only') });
  });

  it('refuses other schemes and a missing one', () => {
    expect(parseServerUrl('ws://example.com/mcp')).toEqual({ ok: false, reason: expect.stringContaining('ws') });
    expect(parseServerUrl('example.com/mcp')).toEqual({ ok: false, reason: expect.stringContaining('scheme') });
    expect(parseServerUrl('  ')).toEqual({ ok: false, reason: expect.stringContaining('URL') });
  });
});

describe('OAuth 2.1 with PKCE', () => {
  it('builds a verifier of unreserved characters only', () => {
    const verifier = verifierFrom(new Uint8Array(48).map((_v, i) => (i * 31) % 256));
    expect(verifier).toHaveLength(48);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
  });

  it('refuses entropy under the RFC floor rather than shipping a weak challenge', () => {
    expect(() => verifierFrom(new Uint8Array(32))).toThrow(/43/);
  });

  it('converts base64 to base64url', () => {
    expect(base64UrlFrom('ab+/cd==')).toBe('ab-_cd');
  });

  it('tries the path-aware well-known URL before the root one', () => {
    expect(protectedResourceUrls('https://example.com/mcp')).toEqual([
      'https://example.com/.well-known/oauth-protected-resource/mcp',
      'https://example.com/.well-known/oauth-protected-resource',
    ]);
    expect(protectedResourceUrls('https://example.com/')).toEqual([
      'https://example.com/.well-known/oauth-protected-resource',
    ]);
    expect(authServerMetadataUrls('https://auth.example.com/tenant1')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/tenant1/.well-known/openid-configuration',
    ]);
  });

  it('carries the resource indicator, so a token cannot be replayed elsewhere', () => {
    const url = new URL(
      authorizeUrl({
        authorizationEndpoint: 'https://auth.example.com/authorize?tenant=1',
        clientId: 'client-1',
        redirectUri: 'agentrouter://mcp-oauth',
        challenge: 'CHALLENGE',
        state: 'STATE',
        resource: 'https://example.com/mcp',
        scope: 'mcp:read',
      }),
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe('https://example.com/mcp');
    expect(url.searchParams.get('scope')).toBe('mcp:read');
    // The endpoint's own query survives.
    expect(url.searchParams.get('tenant')).toBe('1');
  });

  it('reads a callback from the query or the fragment, and reports a refusal', () => {
    expect(parseCallbackUrl('agentrouter://mcp-oauth?code=abc&state=xyz')).toEqual({
      ok: true,
      code: 'abc',
      state: 'xyz',
    });
    expect(parseCallbackUrl('agentrouter://mcp-oauth#code=abc&state=xyz').code).toBe('abc');
    expect(parseCallbackUrl('agentrouter://mcp-oauth?error=access_denied&error_description=No')).toEqual({
      ok: false,
      error: 'access_denied: No',
    });
    expect(parseCallbackUrl('agentrouter://mcp-oauth?state=xyz').ok).toBe(false);
    expect(parseCallbackUrl('not a url').ok).toBe(false);
  });

  it('recognises its own callback by state, so another app cannot answer for it', () => {
    expect(callbackCarriesState('agentrouter://mcp-oauth?code=abc&state=xyz', 'xyz')).toBe(true);
    expect(callbackCarriesState('agentrouter://mcp-oauth#code=abc&state=xyz', 'xyz')).toBe(true);
    // A refusal is still ours, and has to settle the wait rather than be ignored.
    expect(callbackCarriesState('agentrouter://mcp-oauth?error=access_denied&state=xyz', 'xyz')).toBe(true);
    // The forged ones: another app's code, no state at all, an unreadable URL.
    expect(callbackCarriesState('agentrouter://mcp-oauth?code=abc&state=other', 'xyz')).toBe(false);
    expect(callbackCarriesState('agentrouter://mcp-oauth?code=abc', 'xyz')).toBe(false);
    expect(callbackCarriesState('not a url', 'xyz')).toBe(false);
    // No expectation is not a wildcard.
    expect(callbackCarriesState('agentrouter://mcp-oauth?code=abc', '')).toBe(false);
  });
});
