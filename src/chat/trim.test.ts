/**
 * The progressive trim ladder.
 *
 * The load-bearing cases here are `returns the input untouched when it already
 * fits` (an unmodified prefix is a cacheable prefix) and `keeps thinking in a
 * message that contains a tool_use` (dropping it is a 400 from the API, not a
 * smaller request). Both are invisible in normal use until they aren't.
 */

import type { UnifiedMessage } from '@/transports/types';
import { estimateMessagesTokens } from '@/lib/tokens';
import { TOOL_RESULT_CAP, describeTrim, trimToBudget, truncateMiddle } from './trim';

const user = (text: string): UnifiedMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string): UnifiedMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });

const thinker = (thinking: string, text: string): UnifiedMessage => ({
  role: 'assistant',
  content: [
    { type: 'thinking', text: thinking, signature: 'sig' },
    { type: 'text', text },
  ],
});

const caller = (thinking: string): UnifiedMessage => ({
  role: 'assistant',
  content: [
    { type: 'thinking', text: thinking, signature: 'sig' },
    { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
  ],
});

const result = (content: string): UnifiedMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', toolUseId: 'call_1', content }],
});

const LONG_THINKING = 'reasoning about the problem in some detail. '.repeat(200);

describe('truncateMiddle', () => {
  it('leaves text within the cap alone', () => {
    expect(truncateMiddle('short', 100)).toBe('short');
  });

  it('keeps both ends and says how much is missing', () => {
    const text = `HEAD${'x'.repeat(5_000)}TAIL`;
    const cut = truncateMiddle(text, 1_000);
    expect(cut.startsWith('HEAD')).toBe(true);
    expect(cut.endsWith('TAIL')).toBe(true);
    expect(cut).toContain('characters elided');
    expect(cut.length).toBeLessThanOrEqual(1_000);
  });

  it('weights the head, because the start of a result is referred back to more', () => {
    const cut = truncateMiddle('a'.repeat(2_000) + 'b'.repeat(2_000), 1_000);
    const head = cut.indexOf('…');
    expect(head).toBeGreaterThan(cut.length - head);
  });
});

describe('trimToBudget', () => {
  it('returns the input untouched when it already fits, keeping the prefix cacheable', () => {
    const messages = [user('hello'), assistant('hi')];
    const report = trimToBudget(messages, 100_000);
    expect(report.actions).toEqual([]);
    expect(report.messages).toEqual(messages);
    expect(report.before).toBe(report.after);
    expect(report.keep).toEqual([0, 1]);
    expect(report.dropped).toEqual([]);
  });

  it('drops replayed reasoning first, and only outside the tail', () => {
    const messages = [user('first'), thinker(LONG_THINKING, 'answer'), user('second')];
    const report = trimToBudget(messages, 1_000);
    expect(report.actions.map((a) => a.step)).toEqual(['strip_thinking']);
    expect(report.messages[1]?.content.some((b) => b.type === 'thinking')).toBe(false);
    expect(report.messages[1]?.content.some((b) => b.type === 'text')).toBe(true);
    expect(report.after).toBeLessThan(report.before);
    expect(report.dropped).toEqual([]);
  });

  it('keeps thinking in a message that contains a tool_use, because the API requires it back verbatim', () => {
    const messages = [
      user('first'),
      thinker(LONG_THINKING, 'answer'),
      user('second'),
      caller(LONG_THINKING),
      result('ok'),
    ];
    const report = trimToBudget(messages, 2_500);
    expect(report.actions.map((a) => a.step)).toEqual(['strip_thinking']);
    expect(report.actions[0]?.count).toBe(1);
    expect(report.messages[1]?.content.some((b) => b.type === 'thinking')).toBe(false);
    expect(report.messages[3]?.content.some((b) => b.type === 'thinking')).toBe(true);
  });

  it('honours keepThinkingInLast', () => {
    const messages = [thinker(LONG_THINKING, 'one'), user('q'), thinker(LONG_THINKING, 'two')];
    const kept = trimToBudget(messages, 1_000, { keepThinkingInLast: 3 });
    expect(kept.actions.map((a) => a.step)).not.toContain('strip_thinking');
  });

  it('leaves a thinking-only message alone rather than emptying its content', () => {
    const messages: UnifiedMessage[] = [
      user('first'),
      { role: 'assistant', content: [{ type: 'thinking', text: LONG_THINKING }] },
      user('second'),
    ];
    const report = trimToBudget(messages, 1_000);
    expect(report.actions.map((a) => a.step)).not.toContain('strip_thinking');
    expect(report.messages.every((m) => m.content.length > 0)).toBe(true);
  });

  it('shortens long tool results when stripping reasoning was not enough', () => {
    const messages = [user('go'), caller('brief'), result('LINE\n'.repeat(8_000)), user('and then?')];
    const report = trimToBudget(messages, 2_000);
    expect(report.actions.map((a) => a.step)).toContain('truncate_tool_results');
    const block = report.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    expect(block?.type === 'tool_result' && block.content.length).toBeLessThanOrEqual(TOOL_RESULT_CAP);
    expect(block?.type === 'tool_result' && block.content).toContain('elided');
  });

  it('truncates every over-cap result, not just enough of them to fit', () => {
    const big = 'x'.repeat(20_000);
    const messages = [user('go'), caller('a'), result(big), user('again'), caller('b'), result(big), user('?')];
    const report = trimToBudget(messages, 3_000);
    const truncation = report.actions.find((a) => a.step === 'truncate_tool_results');
    expect(truncation?.count).toBe(2);
  });

  it('drops whole turns only as the last step', () => {
    const messages = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? user(`q${i} ${'word '.repeat(200)}`) : assistant(`a${i}`)));
    const report = trimToBudget(messages, 2_000);
    expect(report.actions.map((a) => a.step)).toContain('drop_turns');
    expect(report.dropped.length).toBeGreaterThan(0);
    // The newest message survives whatever the budget says.
    expect(report.keep[report.keep.length - 1]).toBe(19);
    expect(estimateMessagesTokens(report.messages)).toBe(report.after);
  });

  it('reports indices into the input array, so stored rows can be marked excluded', () => {
    const messages = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? user(`${'word '.repeat(400)}`) : assistant('ok')));
    const report = trimToBudget(messages, 1_500);
    expect([...report.keep].sort((a, b) => a - b)).toEqual(report.keep);
    expect(report.keep.concat(report.dropped).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('can be disabled step by step by the caller', () => {
    // What `progressiveTrim: false` in settings does: no thinking stripped, no
    // results shortened, straight to dropping turns.
    const messages = [user('first'), thinker(LONG_THINKING, 'answer'), user('second')];
    const report = trimToBudget(messages, 1_000, {
      keepThinkingInLast: messages.length,
      toolResultCap: Number.MAX_SAFE_INTEGER,
    });
    expect(report.actions.map((a) => a.step)).toEqual(['drop_turns']);
  });
});

describe('describeTrim', () => {
  it('says nothing when nothing was trimmed', () => {
    expect(describeTrim(trimToBudget([user('hi')], 100_000))).toBe('');
  });

  it('names what was lost rather than what was saved', () => {
    const messages = [user('first'), thinker(LONG_THINKING, 'answer'), user('second')];
    const text = describeTrim(trimToBudget(messages, 1_000));
    expect(text).toContain('reasoning from earlier turns is no longer sent');
    expect(text).toContain('tokens of input saved');
  });

  it('counts dropped messages', () => {
    const messages = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? user('word '.repeat(300)) : assistant('ok')));
    expect(describeTrim(trimToBudget(messages, 1_200))).toMatch(/\d+ earlier messages? left out entirely/);
  });
});
