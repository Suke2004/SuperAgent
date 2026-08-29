/**
 * The live gateway.
 *
 * One place that turns "the active provider profile" into a working `Transport`.
 * Everything above it — chat, model discovery, the connection test — asks here
 * rather than constructing transports itself, so there is exactly one place where
 * the key is read and exactly one place where failover is decided.
 *
 * The key is fetched from SecureStore per call and never stored on the transport
 * beyond its lifetime. Transports are cached by profile *and* fingerprint, so
 * changing the key in Settings invalidates the cached instance instead of quietly
 * continuing to send the old one.
 */

import { createTransport, normaliseBaseUrl } from '@/transports';
import { GatewayError } from '@/transports/errors';
import { streamingFetch, supportsStreaming } from '@/transports/streamingFetch';
import type { Transport } from '@/transports/types';

import { loadApiKey } from './secureKey';
import { keyFingerprint } from './redact';
import { log } from './log';
import { activeProfile, useProviders } from '@/stores/providers';
import type { ProviderProfile } from '@/stores/providers';

interface CacheEntry {
  transport: Transport;
  /** Fingerprint rather than the key: this object outlives a single request. */
  fingerprint: string;
  baseUrl: string;
  signature: string;
}

const cache = new Map<string, CacheEntry>();

/** Anything that changes the wire behaviour must invalidate the cached transport. */
function profileSignature(profile: ProviderProfile, baseUrl: string): string {
  // `defaultModel` is in here because the connection test probes it: a cached
  // transport built before the model changed would keep testing the old id.
  return [profile.kind, baseUrl, profile.defaultModel, JSON.stringify(profile.headers)].join('|');
}

export class MissingKeyError extends GatewayError {
  constructor(profileName: string) {
    super({
      kind: 'validation',
      message: `No API key saved for "${profileName}".`,
      hint: 'Open Settings → Providers, paste the token from your gateway console, and run Test connection.',
    });
  }
}

export interface ResolveOptions {
  /** Use the profile's fallback origin instead of its primary. */
  useFallback?: boolean;
  profileId?: string;
}

/**
 * Build (or reuse) the transport for a profile.
 *
 * Throws {@link MissingKeyError} rather than sending an empty Bearer token, because
 * the gateway answers that with the same 401 it uses for a rejected client — which
 * would send the user hunting an allowlist problem they don't have.
 */
export async function resolveTransport(options: ResolveOptions = {}): Promise<{
  transport: Transport;
  profile: ProviderProfile;
  baseUrl: string;
}> {
  const profile = options.profileId
    ? (useProviders.getState().byId(options.profileId) ?? activeProfile())
    : activeProfile();

  const origin = options.useFallback && profile.fallbackBaseUrl ? profile.fallbackBaseUrl : profile.baseUrl;
  const baseUrl = normaliseBaseUrl(profile.kind, origin);

  const key = await loadApiKey(profile.id);
  if (!key) throw new MissingKeyError(profile.name);

  const fingerprint = keyFingerprint(key);
  const signature = profileSignature(profile, baseUrl);
  const cacheKey = `${profile.id}|${baseUrl}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint && cached.signature === signature) {
    return { transport: cached.transport, profile, baseUrl };
  }

  const transport = createTransport({
    kind: profile.kind,
    baseUrl,
    apiKey: key,
    defaultModel: profile.defaultModel,
    headers: profile.headers,
    fetchImpl: streamingFetch,
  });

  cache.set(cacheKey, { transport, fingerprint, baseUrl, signature });
  return { transport, profile, baseUrl };
}

/**
 * Resolve a transport for a profile that may not have a key yet.
 *
 * Used by the connection test, which needs to run far enough to *report* a missing
 * key as a step rather than throwing before the first line of output.
 */
export async function resolveTransportOrNull(options: ResolveOptions = {}): Promise<
  { transport: Transport; profile: ProviderProfile; baseUrl: string } | { transport: null; profile: ProviderProfile }
> {
  try {
    return await resolveTransport(options);
  } catch (error) {
    if (error instanceof MissingKeyError) {
      const profile = options.profileId
        ? (useProviders.getState().byId(options.profileId) ?? activeProfile())
        : activeProfile();
      return { transport: null, profile };
    }
    throw error;
  }
}

/** Drop cached transports. Call after editing a profile or changing a key. */
export function invalidateTransports(profileId?: string): void {
  if (!profileId) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${profileId}|`)) cache.delete(key);
  }
}

/**
 * Run an operation, retrying once against the fallback origin if the primary is
 * unreachable.
 *
 * Only `network` failures trigger failover. A 401 or 429 means the primary is up
 * and talking, so retrying elsewhere would just duplicate the failure — and on the
 * parity domain, spend the same credits doing it.
 */
export async function withFailover<T>(
  run: (transport: Transport, baseUrl: string) => Promise<T>,
  options: ResolveOptions & { enabled?: boolean } = {},
): Promise<T> {
  const { transport, profile, baseUrl } = await resolveTransport(options);
  try {
    return await run(transport, baseUrl);
  } catch (error) {
    const failoverPossible =
      options.enabled !== false &&
      !options.useFallback &&
      profile.fallbackBaseUrl !== undefined &&
      error instanceof GatewayError &&
      error.kind === 'network';

    if (!failoverPossible) throw error;

    const fallback = await resolveTransport({ ...options, profileId: profile.id, useFallback: true });
    log.warn('gateway', `Primary unreachable; failing over to ${fallback.baseUrl}.`, { from: baseUrl });
    useProviders.getState().setFailover({ profileId: profile.id, from: baseUrl, to: fallback.baseUrl });
    return await run(fallback.transport, fallback.baseUrl);
  }
}

/**
 * Whether the runtime can actually stream.
 *
 * Reported in Settings because a silent fallback to the buffering `fetch` looks
 * like a slow model rather than a broken transport.
 */
export function streamingAvailable(): boolean {
  return supportsStreaming();
}
