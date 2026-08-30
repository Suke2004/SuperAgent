/**
 * The turn budget: how much of the context window is left for history, and why.
 *
 * Every turn spends the same window on four things — the reply that hasn't been
 * written yet, the fixed prefix (system prompt, memory notes, rolling summary,
 * tool definitions), the conversation history, and a margin for the estimator
 * being an estimator. This module is the one place that arithmetic lives.
 *
 * It exists because it was previously in two places that disagreed. The chat
 * store computed a history budget from `contextWindow − maxTokens − thinking −
 * systemPrompt − 512`; the composer's gauge computed pressure from
 * `contextWindow − reserved`. Two consequences, both real:
 *
 *  1. **Thinking was double-counted.** `max_tokens` on the Anthropic path is the
 *     total output allowance *including* thinking — `validateConfig` refuses a
 *     request where the thinking budget is not below it. Reserving
 *     `maxTokens + budgetTokens` therefore reserved the thinking budget twice and
 *     silently threw away that many tokens of history on every reasoning turn.
 *     At effort `max` that is 128k tokens of window given away.
 *  2. **Memory and tools were not counted at all.** Both go into the request the
 *     budget is being computed for. A long memory block plus a talkative MCP
 *     server could push the assembled request over a window the planner had just
 *     declared roomy — the one failure mode trimming exists to prevent.
 *
 * The planner is pure and takes text rather than a request, so the composer can
 * ask "what would the next turn cost?" before a request exists.
 */

import type { ReasoningConfig, SamplingParams, ToolDefinition, TransportKind } from '@/transports/types';
import { estimateTextTokens, estimateToolTokens, formatTokens, REQUEST_OVERHEAD } from '@/lib/tokens';
import type { ContextPressure } from '@/lib/tokens';
import type { ContextStrategy } from '@/stores/settings';

/**
 * Slack held back from the history budget, in tokens.
 *
 * The estimator is documented at roughly ±12%, and it is wrong in both
 * directions. A margin that only covered the average error would still overflow
 * half the time, so this is a flat floor on top of the calibration multiplier
 * rather than a percentage: the percentage is what `calibration` already is.
 */
export const BUDGET_MARGIN = 512;

/** Never plan a history budget below this, however tight the window. */
export const MIN_HISTORY_BUDGET = 1_024;

export interface TurnBudgetInput {
  transport: TransportKind;
  /** The model's window, from the registry. */
  contextWindow: number;
  params: SamplingParams;
  reasoning?: ReasoningConfig;
  /** The composed system prompt — user prompt, memory and summary already joined. */
  system?: string;
  tools?: readonly ToolDefinition[];
  /**
   * Multiplier learned from this model's reported prompt counts. Applied to the
   * prefix estimate, because a model whose real counts run 15% above our estimate
   * runs 15% above them here too.
   */
  calibration?: number;
  margin?: number;
}

export interface PrefixCost {
  system: number;
  tools: number;
  framing: number;
  total: number;
}

export interface TurnBudget {
  window: number;
  /** Reserved for the reply, thinking included. */
  reply: number;
  prefix: PrefixCost;
  margin: number;
  /** Tokens available for conversation history. Never below {@link MIN_HISTORY_BUDGET}. */
  history: number;
  /** True when the fixed costs alone leave less than the floor. */
  tight: boolean;
}

/**
 * How much output allowance to hold back.
 *
 * On the Anthropic path this is `max_tokens` and nothing more, because thinking
 * is billed inside it. On the OpenAI path reasoning tokens are *also* output
 * tokens counted against `max_completion_tokens`, so the answer is the same — the
 * difference is only that the OpenAI schema exposes an effort level instead of a
 * number, so there is nothing to add even if we wanted to.
 *
 * Kept as a named function because the temptation to add the thinking budget
 * here is strong, has already been yielded to once, and costs history every time.
 */
export function replyReservation(params: SamplingParams, reasoning?: ReasoningConfig): number {
  const cap = Number.isFinite(params.maxTokens) ? Math.max(1, Math.floor(params.maxTokens)) : 1;
  // Not `cap + budget`. If a caller has somehow assembled a config where the
  // thinking budget exceeds the output cap, `validateConfig` blocks the send
  // before this matters — but planning against the larger of the two keeps the
  // budget honest rather than negative-by-implication.
  const thinking = reasoning?.enabled ? (reasoning.budgetTokens ?? 0) : 0;
  return Math.max(cap, thinking);
}

/** What the immovable parts of the request cost. */
export function prefixCost(input: TurnBudgetInput): PrefixCost {
  const factor = input.calibration && input.calibration > 0 ? input.calibration : 1;
  const system = Math.round(estimateTextTokens(input.system ?? '') * factor);
  let tools = 0;
  for (const tool of input.tools ?? []) tools += estimateToolTokens(tool);
  tools = Math.round(tools * factor);
  return { system, tools, framing: REQUEST_OVERHEAD, total: system + tools + REQUEST_OVERHEAD };
}

/**
 * The whole envelope for one turn.
 *
 * `tight` is the interesting output. When the prefix and the reply allowance
 * together leave less than {@link MIN_HISTORY_BUDGET}, the returned `history` is
 * that floor rather than the real remainder — the request will be over the window
 * and the gateway will say so. That is deliberate: silently trimming the
 * conversation to nothing to fit a 40k-token tool manifest would hide the actual
 * problem, which is the manifest. The flag is what the UI needs to say *which*
 * fixed cost to cut.
 */
export function planTurn(input: TurnBudgetInput): TurnBudget {
  const margin = input.margin ?? BUDGET_MARGIN;
  const reply = replyReservation(input.params, input.reasoning);
  const prefix = prefixCost(input);
  const remainder = input.contextWindow - reply - prefix.total - margin;
  return {
    window: input.contextWindow,
    reply,
    prefix,
    margin,
    history: Math.max(MIN_HISTORY_BUDGET, remainder),
    tight: remainder < MIN_HISTORY_BUDGET,
  };
}

/**
 * A sentence naming the largest fixed cost, for a tight budget.
 *
 * Only ever says one thing. "Your system prompt, memory notes and 34 tools are
 * using most of the window" is a list nobody acts on; naming the biggest one is
 * a instruction.
 */
export function describeTightBudget(budget: TurnBudget, toolCount = 0): string {
  const { prefix, reply, window } = budget;
  const parts = [
    `The fixed parts of this request use ${prefix.total.toLocaleString()} tokens of a ` +
      `${window.toLocaleString()}-token window, and ${reply.toLocaleString()} more are held back for the reply.`,
  ];
  if (prefix.tools > prefix.system && toolCount > 0) {
    parts.push(
      `${toolCount} tool definition${toolCount === 1 ? '' : 's'} account for ` +
        `${prefix.tools.toLocaleString()} of it — turning some off is the cheapest thing to change.`,
    );
  } else if (prefix.system > 0) {
    parts.push(
      `The system prompt and memory notes account for ${prefix.system.toLocaleString()} of it. Shortening the ` +
        'prompt, or trimming memory in Settings → Memory, buys back room for history.',
    );
  }
  parts.push('Lowering max output tokens also helps, since that allowance is reserved whether or not it is used.');
  return parts.join(' ');
}

/**
 * The one confirmation a send over the usable window owes the user, or `null`.
 *
 * Only for the `warn` strategy, and only at `over`. `warn` is the strategy that
 * *doesn't* trim, so a send from here goes out whole and the gateway either
 * rejects it or truncates the reply — a refusal the user can neither predict from
 * a green gauge nor undo afterwards. The other two strategies trim silently by
 * design and say what they did afterwards, and `critical` deliberately gets a
 * sentence rather than a dialog: a modal on every send at 85% is a modal people
 * learn to dismiss without reading, which is worse than none.
 *
 * Blocking the send is not an option on the table. The estimator is ±12% and the
 * window figure is a hand-edited registry entry, so a hard stop here would refuse
 * requests that would have worked.
 */
export function sendConfirmation(
  pressure: ContextPressure,
  strategy: ContextStrategy,
): { title: string; body: string } | null {
  if (strategy !== 'warn' || pressure.level !== 'over') return null;
  const over = Math.max(1, pressure.used - Math.max(1, pressure.window - pressure.reserved));
  return {
    title: 'Over the context window',
    body:
      `This request is about ${formatTokens(over)} tokens more than the model can take once ` +
      `${formatTokens(pressure.reserved)} are held back for the reply. It may be rejected, or answered and cut ` +
      'short. Exclude some messages, lower max output tokens, or switch this conversation to dropping or ' +
      'summarising older turns in Settings.',
  };
}
