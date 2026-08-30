/**
 * The MCP wire, as pure functions.
 *
 * Everything in here is JSON in, JSON out: framing, the defensive parsers for what
 * a server claims it can do, the mapping from an MCP tool to this app's
 * {@link ToolDefinition}, and the PKCE/OAuth string work. The socket lives in
 * `client.ts` and the native browser hand-off in `oauth.ts`, so this file is the
 * part that can be tested without either.
 *
 * Three decisions worth stating, because they are the ones that bite:
 *
 *  - **stdio is not a transport here.** {@link parseServerUrl} rejects anything that
 *    is not http(s). A phone has no child processes to speak stdio to, so a `stdio`
 *    entry could only ever be a config someone pasted from a desktop client, and
 *    failing at the field is clearer than failing at connect time.
 *  - **A server's tool names are not trusted.** They arrive from a third party and
 *    go into a request body where both APIs enforce `^[a-zA-Z0-9_-]{1,64}$`, so
 *    {@link bridgeTools} rewrites them and keeps the mapping rather than parsing the
 *    wire name back apart later.
 *  - **A failed call is a tool result, not an exception.** Same rule as skills: an
 *    unanswered `tool_use` invalidates every later request, so the model is told the
 *    server broke and gets to react.
 */

import { clampProse, slimTool, DESCRIPTION_CAP } from '@/chat/tools';
import { safeParseJson } from '@/transports/types';
import type { ToolDefinition } from '@/transports/types';

/**
 * The revision this client implements.
 *
 * Sent in `initialize` and, for Streamable HTTP, echoed as `MCP-Protocol-Version`
 * on every later request. A server that wants an older revision answers with its
 * own; {@link negotiatedVersion} keeps whatever it said, because the alternative —
 * insisting on ours — fails against every server pinned to a previous spec.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Identifies this app to the server. Honest, like the HTTP User-Agent. */
export const CLIENT_INFO = { name: 'AgentRouterMobile', version: '1.0.0' } as const;

/** Wire name prefix, so an MCP tool is never mistaken for `invoke_skill`. */
export const MCP_TOOL_PREFIX = 'mcp';

/** Both APIs cap a tool name at 64 characters. */
export const MAX_TOOL_NAME = 64;

/* -------------------------------------------------------------------------- */
/* JSON-RPC                                                                    */
/* -------------------------------------------------------------------------- */

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export function rpcRequest(id: number, method: string, params?: Record<string, unknown>): RpcRequest {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
}

export function rpcNotification(method: string, params?: Record<string, unknown>): RpcNotification {
  return { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
}

export type RpcMessage =
  | { kind: 'result'; id: number; result: Record<string, unknown> }
  | { kind: 'error'; id: number | null; code: number; message: string }
  /** A notification, a request from the server, or something unparseable. */
  | { kind: 'other' };

/**
 * Parse one JSON-RPC message.
 *
 * Never throws. A server that sends a log notification mid-call, or a byte of
 * garbage, must not take the call down with it — the caller keeps reading until the
 * id it asked about comes back or the stream ends.
 */
export function parseRpcMessage(text: string): RpcMessage {
  const value = safeParseJson(text);
  if (!isRecord(value)) return { kind: 'other' };

  const id = typeof value.id === 'number' ? value.id : null;
  if (isRecord(value.error)) {
    const code = typeof value.error.code === 'number' ? value.error.code : 0;
    const message = typeof value.error.message === 'string' ? value.error.message : 'The server returned an error.';
    return { kind: 'error', id, code, message };
  }
  if (id !== null && 'result' in value) {
    return { kind: 'result', id, result: isRecord(value.result) ? value.result : {} };
  }
  return { kind: 'other' };
}

export function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    // Nothing is claimed that this client cannot do. `roots` and `sampling` would
    // both mean answering requests *from* the server, and this client only asks.
    capabilities: {},
    clientInfo: CLIENT_INFO,
  };
}

/** What the server said in `initialize`, or our own version when it said nothing. */
export function negotiatedVersion(result: Record<string, unknown>): string {
  return typeof result.protocolVersion === 'string' && result.protocolVersion
    ? result.protocolVersion
    : MCP_PROTOCOL_VERSION;
}

/** The server's own name and version, for the settings row. */
export function serverIdentity(result: Record<string, unknown>): string {
  const info = isRecord(result.serverInfo) ? result.serverInfo : {};
  const name = typeof info.name === 'string' ? info.name : '';
  const version = typeof info.version === 'string' ? info.version : '';
  return [name, version].filter(Boolean).join(' ');
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, as the server sent it. */
  inputSchema: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  description: string;
}

export interface McpPrompt {
  name: string;
  description: string;
}

/**
 * Read `tools/list`.
 *
 * Anything without a usable name is dropped rather than repaired: a nameless tool
 * cannot be called, and inventing a name for it would put a tool in the prompt that
 * every invocation then fails on. A missing schema becomes an empty object schema,
 * which is what a no-argument tool means.
 */
export function toolsFrom(result: Record<string, unknown>): McpTool[] {
  const raw = Array.isArray(result.tools) ? result.tools : [];
  const out: McpTool[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim()) continue;
    out.push({
      name: entry.name.trim(),
      description: clampProse(typeof entry.description === 'string' ? entry.description : '', DESCRIPTION_CAP),
      inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : { type: 'object', properties: {} },
    });
  }
  return out;
}

export function resourcesFrom(result: Record<string, unknown>): McpResource[] {
  const raw = Array.isArray(result.resources) ? result.resources : [];
  const out: McpResource[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.uri !== 'string' || !entry.uri.trim()) continue;
    out.push({
      uri: entry.uri.trim(),
      name: typeof entry.name === 'string' ? entry.name : entry.uri.trim(),
      description: clampProse(typeof entry.description === 'string' ? entry.description : '', DESCRIPTION_CAP),
    });
  }
  return out;
}

export function promptsFrom(result: Record<string, unknown>): McpPrompt[] {
  const raw = Array.isArray(result.prompts) ? result.prompts : [];
  const out: McpPrompt[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim()) continue;
    out.push({
      name: entry.name.trim(),
      description: clampProse(typeof entry.description === 'string' ? entry.description : '', DESCRIPTION_CAP),
    });
  }
  return out;
}

/** The next page cursor, when the server paginated its list. */
export function nextCursor(result: Record<string, unknown>): string | null {
  return typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
}

/* -------------------------------------------------------------------------- */
/* Bridging into the request                                                   */
/* -------------------------------------------------------------------------- */

export interface BridgeSource {
  serverId: string;
  /** Short label used in the wire name, e.g. `github`. */
  slug: string;
  tools: readonly McpTool[];
  /** Tool names switched on for this conversation. */
  enabled: readonly string[];
}

export interface BridgedTool {
  /** The name the model sees and calls. */
  wireName: string;
  serverId: string;
  /** The name to send in `tools/call`. */
  tool: string;
  definition: ToolDefinition;
}

/**
 * `mcp_<slug>_<tool>`, sanitised and truncated to what both APIs accept.
 *
 * The tool half is truncated rather than the slug, so two servers offering the same
 * long tool name still differ. Exact collisions are resolved by the caller, which
 * is the only place that can see them.
 */
export function qualifyToolName(slug: string, tool: string): string {
  const safeSlug = sanitiseNamePart(slug) || 'server';
  const safeTool = sanitiseNamePart(tool) || 'tool';
  const prefix = `${MCP_TOOL_PREFIX}_${safeSlug}_`;
  return `${prefix}${safeTool}`.slice(0, MAX_TOOL_NAME);
}

function sanitiseNamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Every enabled tool from every enabled server, as tool definitions.
 *
 * Order is server order then the server's own tool order, which keeps the manifest
 * byte-stable across turns — Anthropic's cache keys on an exact prefix, so a set
 * iterated in hash order would silently cost a cache write every turn.
 *
 * A wire name that collides after truncation gets a numeric suffix. Rare, but two
 * tools sharing a name in the request is a call that cannot be routed.
 */
export function bridgeTools(sources: readonly BridgeSource[]): BridgedTool[] {
  const out: BridgedTool[] = [];
  const taken = new Set<string>();
  for (const source of sources) {
    for (const tool of source.tools) {
      if (!source.enabled.includes(tool.name)) continue;
      let wireName = qualifyToolName(source.slug, tool.name);
      if (taken.has(wireName)) {
        let n = 2;
        while (taken.has(`${wireName.slice(0, MAX_TOOL_NAME - 2)}_${n}`)) n += 1;
        wireName = `${wireName.slice(0, MAX_TOOL_NAME - 2)}_${n}`;
      }
      taken.add(wireName);
      out.push({
        wireName,
        serverId: source.serverId,
        tool: tool.name,
        definition: slimTool({
          name: wireName,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }),
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

export interface McpCallResult {
  content: string;
  isError?: true;
}

/**
 * Flatten a `tools/call` result into the text a `tool_result` block carries.
 *
 * Non-text content is described rather than inlined. An MCP image comes back as
 * base64 in a JSON envelope, and pasting a megabyte of it into the transcript would
 * blow the context budget for something the model was not asked to look at; the
 * description at least tells it the call worked and what it produced.
 *
 * `isError: true` in the payload is a *tool* failure — the server ran the tool and
 * the tool said no. It is passed through as an error result, which is exactly what
 * the model needs to try something else.
 */
export function renderCallResult(result: Record<string, unknown>): McpCallResult {
  const parts: string[] = [];
  const raw = Array.isArray(result.content) ? result.content : [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    if (entry.type === 'text' && typeof entry.text === 'string') {
      parts.push(entry.text);
      continue;
    }
    if (entry.type === 'image' || entry.type === 'audio') {
      const mediaType = typeof entry.mimeType === 'string' ? entry.mimeType : 'unknown';
      parts.push(`[${String(entry.type)}: ${mediaType}, not shown]`);
      continue;
    }
    if (entry.type === 'resource' && isRecord(entry.resource)) {
      const resource = entry.resource;
      if (typeof resource.text === 'string') parts.push(resource.text);
      else parts.push(`[resource: ${typeof resource.uri === 'string' ? resource.uri : 'unknown'}]`);
      continue;
    }
    if (entry.type === 'resource_link' && typeof entry.uri === 'string') {
      parts.push(`[resource: ${entry.uri}]`);
    }
  }

  // A server may answer with `structuredContent` and no text at all.
  if (!parts.length && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }

  const content = parts.join('\n').trim() || 'The tool returned no content.';
  return result.isError === true ? { content, isError: true } : { content };
}

/** The result body for a call this app refused or could not make. */
export function failedCall(message: string): McpCallResult {
  return { content: message, isError: true };
}

/* -------------------------------------------------------------------------- */
/* Approval                                                                    */
/* -------------------------------------------------------------------------- */

/** Per-tool standing decision. Absent means "use the global setting". */
export type ApprovalMode = 'ask' | 'always' | 'deny';

export type ApprovalOutcome = 'ask' | 'allow' | 'deny';

/**
 * What to do about one call, before any UI is involved.
 *
 * `deny` beats everything, including the global switch: a tool the user has
 * explicitly refused must stay refused when they turn confirmations off, or the
 * off switch quietly grants what they denied.
 */
export function decideApproval(
  policy: Readonly<Record<string, ApprovalMode>> | undefined,
  tool: string,
  confirmToolCalls: boolean,
): ApprovalOutcome {
  const mode = policy?.[tool];
  if (mode === 'deny') return 'deny';
  if (mode === 'always') return 'allow';
  return confirmToolCalls ? 'ask' : 'allow';
}

/** The arguments, in full, for the approval sheet. Never truncated. */
export function describeArguments(input: unknown): string {
  if (input === undefined || input === null) return '(no arguments)';
  if (typeof input === 'string') return input;
  try {
    const text = JSON.stringify(input, null, 2);
    return text === undefined ? String(input) : text;
  } catch {
    return String(input);
  }
}

/* -------------------------------------------------------------------------- */
/* URLs                                                                        */
/* -------------------------------------------------------------------------- */

export type McpTransportKind = 'http' | 'sse';

export interface ParsedServerUrl {
  ok: true;
  url: string;
  origin: string;
  /** A default slug derived from the host, e.g. `api-github-com` → `github`. */
  slug: string;
}

export interface RejectedServerUrl {
  ok: false;
  reason: string;
}

/**
 * Validate a server URL at the field the user typed it into.
 *
 * `stdio:` and a bare command are the two things people paste from desktop configs,
 * and both are named in the rejection rather than being called "invalid" — the
 * fix ("this app speaks HTTP only") is not guessable from the generic message.
 */
export function parseServerUrl(value: string): ParsedServerUrl | RejectedServerUrl {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, reason: 'Enter the server’s URL.' };
  if (/^stdio:/i.test(trimmed) || !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      return { ok: false, reason: 'This app connects over HTTP only — a stdio server needs a desktop client.' };
    }
    return { ok: false, reason: 'Include the scheme, e.g. https://example.com/mcp.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'That is not a URL this app can parse.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: `${parsed.protocol.replace(':', '')} is not supported — use https (or http on a LAN).` };
  }

  return { ok: true, url: trimmed, origin: parsed.origin, slug: slugFromHost(parsed.hostname) };
}

/** `mcp.api.github.com` → `github`. Best-effort: it is only a default. */
export function slugFromHost(hostname: string): string {
  const parts = hostname.split('.').filter((part) => part && !/^(www|api|mcp|server)$/i.test(part));
  // The registrable label, not the TLD: `github.com` → `github`.
  const label = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  return sanitiseNamePart(label ?? hostname) || 'server';
}

/* -------------------------------------------------------------------------- */
/* OAuth 2.1 + PKCE, the string half                                           */
/* -------------------------------------------------------------------------- */

/** Unreserved characters, per RFC 7636 §4.1. */
const VERIFIER_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/**
 * A code verifier from random bytes.
 *
 * The bytes are mapped onto the unreserved alphabet rather than base64url-encoded
 * so this stays a pure function — the caller supplies entropy from
 * `expo-crypto`, and the test supplies a fixed array.
 */
export function verifierFrom(bytes: Uint8Array | readonly number[]): string {
  let out = '';
  for (const byte of bytes) out += VERIFIER_ALPHABET[byte % VERIFIER_ALPHABET.length];
  // RFC 7636: 43 minimum. Short entropy is a programming error, not a user error.
  if (out.length < 43) throw new Error('A PKCE verifier needs at least 43 characters of entropy.');
  return out;
}

/** Standard base64 to base64url, which is what `code_challenge` wants. */
export function base64UrlFrom(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Where to look for the authorisation server, in order.
 *
 * RFC 9728's path-aware form first (`/.well-known/…/mcp`), then the root form that
 * most deployments actually serve. Both are tried because getting this wrong is the
 * single most common reason an otherwise fine MCP server will not connect.
 */
export function protectedResourceUrls(serverUrl: string): string[] {
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const root = `${url.origin}/.well-known/oauth-protected-resource`;
  return path && path !== '/' ? [`${root}${path}`, root] : [root];
}

/** The same shape for the authorisation server's own metadata. */
export function authServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  const out = [`${url.origin}/.well-known/oauth-authorization-server${path}`];
  if (path && path !== '/') out.push(`${url.origin}/.well-known/oauth-authorization-server`);
  out.push(`${url.origin}${path}/.well-known/openid-configuration`);
  return out;
}

export interface AuthorizeInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scope?: string;
  /** RFC 8707, required by MCP so a token cannot be replayed at another server. */
  resource: string;
}

export function authorizeUrl(input: AuthorizeInput): string {
  const url = new URL(input.authorizationEndpoint);
  const params = url.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', input.clientId);
  params.set('redirect_uri', input.redirectUri);
  params.set('code_challenge', input.challenge);
  params.set('code_challenge_method', 'S256');
  params.set('state', input.state);
  params.set('resource', input.resource);
  if (input.scope) params.set('scope', input.scope);
  return url.toString();
}

export interface Callback {
  ok: boolean;
  code?: string;
  state?: string;
  error?: string;
}

/**
 * Read the redirect the browser sent back.
 *
 * The `state` check is the caller's, but it is parsed here so a callback missing it
 * is a failure rather than a silently accepted code.
 */
export function parseCallbackUrl(value: string): Callback {
  const params = callbackParams(value);
  if (!params) return { ok: false, error: 'The browser returned a URL this app could not read.' };
  const error = params.get('error');
  if (error) {
    const description = params.get('error_description');
    return { ok: false, error: description ? `${error}: ${description}` : error };
  }
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return { ok: false, error: 'The browser came back without an authorisation code.' };
  return { ok: true, code, state };
}

function callbackParams(value: string): URLSearchParams | null {
  try {
    const url = new URL(value);
    // Some providers put the query on the fragment. Both are read.
    return new URLSearchParams(url.search || url.hash.replace(/^#/, ''));
  } catch {
    return null;
  }
}

/**
 * Whether a deep link carries the `state` this attempt sent.
 *
 * Separate from {@link parseCallbackUrl} because it answers a different question:
 * that one asks whether a callback succeeded, this one asks whether the callback is
 * *ours at all*. Any app on the device can fire the redirect URI, and the listener
 * that resolves on the first matching link has to be able to ignore a forged one and
 * keep waiting rather than settle on it. An `error=` response is still ours if the
 * nonce matches, so this deliberately does not look at anything else.
 */
export function callbackCarriesState(value: string, expected: string): boolean {
  if (!expected) return false;
  return callbackParams(value)?.get('state') === expected;
}

/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
