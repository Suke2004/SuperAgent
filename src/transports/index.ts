/**
 * Transport factory.
 *
 * The one place that knows both adapters exist. Everything above this speaks the
 * `Transport` interface and never names a dialect.
 *
 * It also owns base-URL normalisation, because the /v1 distinction is the easiest
 * thing in this app to get wrong: given `https://agentrouter.org/v1` and the
 * Anthropic transport, `normaliseBaseUrl` strips the suffix rather than producing a
 * request to `/v1/v1/messages` and a 404 the user has to decode.
 */

import { AnthropicTransport } from './anthropic';
import type { FetchLike } from './fetchTypes';
import { OpenAiTransport, describeBaseUrlIssue, summariseFailure } from './openai';
import type { RetryPolicy } from './retry';
import type { Transport, TransportConfig, TransportKind } from './types';

export interface CreateTransportOptions extends TransportConfig {
  fetchImpl: FetchLike;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  retryPolicy?: RetryPolicy;
}

export function createTransport(options: CreateTransportOptions): Transport {
  const baseUrl = normaliseBaseUrl(options.kind, options.baseUrl);
  const shared = { ...options, baseUrl };
  return options.kind === 'anthropic' ? new AnthropicTransport(shared) : new OpenAiTransport(shared);
}

/**
 * Coerce a base URL into the shape the given transport needs.
 *
 * Users paste whichever URL the gateway console showed them, and the console shows
 * one. Rather than making that a 404, the suffix is added or removed to match:
 *
 *   anthropic + https://agentrouter.org/v1  →  https://agentrouter.org
 *   openai    + https://agentrouter.org     →  https://agentrouter.org/v1
 */
export function normaliseBaseUrl(kind: TransportKind, baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;

  if (kind === 'anthropic') return trimmed.replace(/\/v\d+$/i, '');
  return /\/v\d+$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * Whether normalisation changed anything, for a settings-screen note.
 *
 * Silently rewriting the user's input and saying nothing is how they end up
 * believing the URL is stored as typed.
 */
export function describeNormalisation(kind: TransportKind, baseUrl: string): string | null {
  const normalised = normaliseBaseUrl(kind, baseUrl);
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed || normalised === trimmed) return null;
  return kind === 'anthropic'
    ? `Using ${normalised} — the Anthropic transport appends /v1/messages itself, so the /v1 you typed would have made it /v1/v1/messages.`
    : `Using ${normalised} — the OpenAI transport posts to <base>/chat/completions, so it needs the /v1 suffix.`;
}

/**
 * Re-exported so screens can render an error without importing a dialect module.
 * `summariseFailure` lives in the OpenAI adapter for historical reasons but is
 * dialect-agnostic — it switches on `GatewayError.kind`, not on the transport.
 */
export { describeBaseUrlIssue, summariseFailure };
