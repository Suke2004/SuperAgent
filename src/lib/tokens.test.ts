import {
  breakdownText,
  contextPressure,
  estimateBlockTokens,
  estimateCost,
  estimateMessageTokens,
  estimateRequestTokens,
  estimateTextTokens,
  formatCost,
  formatTokens,
  formatUsage,
  readPricing,
  selectMessagesWithinBudget,
} from '@/lib/tokens';
import type { ContentBlock, UnifiedMessage } from '@/transports/types';

function user(text: string): UnifiedMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistant(text: string): UnifiedMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

describe('estimateTextTokens', () => {
  it('returns 0 for the empty string', () => {
    expect(estimateTextTokens('')).toBe(0);
  });

  it('never returns 0 for non-empty input', () => {
    expect(estimateTextTokens('a')).toBeGreaterThan(0);
    expect(estimateTextTokens(' ')).toBeGreaterThan(0);
  });

  it('grows monotonically with length', () => {
    let previous = 0;
    for (const length of [1, 10, 100, 1_000, 10_000]) {
      const tokens = estimateTextTokens('x'.repeat(length));
      expect(tokens).toBeGreaterThanOrEqual(previous);
      previous = tokens;
    }
  });

  it('lands within 25% of a real tokenizer on English prose', () => {
    // 43 characters; cl100k gives 9 tokens for this sentence.
    const tokens = estimateTextTokens('The quick brown fox jumps over the lazy dog');
    expect(tokens).toBeGreaterThanOrEqual(7);
    expect(tokens).toBeLessThanOrEqual(14);
  });

  it('charges CJK far more per character than Latin', () => {
    // Same character count, wildly different real token cost.
    const chinese = estimateTextTokens('数据分析报告生成器测试'); // 11 chars
    const latin = estimateTextTokens('abcdefghijk'); // 11 chars
    expect(chinese).toBeGreaterThan(latin * 2);
  });

  it('counts Cyrillic on the alphabetic path, not the CJK path', () => {
    // The gateway accepts Russian; treating it as ideographic would triple the
    // estimate and make the pressure bar useless for a Russian conversation.
    const russian = estimateTextTokens('Привет мир как дела');
    const english = estimateTextTokens('Hello world how are');
    expect(Math.abs(russian - english)).toBeLessThanOrEqual(2);
  });

  it('handles surrogate pairs without splitting them', () => {
    // Iterating a string by index rather than code point would count each half
    // of an emoji separately and inflate the estimate.
    const breakdown = breakdownText('🎉🎉🎉');
    expect(breakdown.cjkChars + breakdown.otherChars).toBe(3);
  });

  it('partitions mixed scripts', () => {
    const breakdown = breakdownText('hello 世界');
    expect(breakdown.cjkChars).toBe(2);
    expect(breakdown.otherChars).toBe(6); // 'hello' + space
  });
});

describe('estimateBlockTokens', () => {
  it('charges a flat, pessimistic amount for images', () => {
    const block: ContentBlock = { type: 'image', mediaType: 'image/jpeg', data: 'AAAA' };
    // Not derived from the base64 length: a 200 KB photo and a 2 MB photo cost
    // the same once resized, and the cost tracks pixels rather than bytes.
    expect(estimateBlockTokens(block)).toBeGreaterThan(1_000);
  });

  it('counts thinking blocks, because they are replayed as input', () => {
    const plain: ContentBlock = { type: 'thinking', text: 'weighing the options' };
    const signed: ContentBlock = { type: 'thinking', text: 'weighing the options', signature: 'abc' };
    expect(estimateBlockTokens(plain)).toBeGreaterThan(0);
    expect(estimateBlockTokens(signed)).toBeGreaterThan(estimateBlockTokens(plain));
  });

  it('prefers extracted text over base64 for documents', () => {
    const extracted: ContentBlock = { type: 'document', mediaType: 'text/plain', text: 'short' };
    const raw: ContentBlock = { type: 'document', mediaType: 'application/pdf', data: 'x'.repeat(9_000) };
    expect(estimateBlockTokens(extracted)).toBeLessThan(estimateBlockTokens(raw));
  });

  it('counts a tool_use block as its name plus serialised input', () => {
    const block: ContentBlock = {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'invoke_skill',
      input: { name: 'commit-messages' },
    };
    expect(estimateBlockTokens(block)).toBeGreaterThan(8);
  });

  it('survives an unserialisable tool input', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const block: ContentBlock = { type: 'tool_use', id: 't', name: 'n', input: cyclic };
    expect(() => estimateBlockTokens(block)).not.toThrow();
  });

  it('counts a tool_result as its content', () => {
    const small: ContentBlock = { type: 'tool_result', toolUseId: 't', content: 'ok' };
    const large: ContentBlock = { type: 'tool_result', toolUseId: 't', content: 'x'.repeat(4_000) };
    expect(estimateBlockTokens(large)).toBeGreaterThan(estimateBlockTokens(small) * 10);
  });
});

describe('estimateMessageTokens', () => {
  it('adds per-message framing', () => {
    const empty: UnifiedMessage = { role: 'user', content: [] };
    expect(estimateMessageTokens(empty)).toBeGreaterThan(0);
  });

  it('sums every block in the message', () => {
    const single = estimateMessageTokens(user('hello there friend'));
    const doubled = estimateMessageTokens({
      role: 'user',
      content: [
        { type: 'text', text: 'hello there friend' },
        { type: 'text', text: 'hello there friend' },
      ],
    });
    expect(doubled).toBeGreaterThan(single);
  });
});

describe('estimateRequestTokens', () => {
  it('separates system, messages and tools', () => {
    const estimate = estimateRequestTokens({
      system: 'You are a careful assistant.',
      messages: [user('hi')],
      tools: [
        {
          name: 'invoke_skill',
          description: 'Load the full body of a named skill.',
          inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        },
      ],
    });
    expect(estimate.system).toBeGreaterThan(0);
    expect(estimate.messages).toBeGreaterThan(0);
    expect(estimate.tools).toBeGreaterThan(0);
    expect(estimate.total).toBeGreaterThan(estimate.system + estimate.messages + estimate.tools - 1);
  });

  it('charges nothing for tools when none are enabled', () => {
    expect(estimateRequestTokens({ messages: [user('hi')] }).tools).toBe(0);
  });

  it('makes a large tool list dominate a short conversation', () => {
    // The justification for per-tool enable/disable in Phase 5 — worth pinning.
    const tools = Array.from({ length: 40 }, (_, i) => ({
      name: `some_server_tool_${i}`,
      description: 'Does a thing with several documented options and caveats.',
      inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } },
    }));
    const estimate = estimateRequestTokens({ messages: [user('hi')], tools });
    expect(estimate.tools).toBeGreaterThan(estimate.messages * 10);
  });
});

describe('contextPressure', () => {
  it('measures against usable space, not the raw window', () => {
    // 100k window, 32k reserved for the reply → 68k usable. 60k of input is
    // 88% of usable but only 60% of the window; the bar must show the former,
    // which is the difference between a warning and a green bar.
    const pressure = contextPressure(60_000, 100_000, 32_000, 0.8);
    expect(pressure.ratio).toBeCloseTo(60_000 / 68_000, 5);
    expect(pressure.level).toBe('warn');
    expect(contextPressure(60_000, 100_000, 0, 0.8).level).toBe('ok');
  });

  it('reports ok well below the threshold', () => {
    expect(contextPressure(1_000, 200_000, 8_000, 0.8).level).toBe('ok');
  });

  it('reports warn at the configured threshold', () => {
    const window = 100_000;
    const reserved = 0;
    const pressure = contextPressure(80_000, window, reserved, 0.8);
    expect(pressure.level).toBe('warn');
  });

  it('escalates to critical between the threshold and full', () => {
    expect(contextPressure(92_000, 100_000, 0, 0.8).level).toBe('critical');
  });

  it('reports over once input exceeds usable space', () => {
    const pressure = contextPressure(120_000, 100_000, 0, 0.8);
    expect(pressure.level).toBe('over');
    expect(pressure.remaining).toBe(0);
  });

  it('does not divide by zero when the reply allowance swallows the window', () => {
    const pressure = contextPressure(10, 8_000, 8_000, 0.8);
    expect(Number.isFinite(pressure.ratio)).toBe(true);
    expect(pressure.level).toBe('over');
  });

  it('respects a threshold the user moved', () => {
    expect(contextPressure(55_000, 100_000, 0, 0.5).level).not.toBe('ok');
    expect(contextPressure(55_000, 100_000, 0, 0.9).level).toBe('ok');
  });
});

describe('selectMessagesWithinBudget', () => {
  const conversation: UnifiedMessage[] = [
    user('first question '.repeat(20)),
    assistant('first answer '.repeat(20)),
    user('second question '.repeat(20)),
    assistant('second answer '.repeat(20)),
    user('third question '.repeat(20)),
  ];

  it('keeps everything when the budget is ample', () => {
    const { keep, dropped } = selectMessagesWithinBudget(conversation, 1_000_000);
    expect(keep).toEqual([0, 1, 2, 3, 4]);
    expect(dropped).toEqual([]);
  });

  it('drops from the oldest end', () => {
    const perMessage = estimateMessageTokens(conversation[0] as UnifiedMessage);
    const { keep, dropped } = selectMessagesWithinBudget(conversation, perMessage * 2.5);
    expect(dropped[0]).toBe(0);
    expect(keep).toContain(4);
  });

  it('always keeps the newest message even if it alone exceeds the budget', () => {
    // Dropping the message being answered would send an empty request.
    const { keep } = selectMessagesWithinBudget(conversation, 1);
    expect(keep).toEqual([4]);
  });

  it('never starts the kept run on an assistant message', () => {
    // A leading assistant message is rejected outright on the Anthropic path.
    for (let budget = 1; budget < 2_000; budget += 37) {
      const { keep } = selectMessagesWithinBudget(conversation, budget);
      if (keep.length > 1) {
        expect(conversation[keep[0] as number]?.role).toBe('user');
      }
    }
  });

  it('returns keep and dropped as a complete partition', () => {
    const { keep, dropped } = selectMessagesWithinBudget(conversation, 300);
    expect([...keep, ...dropped].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('reports the token total of what it kept', () => {
    const { keep, tokens } = selectMessagesWithinBudget(conversation, 400);
    const recomputed = keep.reduce(
      (sum, index) => sum + estimateMessageTokens(conversation[index] as UnifiedMessage),
      0,
    );
    expect(tokens).toBe(recomputed);
  });

  it('handles an empty conversation', () => {
    expect(selectMessagesWithinBudget([], 1_000)).toEqual({ keep: [], dropped: [], tokens: 0 });
  });
});

describe('estimateCost', () => {
  it('returns null when pricing is unknown', () => {
    // Distinguishable from a genuine zero on a free-tier gateway.
    expect(estimateCost({ input: 1_000, output: 500 })).toBeNull();
  });

  it('charges input and output at their own rates', () => {
    const cost = estimateCost({ input: 1_000_000, output: 1_000_000 }, { inputPerMTok: 3, outputPerMTok: 15 });
    expect(cost).not.toBeNull();
    expect(cost?.input).toBeCloseTo(3, 6);
    expect(cost?.output).toBeCloseTo(15, 6);
    expect(cost?.total).toBeCloseTo(18, 6);
  });

  it('bills cache traffic at the input rate', () => {
    const cost = estimateCost(
      { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
      { inputPerMTok: 3, outputPerMTok: 15 },
    );
    expect(cost?.input).toBeCloseTo(6, 6);
  });

  it('does not double-count thinking tokens', () => {
    // Thinking is already inside `output` on both paths.
    const withThinking = estimateCost(
      { input: 100, output: 1_000, thinking: 800 },
      { inputPerMTok: 3, outputPerMTok: 15 },
    );
    const without = estimateCost({ input: 100, output: 1_000 }, { inputPerMTok: 3, outputPerMTok: 15 });
    expect(withThinking?.total).toBeCloseTo(without?.total ?? -1, 10);
  });

  it('treats a missing field as zero rather than NaN', () => {
    const cost = estimateCost({ output: 10 }, { inputPerMTok: 3, outputPerMTok: 15 });
    expect(Number.isFinite(cost?.total ?? NaN)).toBe(true);
  });
});

describe('readPricing', () => {
  it('reads a filled pair', () => {
    expect(readPricing('3', '15')).toEqual({ ok: true, pricing: { inputPerMTok: 3, outputPerMTok: 15 } });
    expect(readPricing('0', '0.5')).toEqual({ ok: true, pricing: { inputPerMTok: 0, outputPerMTok: 0.5 } });
  });

  it('treats both blank as clearing the price, not as an error', () => {
    expect(readPricing('', '')).toEqual({ ok: true });
    expect(readPricing('  ', '')).toEqual({ ok: true });
  });

  it('refuses a half-filled pair instead of silently doing nothing', () => {
    // The bug this function exists for: one side typed and the other blank used to
    // commit neither and say nothing, so the screen showed a price the registry
    // did not have.
    const half = readPricing('3', '');
    expect(half.ok).toBe(false);
    expect(half.ok ? '' : half.issue).toMatch(/Both prices/);
    expect(readPricing('', '15').ok).toBe(false);
  });

  it('refuses text and negative numbers', () => {
    expect(readPricing('free', '15').ok).toBe(false);
    expect(readPricing('3', '-1').ok).toBe(false);
  });
});

describe('formatting', () => {
  it('formats token counts compactly', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(812)).toBe('812');
    expect(formatTokens(4_200)).toBe('4.2k');
    expect(formatTokens(128_000)).toBe('128k');
    expect(formatTokens(1_310_000)).toBe('1.31M');
  });

  it('keeps small costs legible instead of rounding them to zero', () => {
    expect(formatCost(0)).toBe('0');
    expect(formatCost(0.00001)).toBe('<0.0001');
    expect(formatCost(0.0234)).toBe('0.0234');
    expect(formatCost(12.3456)).toBe('12.35');
  });

  it('omits usage fields the provider did not report', () => {
    expect(formatUsage({ input: 1_200, output: 830 })).toBe('1.2k in · 830 out');
    expect(formatUsage({ input: 10, output: 5, thinking: 900 })).toContain('900 thinking');
    // A zero cache read is noise, not information.
    expect(formatUsage({ input: 10, output: 5, cacheRead: 0 })).not.toContain('cache');
  });

  it('names a missing input or output count rather than printing zero', () => {
    // `0 in` for an unreported prompt count reads as a free turn.
    expect(formatUsage({ output: 830 })).toBe('input not reported · 830 out');
    expect(formatUsage({ input: 1_200 })).toBe('1.2k in · output not reported');
    // A real zero is still a zero.
    expect(formatUsage({ input: 0, output: 0 })).toBe('0 in · 0 out');
  });

  it('produces an empty string for empty usage', () => {
    expect(formatUsage({})).toBe('');
  });
});
