/**
 * Retry policy tests.
 *
 * Every test injects `sleep`, `random` and `now`, so the suite records what the
 * schedule *would* have been without ever waiting. A real timer here would make
 * the exhaustion tests take 90 seconds and hide off-by-one errors in the
 * elapsed-time check behind a passing-but-slow suite.
 */

import { GatewayError } from '../errors';
import { DEFAULT_RETRY_POLICY, NO_RETRY_POLICY, computeDelay, defaultSleep, withRetry } from '../retry';
import type { RetryAttempt, RetryPolicy } from '../retry';

/** A clock and sleeper that advance together, so elapsed time tracks the sleeps. */
function fakeClock(start = 1_000) {
  let current = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => current,
    sleep: (ms: number) => {
      slept.push(ms);
      current += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function err(kind: GatewayError['kind'], extra: Partial<ConstructorParameters<typeof GatewayError>[0]> = {}) {
  return new GatewayError({ kind, message: `${kind} happened`, ...extra });
}

/** Fails `failures` times, then succeeds. Records how many times it ran. */
function flaky<T>(failures: number, value: T, error: () => GatewayError) {
  let calls = 0;
  const operation = () => {
    calls += 1;
    if (calls <= failures) return Promise.reject(error());
    return Promise.resolve(value);
  };
  return { operation, calls: () => calls };
}

describe('computeDelay', () => {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, jitter: 0 };

  it('grows exponentially from the base delay', () => {
    expect(computeDelay(1, policy)).toBe(500);
    expect(computeDelay(2, policy)).toBe(1000);
    expect(computeDelay(3, policy)).toBe(2000);
    expect(computeDelay(4, policy)).toBe(4000);
  });

  it('clamps at maxDelayMs instead of growing without bound', () => {
    // 500 * 2^9 = 256000, far past the 20s ceiling.
    expect(computeDelay(10, policy)).toBe(20_000);
    expect(computeDelay(40, policy)).toBe(20_000);
  });

  it('treats attempt 0 and 1 the same rather than dividing by the factor', () => {
    expect(computeDelay(0, policy)).toBe(500);
  });

  it('applies full jitter as a fraction of the computed delay', () => {
    const full: RetryPolicy = { ...DEFAULT_RETRY_POLICY, jitter: 1 };
    // Full jitter spans (0, delay]: parallel requests must not resynchronise.
    expect(computeDelay(2, full, () => 0)).toBe(0);
    expect(computeDelay(2, full, () => 0.5)).toBe(500);
    expect(computeDelay(2, full, () => 1)).toBe(1000);
  });

  it('applies partial jitter around a floor, not around zero', () => {
    const half: RetryPolicy = { ...DEFAULT_RETRY_POLICY, jitter: 0.5 };
    // Half jitter keeps 50% of the delay fixed: spans [500, 1000] at attempt 2.
    expect(computeDelay(2, half, () => 0)).toBe(500);
    expect(computeDelay(2, half, () => 1)).toBe(1000);
  });

  it('clamps before jittering, so the ceiling is never exceeded', () => {
    const full: RetryPolicy = { ...DEFAULT_RETRY_POLICY, jitter: 1 };
    expect(computeDelay(20, full, () => 1)).toBe(20_000);
  });

  it('returns whole milliseconds', () => {
    const full: RetryPolicy = { ...DEFAULT_RETRY_POLICY, jitter: 1 };
    expect(computeDelay(1, full, () => 1 / 3)).toBe(Math.round(500 / 3));
  });
});

describe('withRetry — what gets retried', () => {
  it('returns the first success without sleeping', async () => {
    const clock = fakeClock();
    const { operation, calls } = flaky(0, 'ok', () => err('server'));

    await expect(withRetry(operation, DEFAULT_RETRY_POLICY, clock)).resolves.toBe('ok');

    expect(calls()).toBe(1);
    expect(clock.slept).toEqual([]);
  });

  it.each(['rate_limited', 'server', 'network'] as const)('retries %s', async (kind) => {
    const clock = fakeClock();
    const { operation, calls } = flaky(1, 'ok', () => err(kind));

    await expect(withRetry(operation, { ...DEFAULT_RETRY_POLICY, jitter: 0 }, clock)).resolves.toBe('ok');

    expect(calls()).toBe(2);
    expect(clock.slept).toEqual([500]);
  });

  it.each([
    'bad_request',
    'validation',
    'client_rejected',
    'key_rejected',
    'forbidden',
    'content_blocked',
    'unsupported_param',
    'not_found',
    'insufficient_credits',
    'parse',
    'unknown',
  ] as const)('never retries %s', async (kind) => {
    const clock = fakeClock();
    const { operation, calls } = flaky(1, 'ok', () => err(kind));

    await expect(withRetry(operation, DEFAULT_RETRY_POLICY, clock)).rejects.toBeInstanceOf(GatewayError);

    // A 4xx other than 429 fails identically forever, and each attempt spends
    // credits against an undocumented rate limit.
    expect(calls()).toBe(1);
    expect(clock.slept).toEqual([]);
  });

  it('never retries an abort, because the user pressed stop', async () => {
    const clock = fakeClock();
    const { operation, calls } = flaky(1, 'ok', () => err('aborted'));

    await expect(withRetry(operation, DEFAULT_RETRY_POLICY, clock)).rejects.toMatchObject({ kind: 'aborted' });

    expect(calls()).toBe(1);
  });

  it('wraps a non-GatewayError thrown by the operation', async () => {
    const clock = fakeClock();
    const operation = () => Promise.reject(new TypeError('Network request failed'));

    // GatewayError.wrap classifies this as `network`, so it is retryable and the
    // attempt cap decides when to stop.
    const promise = withRetry(operation, { ...DEFAULT_RETRY_POLICY, maxAttempts: 2, jitter: 0 }, clock);
    await expect(promise).rejects.toBeInstanceOf(GatewayError);
    expect(clock.slept).toEqual([500]);
  });

  it('surfaces the gateway message verbatim after giving up', async () => {
    const clock = fakeClock();
    const operation = () =>
      Promise.reject(new GatewayError({ kind: 'server', message: '当前分组上游负载已饱和', status: 503 }));

    await expect(withRetry(operation, { ...DEFAULT_RETRY_POLICY, jitter: 0 }, clock)).rejects.toMatchObject({
      message: '当前分组上游负载已饱和',
    });
  });
});

describe('withRetry — caps', () => {
  it('stops at maxAttempts', async () => {
    const clock = fakeClock();
    const { operation, calls } = flaky(99, 'ok', () => err('server'));

    await expect(withRetry(operation, { ...DEFAULT_RETRY_POLICY, jitter: 0 }, clock)).rejects.toBeInstanceOf(GatewayError);

    expect(calls()).toBe(4);
    // Three sleeps for four attempts: the last failure is not followed by a wait.
    expect(clock.slept).toEqual([500, 1000, 2000]);
  });

  it('makes exactly one attempt under NO_RETRY_POLICY', async () => {
    const clock = fakeClock();
    const { operation, calls } = flaky(99, 'ok', () => err('server'));

    await expect(withRetry(operation, NO_RETRY_POLICY, clock)).rejects.toBeInstanceOf(GatewayError);

    expect(calls()).toBe(1);
    expect(clock.slept).toEqual([]);
  });

  it('appends the attempt count as a hint, leaving the message first', async () => {
    const clock = fakeClock();
    const operation = () => Promise.reject(err('rate_limited', { message: 'Too many requests' }));

    await expect(
      withRetry(operation, { ...DEFAULT_RETRY_POLICY, maxAttempts: 3, jitter: 0 }, clock),
    ).rejects.toMatchObject({
      message: 'Too many requests',
      hint: expect.stringContaining('Gave up after 3 attempts.'),
    });
  });

  it('does not claim it gave up after multiple attempts when it only made one', async () => {
    const clock = fakeClock();
    const operation = () => Promise.reject(err('server', { message: 'Boom', hint: 'Original hint.' }));

    await expect(withRetry(operation, NO_RETRY_POLICY, clock)).rejects.toMatchObject({ hint: 'Original hint.' });
  });

  it('gives up when the next sleep would cross maxElapsedMs', async () => {
    const clock = fakeClock();
    const { operation, calls } = flaky(99, 'ok', () => err('server'));

    // Room for the 500ms and 1000ms sleeps, but not the 2000ms one.
    const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 10, jitter: 0, maxElapsedMs: 3_000 };
    await expect(withRetry(operation, policy, clock)).rejects.toBeInstanceOf(GatewayError);

    expect(clock.slept).toEqual([500, 1000]);
    expect(calls()).toBe(3);
  });

  it('counts time spent inside the operation towards maxElapsedMs', async () => {
    const clock = fakeClock();
    let calls = 0;
    const operation = () => {
      calls += 1;
      clock.advance(4_000); // A slow request that timed out.
      return Promise.reject(err('network'));
    };

    const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 10, jitter: 0, maxElapsedMs: 4_200 };
    await expect(withRetry(operation, policy, clock)).rejects.toBeInstanceOf(GatewayError);

    // The first attempt alone burned 4s, leaving no room for even a 500ms wait.
    expect(calls).toBe(1);
    expect(clock.slept).toEqual([]);
  });
});

describe('withRetry — Retry-After', () => {
  it('honours a Retry-After longer than the computed delay', async () => {
    const clock = fakeClock();
    const { operation } = flaky(1, 'ok', () => err('rate_limited', { retryAfterMs: 7_000 }));

    await withRetry(operation, { ...DEFAULT_RETRY_POLICY, jitter: 0 }, clock);

    expect(clock.slept).toEqual([7_000]);
  });

  it('ignores a Retry-After shorter than the computed delay', async () => {
    const clock = fakeClock();
    const { operation } = flaky(1, 'ok', () => err('rate_limited', { retryAfterMs: 10 }));

    // Backing off less than our own schedule would defeat the point of the schedule.
    await withRetry(operation, { ...DEFAULT_RETRY_POLICY, jitter: 0 }, clock);

    expect(clock.slept).toEqual([500]);
  });

  it('clamps an absurd Retry-After to maxDelayMs', async () => {
    const clock = fakeClock();
    const { operation } = flaky(1, 'ok', () => err('rate_limited', { retryAfterMs: 3_600_000 }));

    // A gateway asking for an hour would otherwise hang the request silently.
    await withRetry(operation, { ...DEFAULT_RETRY_POLICY, jitter: 0, maxElapsedMs: 1_000_000 }, clock);

    expect(clock.slept).toEqual([20_000]);
  });
});

describe('withRetry — hooks', () => {
  it('reports each retry before sleeping, so the UI can count down', async () => {
    const clock = fakeClock();
    const seen: RetryAttempt[] = [];
    const { operation } = flaky(2, 'ok', () => err('server', { message: 'upstream down', status: 502 }));

    await withRetry(operation, { ...DEFAULT_RETRY_POLICY, jitter: 0 }, { ...clock, onRetry: (i) => seen.push(i) });

    expect(seen.map((i) => [i.attempt, i.delayMs])).toEqual([
      [1, 500],
      [2, 1000],
    ]);
    expect(seen[0]?.error.message).toBe('upstream down');
  });

  it('does not report anything when the failure is not retryable', async () => {
    const clock = fakeClock();
    const onRetry = jest.fn();
    const operation = () => Promise.reject(err('bad_request'));

    await expect(withRetry(operation, DEFAULT_RETRY_POLICY, { ...clock, onRetry })).rejects.toBeInstanceOf(GatewayError);

    expect(onRetry).not.toHaveBeenCalled();
  });

  it('stops retrying once the signal is aborted', async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    let calls = 0;
    const operation = () => {
      calls += 1;
      controller.abort();
      return Promise.reject(err('server'));
    };

    await expect(
      withRetry(operation, DEFAULT_RETRY_POLICY, { ...clock, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'aborted' });

    expect(calls).toBe(1);
    expect(clock.slept).toEqual([]);
  });

  it('uses the injected random for jitter', async () => {
    const clock = fakeClock();
    const { operation } = flaky(1, 'ok', () => err('server'));

    await withRetry(operation, DEFAULT_RETRY_POLICY, { ...clock, random: () => 0.25 });

    expect(clock.slept).toEqual([125]);
  });
});

describe('defaultSleep', () => {
  it('resolves immediately for a non-positive delay', async () => {
    await expect(defaultSleep(0)).resolves.toBeUndefined();
    await expect(defaultSleep(-5)).resolves.toBeUndefined();
  });

  it('resolves after the delay', async () => {
    const started = Date.now();
    await defaultSleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(defaultSleep(10_000, controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('rejects when aborted mid-wait, rather than running the timer out', async () => {
    const controller = new AbortController();
    const promise = defaultSleep(10_000, controller.signal);
    setTimeout(() => controller.abort(), 5);

    // A 10s timer that ignored the abort would make stop feel broken.
    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
  });
});
