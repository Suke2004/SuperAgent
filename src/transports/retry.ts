/**
 * Retry policy.
 *
 * Credits are finite and rate limits are undocumented, so the rules are strict:
 *
 *  - Retry only 429, 5xx, and network failures.
 *  - Never retry any other 4xx. A 400/401/403/404 will fail identically forever,
 *    and each attempt costs a round trip against an undocumented rate limit.
 *  - Never retry an abort. The user pressed stop.
 *  - Honour `Retry-After` when the gateway sends it, rather than guessing.
 *  - Full jitter on the backoff, so parallel requests don't resynchronise.
 *  - Cap both the attempt count and the total elapsed time.
 */

import { GatewayError, isRetryableKind } from './errors';

export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retrying. */
  maxAttempts: number;
  /** Base delay for the exponential schedule. */
  baseDelayMs: number;
  /** Ceiling for a single delay, before jitter. */
  maxDelayMs: number;
  /** Give up once this much wall-clock time has elapsed across all attempts. */
  maxElapsedMs: number;
  /** Multiplier per attempt. */
  factor: number;
  /**
   * Fraction of the computed delay that is randomised, 0..1.
   * 1 means full jitter (`random() * delay`); 0 disables jitter.
   */
  jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  maxElapsedMs: 90_000,
  factor: 2,
  jitter: 1,
};

/** A policy that never retries. Used for the connection test, where the user is waiting. */
export const NO_RETRY_POLICY: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 };

export interface RetryAttempt {
  /** 1-based. */
  attempt: number;
  delayMs: number;
  error: GatewayError;
}

export interface RetryHooks {
  /** Called before sleeping, so the UI can show "retrying in 2s (attempt 2/4)". */
  onRetry?: (info: RetryAttempt) => void;
  signal?: AbortSignal;
  /** Injected for tests. Defaults to `Math.random`. */
  random?: () => number;
  /** Injected for tests. Defaults to a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Exponential backoff with jitter, clamped to `maxDelayMs`. */
export function computeDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const exponential = policy.baseDelayMs * Math.pow(policy.factor, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, policy.maxDelayMs);
  if (policy.jitter <= 0) return Math.round(capped);
  const jittered = capped * (1 - policy.jitter) + capped * policy.jitter * random();
  return Math.round(jittered);
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): GatewayError {
  return new GatewayError({ kind: 'aborted', message: 'Cancelled while waiting to retry.' });
}

/**
 * Run `operation`, retrying per `policy`.
 *
 * `operation` must throw a {@link GatewayError}; the transports guarantee this by
 * funnelling every failure through `classifyThrown`/`classifyHttpError`.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  hooks: RetryHooks = {},
): Promise<T> {
  const random = hooks.random ?? Math.random;
  const sleep = hooks.sleep ?? defaultSleep;
  const now = hooks.now ?? Date.now;
  const startedAt = now();

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await operation(attempt);
    } catch (error) {
      const gatewayError = error instanceof GatewayError ? error : GatewayError.wrap(error);

      if (!isRetryableKind(gatewayError.kind)) throw gatewayError;
      if (attempt >= policy.maxAttempts) throw withExhaustedNote(gatewayError, attempt);
      if (hooks.signal?.aborted) throw abortError();

      // The gateway's own Retry-After wins over our schedule; it knows its limits.
      const computed = computeDelay(attempt, policy, random);
      const delayMs = gatewayError.retryAfterMs !== undefined
        ? Math.min(Math.max(gatewayError.retryAfterMs, computed), policy.maxDelayMs)
        : computed;

      const elapsed = now() - startedAt;
      if (elapsed + delayMs > policy.maxElapsedMs) throw withExhaustedNote(gatewayError, attempt);

      hooks.onRetry?.({ attempt, delayMs, error: gatewayError });
      await sleep(delayMs, hooks.signal);
    }
  }
}

/**
 * Annotate the final error with the attempt count.
 *
 * The gateway's own message stays first, because that is the text the user needs
 * to debug; the retry count is appended as context.
 */
function withExhaustedNote(error: GatewayError, attempts: number): GatewayError {
  if (attempts <= 1) return error;
  return error.withHint(`Gave up after ${attempts} attempts.`);
}
