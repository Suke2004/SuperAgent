/**
 * OAuth 2.1 with PKCE, for MCP servers that want it.
 *
 * The parts that are just strings live in `protocol.ts` and are tested there. What
 * is left here is the two things a phone has to do that a test cannot: hand the user
 * to a browser and wait for the deep link back, and reach the discovery endpoints.
 *
 * Shape of the flow, in the order MCP specifies it:
 *
 *  1. `/.well-known/oauth-protected-resource` on the MCP server names its
 *     authorisation server. A server that does not publish it is assumed to be its
 *     own issuer, which is what most single-tenant deployments are.
 *  2. The authorisation server's metadata gives the endpoints.
 *  3. No client id yet → dynamic registration (RFC 7591). Public client, no secret:
 *     a secret shipped in an app is not a secret, and PKCE is what actually protects
 *     the exchange.
 *  4. Authorise in the system browser, come back on the app's deep link.
 *  5. Exchange the code with the verifier and the `resource` indicator, so the token
 *     the server issues cannot be replayed against a different MCP server.
 *
 * The access token goes to `expo-secure-store` through the same path the API key
 * uses, which also registers it with the redactor — so it is scrubbed from the debug
 * log and from every export from the moment it exists.
 */

import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';

import {
  authServerMetadataUrls,
  authorizeUrl,
  base64UrlFrom,
  callbackCarriesState,
  parseCallbackUrl,
  protectedResourceUrls,
  verifierFrom,
} from './protocol';
import { APP_WIRE_NAME } from '@/lib/app';
import { USER_AGENT } from '@/transports/http';
import { log } from '@/lib/log';
import { deleteApiKey, loadApiKey, saveApiKey } from '@/lib/secureKey';

/** How long the browser hand-off may take before the attempt is abandoned. */
const AUTH_TIMEOUT_MS = 5 * 60_000;

/** The deep-link path the authorisation server redirects back to. */
const REDIRECT_PATH = 'mcp-oauth';

export interface AuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scope?: string;
}

export interface StoredAuth {
  clientId: string;
  endpoints: AuthEndpoints;
  /** Absolute epoch milliseconds, when the server said how long the token lasts. */
  expiresAt?: number;
}

/** Secure-store slots. The suffix is what keeps a refresh token out of the bearer slot. */
function tokenSlot(serverId: string): string {
  return `mcp.${serverId}`;
}

function refreshSlot(serverId: string): string {
  return `mcp.${serverId}.refresh`;
}

export async function loadAccessToken(serverId: string): Promise<string | null> {
  return loadApiKey(tokenSlot(serverId));
}

/** A static token the user pasted. Same slot as an OAuth one, so calls need no branch. */
export async function saveBearerToken(serverId: string, token: string): Promise<void> {
  await saveApiKey(tokenSlot(serverId), token);
}

export async function forgetTokens(serverId: string): Promise<void> {
  await deleteApiKey(tokenSlot(serverId));
  await deleteApiKey(refreshSlot(serverId));
}

export function redirectUri(): string {
  return Linking.createURL(REDIRECT_PATH);
}

/* -------------------------------------------------------------------------- */
/* Discovery and registration                                                  */
/* -------------------------------------------------------------------------- */

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    // A 404 and a DNS failure are the same thing here: try the next candidate.
    return null;
  }
}

/**
 * Find the authorisation server and its endpoints.
 *
 * Every candidate URL is tried in the documented order, because a wrong guess here
 * is indistinguishable from "this server does not support OAuth" and that is the
 * wrong thing to tell the user.
 */
export async function discoverEndpoints(serverUrl: string): Promise<AuthEndpoints> {
  let issuer = new URL(serverUrl).origin;
  let scope: string | undefined;

  for (const candidate of protectedResourceUrls(serverUrl)) {
    const metadata = await getJson(candidate);
    if (!metadata) continue;
    const servers = Array.isArray(metadata.authorization_servers) ? metadata.authorization_servers : [];
    const first = servers.find((entry): entry is string => typeof entry === 'string');
    if (first) issuer = first;
    scope = joinScopes(metadata.scopes_supported);
    break;
  }

  for (const candidate of authServerMetadataUrls(issuer)) {
    const metadata = await getJson(candidate);
    const authorizationEndpoint = typeof metadata?.authorization_endpoint === 'string' ? metadata.authorization_endpoint : '';
    const tokenEndpoint = typeof metadata?.token_endpoint === 'string' ? metadata.token_endpoint : '';
    if (!authorizationEndpoint || !tokenEndpoint) continue;
    const registrationEndpoint =
      typeof metadata?.registration_endpoint === 'string' ? metadata.registration_endpoint : undefined;
    const advertised = joinScopes(metadata?.scopes_supported);
    return {
      authorizationEndpoint,
      tokenEndpoint,
      ...(registrationEndpoint ? { registrationEndpoint } : {}),
      ...(scope ?? advertised ? { scope: scope ?? advertised } : {}),
    };
  }

  throw new Error(
    `No OAuth metadata found for ${issuer}. If the server uses a static token, paste it as a bearer token instead.`,
  );
}

function joinScopes(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const scopes = value.filter((entry): entry is string => typeof entry === 'string');
  return scopes.length ? scopes.join(' ') : undefined;
}

/** Dynamic client registration. Public client, no secret, PKCE only. */
export async function registerClient(endpoint: string, redirect: string): Promise<string> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({
      client_name: APP_WIRE_NAME,
      redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const body: unknown = await response.json().catch(() => null);
  const clientId =
    typeof body === 'object' && body !== null && typeof (body as { client_id?: unknown }).client_id === 'string'
      ? (body as { client_id: string }).client_id
      : '';
  if (!response.ok || !clientId) {
    throw new Error(
      `The authorisation server refused to register this app (${response.status}). ` +
        'Some servers need a client id created by hand — add it as a header or bearer token instead.',
    );
  }
  return clientId;
}

/* -------------------------------------------------------------------------- */
/* The flow                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Run the whole authorisation, and store the tokens.
 *
 * Returns what the server row needs to remember: the client id (so the next run
 * skips registration), the endpoints, and when the access token expires. The tokens
 * themselves are not returned — they go straight to the Keystore, and nothing that
 * touches Zustand ever sees them.
 */
export async function authorize(input: {
  serverId: string;
  serverUrl: string;
  /** From a previous run, if any. */
  clientId?: string;
  endpoints?: AuthEndpoints;
}): Promise<StoredAuth> {
  const redirect = redirectUri();
  const endpoints = input.endpoints ?? (await discoverEndpoints(input.serverUrl));
  let clientId = input.clientId;
  if (!clientId) {
    if (!endpoints.registrationEndpoint) {
      throw new Error(
        'This authorisation server does not support automatic registration, so it needs a client id. ' +
          'Use a bearer token instead, or add one by hand in a custom header.',
      );
    }
    clientId = await registerClient(endpoints.registrationEndpoint, redirect);
  }

  const verifier = verifierFrom(Crypto.getRandomBytes(48));
  const challenge = base64UrlFrom(
    await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
      encoding: Crypto.CryptoEncoding.BASE64,
    }),
  );
  // Not truncated. 48 random bytes base64url-encoded, in full: the slice that used
  // to be here threw away half the entropy for no reason a spec asks for.
  const state = verifierFrom(Crypto.getRandomBytes(48));

  const url = authorizeUrl({
    authorizationEndpoint: endpoints.authorizationEndpoint,
    clientId,
    redirectUri: redirect,
    challenge,
    state,
    resource: input.serverUrl,
    ...(endpoints.scope ? { scope: endpoints.scope } : {}),
  });

  const callback = await openAndWait(url, redirect, state);
  const parsed = parseCallbackUrl(callback);
  if (!parsed.ok) throw new Error(parsed.error ?? 'Authorisation failed.');
  // A callback whose state does not match ours is not ours. Refuse it rather than
  // exchanging a code somebody else's page produced.
  if (parsed.state !== state) throw new Error('The authorisation response did not match this request.');

  const tokens = await exchange(endpoints.tokenEndpoint, {
    grant_type: 'authorization_code',
    code: parsed.code ?? '',
    redirect_uri: redirect,
    client_id: clientId,
    code_verifier: verifier,
    resource: input.serverUrl,
  });

  await store(input.serverId, tokens);
  return {
    clientId,
    endpoints,
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
  };
}

/**
 * Swap the refresh token for a new access token.
 *
 * Returns null when there is nothing to refresh with, or the server refused — the
 * caller's next step is the full flow, and distinguishing the two would only add a
 * message nobody can act on differently.
 */
export async function refresh(input: { serverId: string; serverUrl: string; auth: StoredAuth }): Promise<StoredAuth | null> {
  const token = await loadApiKey(refreshSlot(input.serverId));
  if (!token) return null;
  try {
    const tokens = await exchange(input.auth.endpoints.tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: input.auth.clientId,
      resource: input.serverUrl,
    });
    await store(input.serverId, tokens);
    return { ...input.auth, ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}) };
  } catch (error) {
    log.warn('mcp', 'Refreshing the MCP token failed; a new sign-in is needed.', error);
    return null;
  }
}

interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

async function exchange(tokenEndpoint: string, params: Record<string, string>): Promise<Tokens> {
  const body = new URLSearchParams(params).toString();
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body,
  });
  const payload: unknown = await response.json().catch(() => null);
  const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const accessToken = typeof record.access_token === 'string' ? record.access_token : '';
  if (!response.ok || !accessToken) {
    const detail = typeof record.error_description === 'string' ? record.error_description : String(record.error ?? '');
    throw new Error(`The token request failed (${response.status})${detail ? `: ${detail}` : '.'}`);
  }
  const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : undefined;
  return {
    accessToken,
    ...(typeof record.refresh_token === 'string' ? { refreshToken: record.refresh_token } : {}),
    ...(expiresIn !== undefined ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
  };
}

async function store(serverId: string, tokens: Tokens): Promise<void> {
  await saveApiKey(tokenSlot(serverId), tokens.accessToken);
  // Keep the previous refresh token when the server rotated only the access one.
  if (tokens.refreshToken) await saveApiKey(refreshSlot(serverId), tokens.refreshToken);
}

/**
 * Open the browser and resolve with the URL it sends back.
 *
 * `expo-web-browser` is not a dependency and is not worth adding for this: the
 * system browser is where a session cookie the user already has lives, which is the
 * difference between one tap and typing a password on a phone keyboard.
 *
 * A deep link is not a private channel: on Android any installed app can declare the
 * same scheme and fire this URL, so matching on the redirect prefix alone means the
 * first app to shout wins the promise. It cannot get a token — the `state` check in
 * `authorize` refuses a code that is not ours — but settling on a forged link would
 * abandon the real callback arriving a moment later, so the flow would fail every
 * time such an app was installed. Hence the `state` match here as well: a link that
 * does not carry our nonce is somebody else's and is ignored, and the real one is
 * still waited for.
 */
async function openAndWait(url: string, redirect: string, state: string): Promise<string> {
  const prefix = redirect.split('?')[0] ?? redirect;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const subscription = Linking.addEventListener('url', (event) => {
      if (settled || !event.url.startsWith(prefix) || !callbackCarriesState(event.url, state)) return;
      settled = true;
      clearTimeout(timer);
      subscription.remove();
      resolve(event.url);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      subscription.remove();
      reject(new Error('Authorisation was not completed, so nothing was saved.'));
    }, AUTH_TIMEOUT_MS);

    void Linking.openURL(url).catch((error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription.remove();
      reject(new Error(`The browser could not be opened: ${error instanceof Error ? error.message : String(error)}`));
    });
  });
}
