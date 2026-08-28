/**
 * Validation tests.
 *
 * These two rules are the whole reason this module exists: catching them here
 * turns a 400 the user has to decode into a greyed-out control with a reason, and
 * turns a silently-starved answer into a warning while the slider is still moving.
 */

import {
  EFFORT_BUDGETS,
  MIN_ANSWER_HEADROOM,
  MIN_THINKING_BUDGET,
  isThinkingDisableBlocked,
  resolveThinkingBudget,
  validateAnthropicRequest,
} from '../validate';
import type { ChatRequest, ReasoningConfig, ReasoningEffort } from '../types';

const ALL_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function request(maxTokens: number, reasoning?: ReasoningConfig, temperature?: number): ChatRequest {
  const params: ChatRequest['params'] = { maxTokens };
  if (temperature !== undefined) params.temperature = temperature;
  const base: ChatRequest = {
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    params,
  };
  return reasoning ? { ...base, reasoning } : base;
}

const fields = (issues: { field: string }[]) => issues.map((i) => i.field);

describe('isThinkingDisableBlocked', () => {
  it('blocks disabling at xhigh and max', () => {
    expect(isThinkingDisableBlocked({ enabled: false, effort: 'xhigh' })).toBe(true);
    expect(isThinkingDisableBlocked({ enabled: false, effort: 'max' })).toBe(true);
  });

  it('allows disabling at high and below', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high'] as const) {
      expect(isThinkingDisableBlocked({ enabled: false, effort })).toBe(false);
    }
  });

  it('is irrelevant when thinking is enabled', () => {
    // The constraint is only about *disabling*; xhigh with thinking on is fine.
    expect(isThinkingDisableBlocked({ enabled: true, effort: 'max' })).toBe(false);
  });

  it('is false with no reasoning config and with no effort chosen', () => {
    expect(isThinkingDisableBlocked(undefined)).toBe(false);
    expect(isThinkingDisableBlocked({ enabled: false })).toBe(false);
  });
});

describe('resolveThinkingBudget', () => {
  it('returns null when thinking is off or unconfigured', () => {
    expect(resolveThinkingBudget(undefined, 16_384)).toBeNull();
    expect(resolveThinkingBudget({ enabled: false }, 16_384)).toBeNull();
    expect(resolveThinkingBudget({ enabled: false, effort: 'high' }, 16_384)).toBeNull();
  });

  it('maps each effort to its ladder value when there is room', () => {
    for (const effort of ALL_EFFORTS) {
      expect(resolveThinkingBudget({ enabled: true, effort }, 200_000)).toBe(EFFORT_BUDGETS[effort]);
    }
  });

  it('defaults to medium when thinking is on but no effort was chosen', () => {
    expect(resolveThinkingBudget({ enabled: true }, 200_000)).toBe(EFFORT_BUDGETS.medium);
  });

  it('lets an explicit budget beat the effort ladder', () => {
    expect(resolveThinkingBudget({ enabled: true, effort: 'max', budgetTokens: 2_000 }, 200_000)).toBe(2_000);
  });

  it('clamps to leave the answer its headroom', () => {
    // 16384 - 1024 = 15360, so `max` (60000) cannot be honoured.
    expect(resolveThinkingBudget({ enabled: true, effort: 'max' }, 16_384)).toBe(15_360);
    expect(resolveThinkingBudget({ enabled: true, budgetTokens: 100_000 }, 10_000)).toBe(10_000 - MIN_ANSWER_HEADROOM);
  });

  it('never returns a budget below the API floor, even with no room at all', () => {
    // Below the floor the API rejects the budget outright, so the floor wins and
    // validateAnthropicRequest raises the max_tokens error instead.
    expect(resolveThinkingBudget({ enabled: true, effort: 'max' }, 1_500)).toBe(MIN_THINKING_BUDGET);
    expect(resolveThinkingBudget({ enabled: true, budgetTokens: 1 }, 200_000)).toBe(MIN_THINKING_BUDGET);
    expect(resolveThinkingBudget({ enabled: true, effort: 'minimal' }, 0)).toBe(MIN_THINKING_BUDGET);
  });

  it('is exact at the boundary where headroom just fits', () => {
    const maxTokens = MIN_THINKING_BUDGET + MIN_ANSWER_HEADROOM;
    expect(resolveThinkingBudget({ enabled: true, effort: 'max' }, maxTokens)).toBe(MIN_THINKING_BUDGET);
  });
});

describe('validateAnthropicRequest — errors', () => {
  it('errors on disabling thinking at xhigh or max, naming the way out', () => {
    for (const effort of ['xhigh', 'max'] as const) {
      const report = validateAnthropicRequest(request(16_384, { enabled: false, effort }));
      expect(fields(report.errors)).toEqual(['reasoning.enabled']);
      expect(report.errors[0]?.message).toContain(`effort "${effort}"`);
      // The message has to say what to change, not just that it is wrong.
      expect(report.errors[0]?.message).toMatch(/Either enable thinking or drop the effort/);
    }
  });

  it('errors when max_tokens cannot fit the thinking floor plus an answer', () => {
    const report = validateAnthropicRequest(request(1_500, { enabled: true, effort: 'low' }));
    expect(fields(report.errors)).toEqual(['params.maxTokens']);
    expect(report.errors[0]?.message).toContain('Raise max_tokens to at least 2048');
  });

  it('does not raise the max_tokens error when thinking is off', () => {
    // A small max_tokens is a perfectly reasonable choice without thinking.
    expect(validateAnthropicRequest(request(256)).errors).toEqual([]);
    expect(validateAnthropicRequest(request(256, { enabled: false })).errors).toEqual([]);
  });

  it('accepts exactly the floor plus the headroom', () => {
    const report = validateAnthropicRequest(request(2_048, { enabled: true, effort: 'low' }));
    expect(report.errors).toEqual([]);
  });

  it('reports both errors at once rather than stopping at the first', () => {
    const report = validateAnthropicRequest(request(512, { enabled: false, effort: 'max' }));
    // Only the disable error applies here: the max_tokens error needs thinking on.
    expect(fields(report.errors)).toEqual(['reasoning.enabled']);

    const both = validateAnthropicRequest(request(512, { enabled: true, effort: 'max', budgetTokens: 40_000 }));
    expect(fields(both.errors)).toEqual(['params.maxTokens']);
  });

  it('finds nothing wrong with a sensible request', () => {
    const report = validateAnthropicRequest(request(32_000, { enabled: true, effort: 'high' }));
    expect(report).toEqual({ errors: [], warnings: [] });
  });
});

describe('validateAnthropicRequest — warnings', () => {
  it('warns when the budget was trimmed, quoting both numbers', () => {
    const report = validateAnthropicRequest(request(16_384, { enabled: true, effort: 'max' }));
    expect(report.errors).toEqual([]);
    expect(fields(report.warnings)).toContain('reasoning.budgetTokens');
    const message = report.warnings.find((w) => w.field === 'reasoning.budgetTokens')?.message ?? '';
    expect(message).toContain('60000');
    expect(message).toContain('15360');
    expect(message).toMatch(/max_tokens caps total output including thinking/);
  });

  it('does not warn about trimming when the budget fits', () => {
    const report = validateAnthropicRequest(request(200_000, { enabled: true, effort: 'max' }));
    expect(report.warnings).toEqual([]);
  });

  it('does not invent a trim warning when no budget was requested', () => {
    // No effort and no explicit budget means the default applies; there is no
    // user-chosen number to report as trimmed.
    const report = validateAnthropicRequest(request(2_048, { enabled: true }));
    expect(fields(report.warnings)).not.toContain('reasoning.budgetTokens');
  });

  it('warns that the answer will be truncated when little headroom is left', () => {
    // This is the exact combination the spec asks to be warned about: a low
    // max_tokens with a high thinking budget starves the visible answer.
    const report = validateAnthropicRequest(request(9_000, { enabled: true, budgetTokens: 7_500 }));
    const message = report.warnings.find((w) => w.field === 'params.maxTokens')?.message ?? '';
    expect(message).toContain('1500 tokens are left');
    expect(message).toMatch(/thinking plus answer together/);
  });

  it('stays quiet once there is comfortable headroom', () => {
    const report = validateAnthropicRequest(request(20_000, { enabled: true, budgetTokens: 8_192 }));
    expect(fields(report.warnings)).not.toContain('params.maxTokens');
  });

  it('warns at the boundary but not one token past it', () => {
    const tight = validateAnthropicRequest(request(MIN_THINKING_BUDGET + 2_047, { enabled: true, budgetTokens: MIN_THINKING_BUDGET }));
    expect(fields(tight.warnings)).toContain('params.maxTokens');

    const roomy = validateAnthropicRequest(request(MIN_THINKING_BUDGET + 2_048, { enabled: true, budgetTokens: MIN_THINKING_BUDGET }));
    expect(fields(roomy.warnings)).not.toContain('params.maxTokens');
  });

  it('warns when temperature is set alongside thinking', () => {
    const report = validateAnthropicRequest(request(32_000, { enabled: true, effort: 'high' }, 0.4));
    expect(fields(report.warnings)).toEqual(['reasoning.enabled']);
    // The adapter omits it, so the warning explains what will actually be sent.
    expect(report.warnings[0]?.message).toMatch(/omits temperature when thinking is on/);
  });

  it('accepts temperature 1 with thinking on without complaint', () => {
    expect(validateAnthropicRequest(request(32_000, { enabled: true, effort: 'high' }, 1)).warnings).toEqual([]);
  });

  it('says nothing about temperature when thinking is off', () => {
    expect(validateAnthropicRequest(request(4_096, { enabled: false }, 0.2)).warnings).toEqual([]);
    expect(validateAnthropicRequest(request(4_096, undefined, 0.2)).warnings).toEqual([]);
  });

  it('can report several warnings together', () => {
    const report = validateAnthropicRequest(request(9_000, { enabled: true, effort: 'medium', budgetTokens: 8_500 }, 0.7));
    expect(report.errors).toEqual([]);
    expect(fields(report.warnings).sort()).toEqual(['params.maxTokens', 'reasoning.budgetTokens', 'reasoning.enabled']);
  });
});
