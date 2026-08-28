/**
 * Timestamps in the words a list row has space for.
 *
 * Every function takes `now` as an argument rather than reading the clock. That
 * is not only for the tests: a list that formats fifty rows should decide what
 * "today" means once, not fifty times, or a render straddling midnight would
 * label two rows inconsistently.
 *
 * Nothing here calls `toLocaleString`. Which of "14:32" and "2:32 PM" a user
 * expects is the platform's business, so the components ask the platform for that
 * and use these functions only for the parts that must not vary: which day
 * bucket a row belongs to, and how long a stream has been running.
 */

const DAY = 86_400_000;

/** Local midnight at or before `at`. */
function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Whole calendar days between two instants, in local time.
 *
 * Rounded rather than floored because a daylight-saving transition makes one
 * local day 23 or 25 hours long, and a floor would report the shorter one as
 * zero days — putting yesterday's conversation under "Today".
 */
export function daysApart(at: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(at)) / DAY);
}

export type WhenBucket = 'today' | 'yesterday' | 'week' | 'older';

/**
 * Which heading a timestamp sorts under.
 *
 * A timestamp in the future returns `'today'`. Clock skew and a restored backup
 * both produce those, and a row headed "Older" for something written seconds ago
 * is worse than one rounded down to today.
 */
export function whenBucket(at: number, now: number): WhenBucket {
  const days = daysApart(at, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= 6) return 'week';
  return 'older';
}

export const BUCKET_LABEL: Record<WhenBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Earlier this week',
  older: 'Older',
};

/**
 * Elapsed time, as a clock.
 *
 * `12s`, `1:05`, `1:05:00`. Seconds are floored, not rounded: a counter that
 * shows `1s` when 600ms have passed reads as though it skipped a beat, and a
 * running clock is judged by whether it ticks evenly.
 */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1_000) : 0;
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  if (minutes > 0) return `${minutes}:${pad(seconds)}`;
  return `${seconds}s`;
}

/**
 * Output rate, or `null` when there is not yet enough to divide by.
 *
 * Withheld below a second because the first delta of a stream arrives after
 * ~200ms and would read as several hundred tokens a second, which is a lie that
 * then settles downwards — visibly, and in the one place the user is watching.
 */
export function formatRate(tokens: number, elapsedMs: number): string | null {
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 1_000) return null;
  const rate = tokens / (elapsedMs / 1_000);
  return `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} tok/s`;
}
