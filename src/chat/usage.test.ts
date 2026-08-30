import { isUnreported, reportedUsage } from '@/chat/usage';

describe('reportedUsage', () => {
  it('keeps every field the gateway reported, zeroes included', () => {
    expect(reportedUsage({ input: 100, output: 0, thinking: 20, cacheRead: 0, cacheWrite: 5 })).toEqual({
      input: 100,
      output: 0,
      thinking: 20,
      cacheRead: 0,
      cacheWrite: 5,
    });
  });

  /** The whole point: absent must stay absent, not become 0. */
  it('does not invent zeroes for fields that were not reported', () => {
    const usage = reportedUsage({ output: 42 });
    expect(usage).toEqual({ output: 42 });
    expect('input' in usage).toBe(false);
  });

  it('drops anything a caller attached that is not a reported field', () => {
    const usage = reportedUsage({ output: 1, estimated: 999 } as never);
    expect(usage).toEqual({ output: 1 });
  });

  it('returns nothing for nothing', () => {
    expect(reportedUsage({})).toEqual({});
  });
});

describe('isUnreported', () => {
  it('is true only when there is no measurement at all', () => {
    expect(isUnreported({})).toBe(true);
    expect(isUnreported({ cacheRead: 0 })).toBe(false);
    expect(isUnreported({ input: 1, output: 2 })).toBe(false);
  });
});
