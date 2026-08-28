import { BUCKET_LABEL, daysApart, formatDuration, formatRate, whenBucket } from '@/lib/when';

/** Local noon on a date. Month is 0-indexed, and out-of-range days normalise. */
function noon(year: number, month: number, day: number): number {
  return new Date(year, month, day, 12, 0, 0, 0).getTime();
}

describe('daysApart', () => {
  it('counts calendar days, not elapsed hours', () => {
    const now = new Date(2026, 5, 15, 0, 30, 0, 0).getTime();
    const lateLastNight = new Date(2026, 5, 14, 23, 45, 0, 0).getTime();
    // 45 minutes apart, and still a different day. Anything dividing the raw
    // difference by 86,400,000 would call this the same day.
    expect(daysApart(lateLastNight, now)).toBe(1);
  });

  it('is zero for two instants on the same day', () => {
    const morning = new Date(2026, 5, 15, 6, 0, 0, 0).getTime();
    const night = new Date(2026, 5, 15, 23, 59, 59, 999).getTime();
    expect(daysApart(morning, night)).toBe(0);
    expect(daysApart(night, morning)).toBe(0);
  });

  it('is negative for a timestamp in the future', () => {
    expect(daysApart(noon(2026, 5, 16), noon(2026, 5, 15))).toBe(-1);
  });

  it('holds across every day boundary in a year', () => {
    // The real target is daylight saving. A local day that is 23 or 25 hours long
    // makes a floored division report the wrong number of days, and this walks a
    // whole year of local noons so that any zone with a transition in it lands on
    // the bug. In UTC the loop proves only that the arithmetic is consistent —
    // which is the honest limit of a test that cannot choose the runner's zone.
    const start = noon(2026, 0, 1);
    for (let offset = 1; offset <= 365; offset += 1) {
      const later = noon(2026, 0, 1 + offset);
      expect(daysApart(start, later)).toBe(offset);
    }
  });
});

describe('whenBucket', () => {
  const now = noon(2026, 5, 15);

  it('buckets by how a list would head the row', () => {
    expect(whenBucket(now, now)).toBe('today');
    expect(whenBucket(new Date(2026, 5, 15, 0, 0, 0, 0).getTime(), now)).toBe('today');
    expect(whenBucket(noon(2026, 5, 14), now)).toBe('yesterday');
    expect(whenBucket(noon(2026, 5, 13), now)).toBe('week');
    expect(whenBucket(noon(2026, 5, 9), now)).toBe('week');
    expect(whenBucket(noon(2026, 5, 8), now)).toBe('older');
    expect(whenBucket(noon(2025, 5, 15), now)).toBe('older');
  });

  it('treats a future timestamp as today', () => {
    // Clock skew and a restored backup both produce these. "Older" for something
    // written seconds ago is the worse failure.
    expect(whenBucket(noon(2026, 5, 20), now)).toBe('today');
    expect(whenBucket(now + 60_000, now)).toBe('today');
  });

  it('has a label for every bucket', () => {
    for (const bucket of ['today', 'yesterday', 'week', 'older'] as const) {
      expect(BUCKET_LABEL[bucket]).toBeTruthy();
    }
  });
});

describe('formatDuration', () => {
  it('shows bare seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(999)).toBe('0s');
    expect(formatDuration(1_000)).toBe('1s');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(59_999)).toBe('59s');
  });

  it('shows a clock from a minute up', () => {
    expect(formatDuration(60_000)).toBe('1:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(605_000)).toBe('10:05');
    expect(formatDuration(3_599_000)).toBe('59:59');
  });

  it('adds hours only when there are hours', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_905_000)).toBe('1:05:05');
  });

  it('floors rather than rounds', () => {
    // A counter that jumps from 0s to 2s reads as a dropped frame.
    expect(formatDuration(1_900)).toBe('1s');
    expect(formatDuration(119_900)).toBe('1:59');
  });

  it('returns a zero clock for nonsense input', () => {
    expect(formatDuration(-5_000)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0s');
  });
});

describe('formatRate', () => {
  it('rounds to whole tokens once the rate is worth reading', () => {
    expect(formatRate(100, 1_000)).toBe('100 tok/s');
    expect(formatRate(30, 3_000)).toBe('10 tok/s');
    expect(formatRate(101, 4_000)).toBe('25 tok/s');
  });

  it('keeps a decimal for a slow stream', () => {
    expect(formatRate(9, 3_000)).toBe('3.0 tok/s');
    expect(formatRate(7, 2_000)).toBe('3.5 tok/s');
  });

  it('withholds a rate it cannot yet compute honestly', () => {
    // The first delta lands around 200ms in and would read as hundreds a second,
    // then visibly settle downwards.
    expect(formatRate(20, 200)).toBeNull();
    expect(formatRate(20, 999)).toBeNull();
    expect(formatRate(0, 5_000)).toBeNull();
    expect(formatRate(-1, 5_000)).toBeNull();
    expect(formatRate(20, Number.NaN)).toBeNull();
  });
});
