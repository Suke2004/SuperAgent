/**
 * Anthropic-request validation.
 *
 * Two constraints the spec asks to catch here rather than let the API reject:
 *
 *  1. On current Claude models, thinking can only be *disabled* at effort `high`
 *     or below. Disabling it at `xhigh` or `max` is a 400, so it's an error.
 *  2. `max_tokens` caps total output *including* thinking tokens, so a small
 *     `max_tokens` alongside a large thinking budget starves the visible answer.
 *     That's legal and it works — it just wastes the request — so it's a warning.
 *
 * Errors block the request. Warnings are returned for the UI to show live while
 * the user drags the sliders, which is the only moment they're actually useful.
 */

import type { ChatRequest, ReasoningConfig, ReasoningEffort } from './types';

/** Anthropic's floor for `thinking.budget_tokens`. */
export const MIN_THINKING_BUDGET = 1024;

/** Headroom we insist on leaving for the visible answer, in tokens. */
export const MIN_ANSWER_HEADROOM = 1024;

/** Efforts at which thinking cannot be turned off. */
export const NO_DISABLE_EFFORTS: readonly ReasoningEffort[] = ['xhigh', 'max'] as const;

/**
 * Effort → thinking budget.
 *
 * The Anthropic wire API takes `budget_tokens`, not an effort name, so the ladder
 * is mapped here. These are this app's choices, not values the API blesses; the
 * budget slider overrides them whenever it's set explicitly.
 */
export const EFFORT_BUDGETS: Record<ReasoningEffort, number> = {
  minimal: MIN_THINKING_BUDGET,
  low: 4_096,
  medium: 8_192,
  high: 16_384,
  xhigh: 32_768,
  max: 60_000,
};

export interface ValidationIssue {
  /** Which control the issue is about, so the UI can attach it to that field. */
  field: 'reasoning.enabled' | 'reasoning.effort' | 'reasoning.budgetTokens' | 'params.maxTokens';
  message: string;
}

export interface ValidationReport {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function isThinkingDisableBlocked(reasoning: ReasoningConfig | undefined): boolean {
  if (!reasoning || reasoning.enabled) return false;
  return reasoning.effort !== undefined && NO_DISABLE_EFFORTS.includes(reasoning.effort);
}

/**
 * Resolve the budget actually sent, clamping it to fit inside `max_tokens`.
 *
 * Returns null when thinking is off. The clamp is deliberate: sending a budget
 * larger than `max_tokens` is a hard 400, and silently failing is worse than
 * quietly shrinking the budget and warning about it.
 */
export function resolveThinkingBudget(
  reasoning: ReasoningConfig | undefined,
  maxTokens: number,
): number | null {
  if (!reasoning?.enabled) return null;
  const requested =
    reasoning.budgetTokens ?? (reasoning.effort ? EFFORT_BUDGETS[reasoning.effort] : EFFORT_BUDGETS.medium);
  const ceiling = maxTokens - MIN_ANSWER_HEADROOM;
  if (ceiling < MIN_THINKING_BUDGET) return MIN_THINKING_BUDGET;
  return Math.max(MIN_THINKING_BUDGET, Math.min(requested, ceiling));
}

export function validateAnthropicRequest(request: ChatRequest): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const { reasoning } = request;
  const maxTokens = request.params.maxTokens;

  if (isThinkingDisableBlocked(reasoning)) {
    errors.push({
      field: 'reasoning.enabled',
      message:
        `Thinking cannot be disabled at effort "${reasoning?.effort}". Current Claude models only accept ` +
        `thinking: disabled at effort "high" or below — sending it at "xhigh" or "max" is a 400. ` +
        `Either enable thinking or drop the effort to "high".`,
    });
  }

  if (maxTokens < MIN_THINKING_BUDGET + MIN_ANSWER_HEADROOM && reasoning?.enabled) {
    errors.push({
      field: 'params.maxTokens',
      message:
        `max_tokens is ${maxTokens}, but thinking needs at least ${MIN_THINKING_BUDGET} tokens and the answer ` +
        `needs room after that. Raise max_tokens to at least ${MIN_THINKING_BUDGET + MIN_ANSWER_HEADROOM}, ` +
        `or turn thinking off.`,
    });
  }

  if (reasoning?.enabled) {
    const requested = reasoning.budgetTokens ?? (reasoning.effort ? EFFORT_BUDGETS[reasoning.effort] : undefined);
    const resolved = resolveThinkingBudget(reasoning, maxTokens);

    if (requested !== undefined && resolved !== null && resolved < requested) {
      warnings.push({
        field: 'reasoning.budgetTokens',
        message:
          `Thinking budget trimmed from ${requested} to ${resolved} so the answer has ${MIN_ANSWER_HEADROOM} ` +
          `tokens left. max_tokens caps total output including thinking, so raise max_tokens to spend the ` +
          `full budget.`,
      });
    }

    if (resolved !== null) {
      const headroom = maxTokens - resolved;
      if (headroom < 2_048 && headroom >= MIN_ANSWER_HEADROOM) {
        warnings.push({
          field: 'params.maxTokens',
          message:
            `Only ${headroom} tokens are left for the visible answer after a ${resolved}-token thinking budget. ` +
            `Expect a truncated reply — max_tokens is the cap on thinking plus answer together, not just answer.`,
        });
      }
    }
  }

  if (reasoning?.enabled && request.params.temperature !== undefined && request.params.temperature !== 1) {
    warnings.push({
      field: 'reasoning.enabled',
      message:
        `Extended thinking requires temperature 1 on Claude models; ${request.params.temperature} will likely be ` +
        `rejected or ignored. The adapter omits temperature when thinking is on.`,
    });
  }

  return { errors, warnings };
}
