/**
 * The turn budget.
 *
 * Two of these tests exist because of specific bugs the planner was written to
 * kill, and they are the ones to keep if the rest are ever thinned:
 * `reply reservation does not double-count thinking`, and `counts memory and
 * tools`. Both were silent — the app worked, it just threw away window.
 */

import type { ToolDefinition } from '@/transports/types';
import { contextPressure } from '@/lib/tokens';
import {
  BUDGET_MARGIN,
  MIN_HISTORY_BUDGET,
  describeTightBudget,
  planTurn,
  prefixCost,
  replyReservation,
  sendConfirmation,
} from './budget';

const TOOL: ToolDefinition = {
  name: 'search_files',
  description: 'Search the workspace for a pattern.',
  inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
};

describe('replyReservation', () => {
  it('reserves max output tokens', () => {
    expect(replyReservation({ maxTokens: 4_096 })).toBe(4_096);
  });

  it('does not double-count thinking, because max_tokens already includes it', () => {
    const params = { maxTokens: 32_000 };
    const withThinking = replyReservation(params, { enabled: true, budgetTokens: 24_000 });
    expect(withThinking).toBe(32_000);
  });

  it('ignores a thinking budget when thinking is off', () => {
    expect(replyReservation({ maxTokens: 8_192 }, { enabled: false, budgetTokens: 60_000 })).toBe(8_192);
  });

  it('never reserves less than the thinking budget, however odd the config', () => {
    // validateConfig blocks this combination before a send; planning against the
    // larger of the two keeps the budget from going implausibly wide.
    expect(replyReservation({ maxTokens: 1_000 }, { enabled: true, budgetTokens: 4_096 })).toBe(4_096);
  });

  it('survives a half-typed max_tokens', () => {
    expect(replyReservation({ maxTokens: Number.NaN })).toBe(1);
    expect(replyReservation({ maxTokens: 0 })).toBe(1);
  });
});

describe('prefixCost', () => {
  const base = { transport: 'anthropic' as const, contextWindow: 200_000, params: { maxTokens: 4_096 } };

  it('is framing alone for an empty prefix', () => {
    const cost = prefixCost(base);
    expect(cost.system).toBe(0);
    expect(cost.tools).toBe(0);
    expect(cost.total).toBe(cost.framing);
  });

  it('counts the system prompt', () => {
    const cost = prefixCost({ ...base, system: 'You are a careful assistant. '.repeat(20) });
    expect(cost.system).toBeGreaterThan(100);
  });

  it('counts tool definitions, which is the cost most easily forgotten', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...TOOL, name: `${TOOL.name}_${i}` }));
    const cost = prefixCost({ ...base, tools: many });
    expect(cost.tools).toBeGreaterThan(20 * 12);
  });

  it('applies the calibration factor to the estimate', () => {
    const plain = prefixCost({ ...base, system: 'word '.repeat(500) });
    const corrected = prefixCost({ ...base, system: 'word '.repeat(500), calibration: 1.5 });
    expect(corrected.system).toBeGreaterThan(plain.system * 1.4);
  });

  it('ignores a nonsense calibration factor rather than zeroing the prefix', () => {
    const cost = prefixCost({ ...base, system: 'word '.repeat(500), calibration: 0 });
    expect(cost.system).toBeGreaterThan(0);
  });
});

describe('planTurn', () => {
  const base = { transport: 'anthropic' as const, contextWindow: 200_000, params: { maxTokens: 8_192 } };

  it('leaves the window minus the reply, the prefix and the margin', () => {
    const budget = planTurn(base);
    expect(budget.history).toBe(200_000 - 8_192 - budget.prefix.total - BUDGET_MARGIN);
    expect(budget.tight).toBe(false);
  });

  it('gives a reasoning turn its window back', () => {
    // The old arithmetic reserved maxTokens + budgetTokens. At effort max that was
    // 128k of a 200k window handed away for nothing.
    const reasoning = { enabled: true, budgetTokens: 127_999 };
    const planned = planTurn({ ...base, params: { maxTokens: 128_000 }, reasoning });
    const doubleCounted = 200_000 - (128_000 + 127_999) - planned.prefix.total - BUDGET_MARGIN;
    expect(planned.history).toBeGreaterThan(70_000);
    expect(doubleCounted).toBeLessThan(0);
  });

  it('counts memory and tools, so a fat prefix shrinks history', () => {
    const withPrefix = planTurn({
      ...base,
      system: 'note '.repeat(2_000),
      tools: Array.from({ length: 30 }, (_, i) => ({ ...TOOL, name: `t${i}` })),
    });
    expect(withPrefix.history).toBeLessThan(planTurn(base).history);
    expect(withPrefix.prefix.tools).toBeGreaterThan(0);
  });

  it('reports tight rather than trimming history to nothing', () => {
    const budget = planTurn({
      transport: 'anthropic',
      contextWindow: 10_000,
      params: { maxTokens: 8_000 },
      system: 'word '.repeat(3_000),
    });
    expect(budget.tight).toBe(true);
    expect(budget.history).toBe(MIN_HISTORY_BUDGET);
  });

  it('honours an explicit margin', () => {
    expect(planTurn({ ...base, margin: 0 }).history).toBe(planTurn(base).history + BUDGET_MARGIN);
  });
});

describe('describeTightBudget', () => {
  it('names tools when the manifest is the bigger half', () => {
    const budget = planTurn({
      transport: 'anthropic',
      contextWindow: 20_000,
      params: { maxTokens: 8_000 },
      tools: Array.from({ length: 40 }, (_, i) => ({ ...TOOL, name: `t${i}` })),
    });
    const text = describeTightBudget(budget, 40);
    expect(text).toContain('40 tool definitions');
    expect(text).toContain('turning some off');
  });

  it('names the prompt when that is the bigger half', () => {
    const budget = planTurn({
      transport: 'anthropic',
      contextWindow: 20_000,
      params: { maxTokens: 8_000 },
      system: 'word '.repeat(2_000),
    });
    expect(describeTightBudget(budget)).toContain('system prompt and memory notes');
  });

  it('always mentions the reply allowance, which is the one people forget is reserved', () => {
    expect(describeTightBudget(planTurn({ transport: 'anthropic', contextWindow: 8_000, params: { maxTokens: 7_000 } }))).toContain(
      'max output tokens',
    );
  });
});

describe('sendConfirmation', () => {
  const pressure = (used: number) => contextPressure(used, 100_000, 8_000, 0.7);

  it('asks nothing while there is room, whatever the strategy', () => {
    for (const strategy of ['warn', 'drop_oldest', 'summarise'] as const) {
      expect(sendConfirmation(pressure(10_000), strategy)).toBeNull();
      expect(sendConfirmation(pressure(80_000), strategy)).toBeNull();
    }
  });

  it('asks nothing for the strategies that trim, because they fix it themselves', () => {
    expect(sendConfirmation(pressure(150_000), 'drop_oldest')).toBeNull();
    expect(sendConfirmation(pressure(150_000), 'summarise')).toBeNull();
  });

  it('asks once when `warn` is over the usable window', () => {
    const ask = sendConfirmation(pressure(100_000), 'warn');
    expect(ask).not.toBeNull();
    // 100,000 used against 92,000 usable.
    expect(ask?.body).toContain('8.0k');
    expect(ask?.body).toContain('held back for the reply');
  });

  it('never claims the overflow is zero at the exact boundary', () => {
    const ask = sendConfirmation(pressure(92_000), 'warn');
    expect(ask?.body).toContain('1 tokens');
  });
});
