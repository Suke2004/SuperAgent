/**
 * Prompt-cache breakpoint planning.
 *
 * The load-bearing test is `places no history breakpoint when history was
 * rewritten`: a cache write costs 1.25× and a rewritten prefix can never be read
 * back, so marking it is a pure loss that no error message would ever reveal.
 */

import type { ToolDefinition, UnifiedMessage } from '@/transports/types';
import {
  MAX_BREAKPOINTS,
  MIN_CACHEABLE_TOKENS,
  NO_CACHE,
  describeCacheOutcome,
  planCache,
  planCacheForRequest,
} from './cache';

const message = (role: 'user' | 'assistant', text: string): UnifiedMessage => ({
  role,
  content: [{ type: 'text', text }],
});

/** Six turns of roughly 1,000 tokens each. */
const HISTORY: UnifiedMessage[] = Array.from({ length: 6 }, (_, i) =>
  message(i % 2 === 0 ? 'user' : 'assistant', `turn ${i} ${'word '.repeat(800)}`),
);

/** A manifest comfortably over the minimum cacheable prefix. */
const MANIFEST: ToolDefinition[] = Array.from({ length: 40 }, (_, i) => ({
  name: `tool_${i}`,
  description: 'Does a specific thing with a couple of arguments and returns a result.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, depth: { type: 'integer' }, glob: { type: 'string' } },
    required: ['path'],
  },
}));

const BIG_SYSTEM = 'You are a careful assistant working on a mobile client. '.repeat(200);

describe('planCache', () => {
  it('marks nothing when the user has turned caching off', () => {
    expect(planCache({ messages: HISTORY, system: BIG_SYSTEM, tools: MANIFEST, enabled: false })).toEqual(NO_CACHE);
  });

  it('marks nothing when the model is not flagged as supporting it', () => {
    // A gateway that charges the write premium and serves nothing back is worse
    // than no caching at all, so an unknown model opts out.
    const plan = planCache({ messages: HISTORY, system: BIG_SYSTEM, tools: MANIFEST, supported: false });
    expect(plan.tools).toBe(false);
    expect(plan.system).toBe(false);
    expect(plan.historyThrough).toBeUndefined();
    expect(plan.reason).toContain('not flagged as supporting');
  });

  it('marks nothing, with a printable reason, when the stable part is under the minimum', () => {
    const plan = planCache({ messages: [message('user', 'hi')], system: 'Be brief.' });
    expect(plan.cacheable).toBe(0);
    expect(plan.reason).toContain('minimum');
    expect(plan.reason).toContain(MIN_CACHEABLE_TOKENS.toLocaleString());
  });

  it('marks the tool manifest, which is identical every turn and first in the prefix', () => {
    const plan = planCache({ messages: [message('user', 'hi')], tools: MANIFEST });
    expect(plan.tools).toBe(true);
    expect(plan.cacheable).toBeGreaterThanOrEqual(MIN_CACHEABLE_TOKENS);
  });

  it('marks the system prompt on its own when it is large enough', () => {
    const plan = planCache({ messages: [message('user', 'hi')], system: BIG_SYSTEM });
    expect(plan.system).toBe(true);
    expect(plan.tools).toBe(false);
  });

  it('applies the minimum to the cumulative prefix, not to each section alone', () => {
    // A short system prompt sitting behind a large manifest is cacheable, because
    // a breakpoint covers everything before it as well.
    const short = 'Answer in British English.';
    const plan = planCache({ messages: [message('user', 'hi')], system: short, tools: MANIFEST });
    expect(plan.system).toBe(true);
    expect(plan.tools).toBe(true);
  });

  it('never marks a system prompt that is not there', () => {
    const plan = planCache({ messages: [message('user', 'hi')], system: '', tools: MANIFEST });
    expect(plan.system).toBe(false);
  });

  it('marks history short of the newest exchange, so the entry is not stale on arrival', () => {
    const plan = planCache({ messages: HISTORY });
    expect(plan.historyThrough).toBe(HISTORY.length - 3);
  });

  it('places no history breakpoint when history was rewritten for this turn', () => {
    const plan = planCache({ messages: HISTORY, historyRewritten: true });
    expect(plan.historyThrough).toBeUndefined();
    expect(plan.reason).toContain('minimum');
  });

  it('still marks the stable prefix after a trim, since only history was rewritten', () => {
    const plan = planCache({ messages: HISTORY, system: BIG_SYSTEM, tools: MANIFEST, historyRewritten: true });
    expect(plan.tools).toBe(true);
    expect(plan.system).toBe(true);
    expect(plan.historyThrough).toBeUndefined();
  });

  it('places no history breakpoint on a conversation that is only the newest exchange', () => {
    const plan = planCache({ messages: [message('user', 'hi'), message('assistant', 'hello')], tools: MANIFEST });
    expect(plan.historyThrough).toBeUndefined();
    expect(plan.tools).toBe(true);
  });

  it('stays within the API breakpoint allowance and leaves one spare for the tool loop', () => {
    const plan = planCache({ messages: HISTORY, system: BIG_SYSTEM, tools: MANIFEST });
    const marks = Number(plan.tools) + Number(plan.system) + Number(plan.historyThrough !== undefined);
    expect(marks).toBe(3);
    expect(marks).toBeLessThan(MAX_BREAKPOINTS);
  });

  it('counts only what it actually marked as cacheable', () => {
    const all = planCache({ messages: HISTORY, system: BIG_SYSTEM, tools: MANIFEST });
    const trimmed = planCache({ messages: HISTORY, system: BIG_SYSTEM, tools: MANIFEST, historyRewritten: true });
    expect(all.cacheable).toBeGreaterThan(trimmed.cacheable);
  });

  it('honours an explicit minimum, for a model with the lower floor', () => {
    const plan = planCache({ messages: [message('user', 'hi')], system: 'Be brief.', minCacheable: 1 });
    expect(plan.system).toBe(true);
  });
});

describe('planCacheForRequest', () => {
  it('plans against an assembled request', () => {
    const plan = planCacheForRequest({ system: BIG_SYSTEM, messages: HISTORY, tools: MANIFEST });
    expect(plan.system).toBe(true);
    expect(plan.tools).toBe(true);
    expect(plan.historyThrough).toBe(HISTORY.length - 3);
  });

  it('passes the options through', () => {
    expect(planCacheForRequest({ messages: HISTORY }, { enabled: false })).toEqual(NO_CACHE);
  });
});

describe('describeCacheOutcome', () => {
  const plan = planCache({ messages: HISTORY, tools: MANIFEST });

  it('reports the measured read, not the planned one', () => {
    expect(describeCacheOutcome({ cacheRead: 12_400, cacheWrite: 0 }, plan)).toContain('12,400 tokens served from cache');
  });

  it('explains a write as an investment in the next turn', () => {
    expect(describeCacheOutcome({ cacheWrite: 9_000 }, plan)).toContain('next turn');
  });

  it('falls back to the plan reason when there was nothing to cache', () => {
    const nothing = planCache({ messages: [message('user', 'hi')] });
    expect(describeCacheOutcome({}, nothing)).toBe(nothing.reason);
  });

  it('says plainly that we asked and got nothing, rather than a projected saving', () => {
    expect(describeCacheOutcome({ cacheRead: 0, cacheWrite: 0 }, plan)).toContain('reported none');
  });
});
