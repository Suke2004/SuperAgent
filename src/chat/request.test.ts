import {
  budgetForEffort,
  buildRequest,
  composeSystem,
  defaultParams,
  EFFORT_BUDGETS,
  hasBlockingIssue,
  mergeParams,
  MIN_THINKING_BUDGET,
  resolveReasoning,
  validateConfig,
} from '@/chat/request';
import type { ConfigIssue } from '@/chat/request';
import type { ModelCapabilities } from '@/transports/support';
import type { ReasoningEffort, TransportKind } from '@/transports/types';

function caps(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    vision: false,
    documents: false,
    tools: true,
    reasoning: true,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    ...overrides,
  };
}

/** Every issue for a field, so a test can assert on one control at a time. */
function forField(issues: ConfigIssue[], field: ConfigIssue['field']): ConfigIssue[] {
  return issues.filter((issue) => issue.field === field);
}

function errors(issues: ConfigIssue[]): ConfigIssue[] {
  return issues.filter((issue) => issue.level === 'error');
}

describe('EFFORT_BUDGETS', () => {
  it('increases monotonically up the ladder', () => {
    const ladder: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const budgets = ladder.map(budgetForEffort);
    for (let i = 1; i < budgets.length; i += 1) {
      expect(budgets[i]).toBeGreaterThan(budgets[i - 1] as number);
    }
  });

  it('never sits below the API floor', () => {
    for (const budget of Object.values(EFFORT_BUDGETS)) {
      expect(budget).toBeGreaterThanOrEqual(MIN_THINKING_BUDGET);
    }
  });
});

describe('validateConfig — max output tokens', () => {
  it('rejects a non-positive cap', () => {
    const issues = validateConfig({
      transport: 'anthropic',
      capabilities: caps(),
      params: { maxTokens: 0 },
    });
    expect(errors(forField(issues, 'maxTokens'))).toHaveLength(1);
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('warns rather than blocks above the recorded model cap', () => {
    // The cap is a hand-editable capability flag, not something the gateway told
    // us, so being wrong about it should not stop a send.
    const issues = validateConfig({
      transport: 'openai',
      capabilities: caps({ maxOutputTokens: 8_192 }),
      params: { maxTokens: 16_000 },
    });
    const found = forField(issues, 'maxTokens');
    expect(found).toHaveLength(1);
    expect(found[0]?.level).toBe('warning');
    expect(hasBlockingIssue(issues)).toBe(false);
  });
});

describe('validateConfig — thinking cannot be disabled above high', () => {
  it.each(['xhigh', 'max'] as const)('blocks thinking off at effort %s', (effort) => {
    const issues = validateConfig({
      transport: 'anthropic',
      capabilities: caps(),
      params: { maxTokens: 8_192 },
      reasoning: { enabled: false, effort },
    });
    const found = forField(issues, 'reasoningEffort');
    expect(found).toHaveLength(1);
    expect(found[0]?.level).toBe('error');
    expect(found[0]?.message).toContain(effort);
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it.each(['minimal', 'low', 'medium', 'high'] as const)('allows thinking off at effort %s', (effort) => {
    const issues = validateConfig({
      transport: 'anthropic',
      capabilities: caps(),
      params: { maxTokens: 8_192 },
      reasoning: { enabled: false, effort },
    });
    expect(forField(issues, 'reasoningEffort')).toHaveLength(0);
  });

  it('does not apply the rule on the OpenAI path', () => {
    // reasoning_effort there is a plain enum with no disable interaction.
    const issues = validateConfig({
      transport: 'openai',
      capabilities: caps(),
      params: { maxTokens: 8_192 },
      reasoning: { enabled: false, effort: 'max' },
    });
    expect(forField(issues, 'reasoningEffort')).toHaveLength(0);
  });

  it('does not fire when thinking is on', () => {
    const issues = validateConfig({
      transport: 'anthropic',
      capabilities: caps(),
      params: { maxTokens: 200_000 },
      reasoning: { enabled: true, effort: 'max', budgetTokens: 127_999 },
    });
    expect(forField(issues, 'reasoningEffort')).toHaveLength(0);
  });
});

describe('validateConfig — max_tokens includes thinking', () => {
  it('blocks a budget that leaves nothing for the answer', () => {
    const issues = validateConfig({
      transport: 'anthropic',
      capabilities: caps(),
      params: { maxTokens: 4_096 },
      reasoning: { enabled: true, effort: 'high', budgetTokens: 32_768 },
    });
    const found = errors(forField(issues, 'maxTokens'));
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('32,768');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('blocks the exactly-equal case, which leaves zero', () => {
    const issues = validateConfig({
      transport: 'anthropic',
      capabilities: caps(),
      params: { maxTokens: 16_384 },
      reasoning: { enabled: true, effort: 'medium', budgetTokens: 16_384 },
    });
    expect(errors(forField(issues, 'maxTokens'))).toHaveLength(1);
  });

  it('warns on a thin but non-zero margin', () => {
    const issues = validateConfig({
      transport: 'anthropic',
      capabilities: caps(),
      params: { maxTokens: 17_000 },
      reasoning: { enabled: true, effort: 'medium', budgetTokens: 16_384 },
    });
    const found = forField(issues, 'maxTokens');
    expect(found).toHaveLength(1);
    expect(found[0]?.level).toBe('warning');
    expect(found[0]?.message).toContain('616');
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it('stays quiet with comfortable headroom', () => {
    const issues = validateConfig({
      transport: 'anthropic',
      capabilities: caps(),
      params: { maxTokens: 32_000 },
      reasoning: { enabled: true, effort: 'medium', budgetTokens: 16_384 },
    });
    expect(forField(issues, 'maxTokens')).toHaveLength(0);
  });

  it('derives the budget from the effort when none is set', () => {
    const issues = validateConfig({
      transport: 'anthropic',
      capabilities: caps(),
      params: { maxTokens: 4_096 },
      reasoning: { enabled: true, effort: 'high' },
    });
    expect(errors(forField(issues, 'maxTokens'))[0]?.message).toContain(
      EFFORT_BUDGETS.high.toLocaleString(),
    );
  });

  it('rejects a budget below the API floor', () => {
    const issues = validateConfig({
      transport: 'anthropic',
      capabilities: caps(),
      params: { maxTokens: 8_192 },
      reasoning: { enabled: true, effort: 'low', budgetTokens: 512 },
    });
    expect(errors(forField(issues, 'thinkingBudget'))).toHaveLength(1);
  });

  it('does not apply the budget rules on the OpenAI path', () => {
    // There is no budget on that wire, so max_tokens is all for the answer.
    const issues = validateConfig({
      transport: 'openai',
      capabilities: caps(),
      params: { maxTokens: 1_024 },
      reasoning: { enabled: true, effort: 'high' },
    });
    expect(forField(issues, 'maxTokens')).toHaveLength(0);
    expect(forField(issues, 'thinkingBudget')).toHaveLength(0);
  });
});

describe('validateConfig — sampling', () => {
  it('warns that sampling controls are dropped alongside Anthropic thinking', () => {
    const issues = validateConfig({
      transport: 'anthropic',
      capabilities: caps(),
      params: { maxTokens: 32_000, temperature: 0.7 },
      reasoning: { enabled: true, effort: 'medium', budgetTokens: 16_384 },
    });
    const found = forField(issues, 'temperature');
    expect(found).toHaveLength(1);
    expect(found[0]?.level).toBe('warning');
  });

  it.each([-0.1, 2.1])('rejects temperature %p', (temperature) => {
    const issues = validateConfig({
      transport: 'openai',
      capabilities: caps(),
      params: { maxTokens: 8_192, temperature },
    });
    expect(errors(forField(issues, 'temperature'))).toHaveLength(1);
  });

  it.each([0, 2])('accepts temperature %p at the boundary', (temperature) => {
    const issues = validateConfig({
      transport: 'openai',
      capabilities: caps(),
      params: { maxTokens: 8_192, temperature },
    });
    expect(errors(forField(issues, 'temperature'))).toHaveLength(0);
  });

  it.each([0, 1.1])('rejects top_p %p', (topP) => {
    const issues = validateConfig({
      transport: 'openai',
      capabilities: caps(),
      params: { maxTokens: 8_192, topP },
    });
    expect(errors(forField(issues, 'topP'))).toHaveLength(1);
  });

  it('warns when temperature and top_p are both set', () => {
    const issues = validateConfig({
      transport: 'openai',
      capabilities: caps(),
      params: { maxTokens: 8_192, temperature: 0.7, topP: 0.9 },
    });
    const found = forField(issues, 'topP');
    expect(found).toHaveLength(1);
    expect(found[0]?.level).toBe('warning');
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it('warns above four stop sequences on the OpenAI path only', () => {
    const params = { maxTokens: 8_192, stopSequences: ['a', 'b', 'c', 'd', 'e'] };
    expect(forField(validateConfig({ transport: 'openai', capabilities: caps(), params }), 'stopSequences'))
      .toHaveLength(1);
    expect(forField(validateConfig({ transport: 'anthropic', capabilities: caps(), params }), 'stopSequences'))
      .toHaveLength(0);
  });

  it('warns that seed is dropped on the Anthropic path', () => {
    // The Messages API has no seed parameter, so sending one is silently lost.
    const issues = validateConfig({
      transport: 'anthropic',
      capabilities: caps(),
      params: { maxTokens: 8_192, seed: 42 },
    });
    const found = forField(issues, 'seed');
    expect(found).toHaveLength(1);
    expect(found[0]?.level).toBe('warning');
  });

  it('accepts a clean parameter set with no issues at all', () => {
    expect(
      validateConfig({
        transport: 'openai',
        capabilities: caps(),
        params: { maxTokens: 8_192, temperature: 1 },
      }),
    ).toEqual([]);
  });
});

describe('defaultParams and mergeParams', () => {
  it('never defaults above the model cap', () => {
    expect(defaultParams(caps({ maxOutputTokens: 4_096 }))).toEqual({ maxTokens: 4_096 });
  });

  it('leaves every optional field unset, so the adapter omits it', () => {
    expect(Object.keys(defaultParams(caps()))).toEqual(['maxTokens']);
  });

  it('applies overrides over the defaults', () => {
    expect(mergeParams(caps(), { temperature: 0.2, maxTokens: 100 })).toEqual({
      maxTokens: 100,
      temperature: 0.2,
    });
  });

  it.each([0, -1, Number.NaN])('repairs a stored maxTokens of %p', (maxTokens) => {
    // A half-typed field should not make every reply empty and look like a
    // gateway fault.
    expect(mergeParams(caps(), { maxTokens }).maxTokens).toBe(8_192);
  });

  it('returns the defaults untouched when there are no overrides', () => {
    expect(mergeParams(caps(), undefined)).toEqual(defaultParams(caps()));
  });
});

describe('resolveReasoning', () => {
  it('omits reasoning entirely when the model is not flagged capable', () => {
    expect(resolveReasoning('anthropic', caps({ reasoning: false }), { enabled: true, effort: 'high' })).toBeUndefined();
  });

  it('omits reasoning when nothing is configured', () => {
    expect(resolveReasoning('anthropic', caps(), undefined)).toBeUndefined();
  });

  it('omits it on the OpenAI path when disabled, rather than sending a negative', () => {
    // There is no "reasoning off" value for reasoning_effort; leaving the field
    // out is the only way to say it.
    expect(resolveReasoning('openai', caps(), { enabled: false })).toBeUndefined();
  });

  it('defaults the OpenAI effort to medium', () => {
    expect(resolveReasoning('openai', caps(), { enabled: true })).toEqual({ enabled: true, effort: 'medium' });
  });

  it('keeps an explicit OpenAI effort and carries no budget', () => {
    expect(resolveReasoning('openai', caps(), { enabled: true, effort: 'low', budgetTokens: 4_096 })).toEqual({
      enabled: true,
      effort: 'low',
    });
  });

  it('returns an explicit disable on the Anthropic path', () => {
    // Distinct from undefined: this sends thinking: {type: "disabled"}.
    expect(resolveReasoning('anthropic', caps(), { enabled: false })).toEqual({ enabled: false });
  });

  it('fills the budget from the effort ladder', () => {
    expect(resolveReasoning('anthropic', caps(), { enabled: true, effort: 'high' })).toEqual({
      enabled: true,
      effort: 'high',
      budgetTokens: EFFORT_BUDGETS.high,
    });
  });

  it('clamps a below-floor budget up to the minimum', () => {
    expect(resolveReasoning('anthropic', caps(), { enabled: true, effort: 'low', budgetTokens: 10 })).toMatchObject({
      budgetTokens: MIN_THINKING_BUDGET,
    });
  });

  it('floors a fractional budget from a slider', () => {
    expect(
      resolveReasoning('anthropic', caps(), { enabled: true, effort: 'low', budgetTokens: 4_096.7 }),
    ).toMatchObject({ budgetTokens: 4_096 });
  });
});

describe('composeSystem', () => {
  it('returns undefined when there is nothing to send', () => {
    expect(composeSystem(undefined, undefined)).toBeUndefined();
    expect(composeSystem('   ', '  ')).toBeUndefined();
  });

  it('passes a lone prompt through trimmed', () => {
    expect(composeSystem('  Be terse.  ', undefined)).toBe('Be terse.');
  });

  it('puts the summary after the prompt, under a heading', () => {
    // Order matters: a summary placed first reads as instructions that outrank
    // the ones the user actually wrote.
    const composed = composeSystem('Be terse.', 'The user is called Lyric.') as string;
    expect(composed.indexOf('Be terse.')).toBeLessThan(composed.indexOf('The user is called Lyric.'));
    expect(composed).toContain('# Summary of earlier conversation');
  });

  it('includes a summary with no prompt', () => {
    expect(composeSystem(undefined, 'Notes.')).toContain('Notes.');
  });
});

describe('buildRequest', () => {
  const base = {
    model: 'claude-opus-4-6',
    capabilities: caps(),
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  };

  it('omits system, reasoning, tools and hints when there is nothing to send', () => {
    const request = buildRequest({ ...base, transport: 'anthropic', config: {} });
    expect(Object.keys(request).sort()).toEqual(['messages', 'model', 'params']);
  });

  it('carries the model and messages through untouched', () => {
    const request = buildRequest({ ...base, transport: 'anthropic', config: {} });
    expect(request.model).toBe('claude-opus-4-6');
    expect(request.messages).toBe(base.messages);
  });

  it('applies stored params, then per-message overrides on top', () => {
    const request = buildRequest({
      ...base,
      transport: 'openai',
      config: { params: { temperature: 0.2, maxTokens: 1_000 } },
      paramOverrides: { maxTokens: 2_000 },
    });
    expect(request.params).toEqual({ maxTokens: 2_000, temperature: 0.2 });
  });

  it('resolves reasoning through the transport rules', () => {
    const request = buildRequest({
      ...base,
      transport: 'anthropic',
      config: { reasoning: { enabled: true, effort: 'low' } },
    });
    expect(request.reasoning).toEqual({ enabled: true, effort: 'low', budgetTokens: EFFORT_BUDGETS.low });
  });

  it('drops reasoning for a model not flagged reasoning-capable', () => {
    const request = buildRequest({
      ...base,
      capabilities: caps({ reasoning: false }),
      transport: 'anthropic',
      config: { reasoning: { enabled: true, effort: 'high' } },
    });
    expect(request.reasoning).toBeUndefined();
  });

  it('folds the summary into the system prompt', () => {
    const request = buildRequest({
      ...base,
      transport: 'anthropic',
      config: {},
      systemPrompt: 'Be terse.',
      summary: 'Earlier notes.',
    });
    expect(request.system).toContain('Be terse.');
    expect(request.system).toContain('Earlier notes.');
  });

  it('omits an empty tools array rather than sending one', () => {
    // An empty tools list is not the same as no tools, and some backends treat
    // the former as a schema error.
    const request = buildRequest({ ...base, transport: 'openai', config: {}, tools: [] });
    expect(request.tools).toBeUndefined();
  });

  it('passes wire hints through when present', () => {
    const request = buildRequest({
      ...base,
      transport: 'openai',
      config: {},
      wireHints: { maxTokensField: 'max_completion_tokens' },
    });
    expect(request.wireHints).toEqual({ maxTokensField: 'max_completion_tokens' });
  });

  it('produces a request that its own validator accepts', () => {
    const transports: TransportKind[] = ['anthropic', 'openai'];
    for (const transport of transports) {
      const request = buildRequest({ ...base, transport, config: {} });
      const issues = validateConfig({
        transport,
        capabilities: base.capabilities,
        params: request.params,
        ...(request.reasoning ? { reasoning: request.reasoning } : {}),
      });
      expect(hasBlockingIssue(issues)).toBe(false);
    }
  });

  it('produces a valid request at every effort level with thinking on', () => {
    // The defaults have to survive the whole ladder: an effort the user can pick
    // that then refuses to send would be a trap.
    const ladder: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    for (const effort of ladder) {
      const request = buildRequest({
        ...base,
        transport: 'anthropic',
        config: {
          reasoning: { enabled: true, effort },
          params: { maxTokens: EFFORT_BUDGETS[effort] + 8_192 },
        },
      });
      const issues = validateConfig({
        transport: 'anthropic',
        capabilities: caps({ maxOutputTokens: 200_000 }),
        params: request.params,
        ...(request.reasoning ? { reasoning: request.reasoning } : {}),
      });
      expect(errors(issues)).toEqual([]);
    }
  });
});
