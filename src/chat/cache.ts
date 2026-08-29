/**
 * Prompt caching: asking to be billed a tenth for the part of the request that
 * did not change.
 *
 * The gateway already reports `cache_read_input_tokens` and this app already
 * displays it — and until now it was always zero, because nothing ever asked for
 * a cache write. The Anthropic Messages API only caches what is explicitly marked
 * with `cache_control`, so a request without breakpoints re-pays full price for an
 * identical system prompt, an identical tool manifest and an identical history on
 * every single turn. In a long conversation that is the dominant cost by a wide
 * margin: the tail the user just typed is a few hundred tokens against tens of
 * thousands of prefix.
 *
 * The economics, and why the thresholds below are what they are: a cache *write*
 * costs 1.25× the normal input rate, a *read* costs 0.1×. So marking a prefix pays
 * for itself the first time it is re-read, and loses 25% of that prefix's cost if
 * it never is. That asymmetry decides everything here — mark the parts that are
 * *stable*, not the parts that are large.
 *
 * What is stable, in order of confidence:
 *
 *  1. **Tool definitions.** Identical every turn (see the ordering note in
 *     `@/chat/tools`), and first in the wire prefix, so a breakpoint here also
 *     covers nothing before it and is never invalidated by anything after.
 *  2. **The system prompt.** Changes when the user edits it, when memory is
 *     written, or when a rolling summary is regenerated — occasional, not per-turn.
 *  3. **History up to the last complete exchange.** Append-only by nature: turn
 *     N+1's prefix is turn N's prefix plus one exchange. The breakpoint deliberately
 *     goes *before* the newest messages, because marking the very end would write a
 *     new cache entry every turn and read one that is one exchange short.
 *
 * What is deliberately never marked: anything after a trim ran. `@/chat/trim`
 * rewrites history when the window is tight, and a rewritten prefix is a cache
 * miss by definition — writing it again would pay 1.25× for an entry the next turn
 * will also miss.
 *
 * Pure, and the plan is a set of positions rather than a mutated request, so the
 * adapter decides how to express it and the OpenAI path can ignore it entirely
 * (its caching is automatic and needs no markers).
 */

import type { ChatRequest, ToolDefinition, UnifiedMessage } from '@/transports/types';
import { estimateMessagesTokens, estimateTextTokens, estimateToolTokens } from '@/lib/tokens';

/**
 * Smallest prefix Anthropic will cache, in tokens.
 *
 * 1,024 for most Claude models and 2,048 for the small ones. Using the larger
 * figure everywhere costs a little missed caching on the models with the lower
 * floor and avoids the alternative — requesting a write below the minimum, which
 * is silently ignored and leaves us paying the 1.25× write premium for nothing.
 */
export const MIN_CACHEABLE_TOKENS = 2_048;

/**
 * The API accepts at most four `cache_control` breakpoints per request.
 *
 * Three are used at most: tools, system, history. The fourth is left unspent on
 * purpose — a future tool-loop turn needs one for the tool results it appends
 * mid-turn, and finding out that the budget is full at that point means changing
 * this module rather than adding a marker.
 */
export const MAX_BREAKPOINTS = 4;

export interface CachePlan {
  /** Mark the last tool definition, caching the whole manifest. */
  tools: boolean;
  /** Mark the system prompt. */
  system: boolean;
  /**
   * Index of the last message to include in the cached prefix, or `undefined` for
   * no history breakpoint. Inclusive.
   */
  historyThrough?: number;
  /** Estimated tokens the plan expects to be served from cache next turn. */
  cacheable: number;
  /** Why nothing was marked, when nothing was. Empty when something was. */
  reason: string;
}

export const NO_CACHE: CachePlan = { tools: false, system: false, cacheable: 0, reason: 'Caching is off.' };

export interface CachePlanInput {
  system?: string;
  messages: readonly UnifiedMessage[];
  tools?: readonly ToolDefinition[];
  /** False when the model is not flagged as supporting prompt caching. */
  supported?: boolean;
  /** False when the user has turned caching off in settings. */
  enabled?: boolean;
  /**
   * True when history was rewritten for this turn. Suppresses the history
   * breakpoint — see the module comment.
   */
  historyRewritten?: boolean;
  minCacheable?: number;
}

/**
 * How many trailing messages stay outside the cached prefix.
 *
 * Two: the user's newest message and the assistant reply that is about to be
 * generated. Marking through the end of history would mean every turn writes a
 * fresh entry (1.25×) and reads an entry missing the last exchange — paying the
 * write premium for a prefix that is stale on arrival.
 */
const TAIL_OUTSIDE_CACHE = 2;

/**
 * Where to put the breakpoints for this request.
 *
 * Returns {@link NO_CACHE} with a reason rather than an empty plan, because "no
 * cache reads are happening" is a question someone will ask of the usage screen
 * and the answer is worth being able to print.
 */
export function planCache(input: CachePlanInput): CachePlan {
  if (input.enabled === false) return NO_CACHE;
  if (input.supported === false) {
    return { ...NO_CACHE, reason: 'This model is not flagged as supporting prompt caching.' };
  }

  const min = input.minCacheable ?? MIN_CACHEABLE_TOKENS;
  const toolTokens = (input.tools ?? []).reduce((sum, tool) => sum + estimateToolTokens(tool), 0);
  const systemTokens = estimateTextTokens(input.system ?? '');

  // Breakpoints are cumulative over the prefix: a marker on the system prompt
  // caches tools *and* system, so what has to clear the minimum is the prefix up
  // to that point, not the section on its own. That is why `system` can be marked
  // for a short prompt sitting behind a large manifest.
  const tools = toolTokens >= min;
  const system = systemTokens > 0 && toolTokens + systemTokens >= min;

  let historyThrough: number | undefined;
  let historyTokens = 0;
  if (!input.historyRewritten) {
    const boundary = input.messages.length - TAIL_OUTSIDE_CACHE;
    if (boundary > 0) {
      const prefix = input.messages.slice(0, boundary);
      historyTokens = estimateMessagesTokens(prefix);
      if (toolTokens + systemTokens + historyTokens >= min) historyThrough = boundary - 1;
    }
  }

  const marks = Number(tools) + Number(system) + Number(historyThrough !== undefined);
  if (marks === 0) {
    return {
      ...NO_CACHE,
      reason:
        `Nothing to cache yet: the stable part of this request is under the ${min.toLocaleString()}-token ` +
        'minimum the API will store.',
    };
  }

  // Belt and braces. Three is the most this function can produce today, so this
  // can only fire if someone adds a fourth without reading the comment above.
  if (marks > MAX_BREAKPOINTS) return { ...NO_CACHE, reason: 'Too many cache breakpoints planned.' };

  const cacheable =
    (tools ? toolTokens : 0) + (system ? systemTokens : 0) + (historyThrough !== undefined ? historyTokens : 0);

  return { tools, system, ...(historyThrough !== undefined ? { historyThrough } : {}), cacheable, reason: '' };
}

/** Convenience: plan against an assembled request. */
export function planCacheForRequest(
  request: Pick<ChatRequest, 'system' | 'messages' | 'tools'>,
  options: Omit<CachePlanInput, 'system' | 'messages' | 'tools'> = {},
): CachePlan {
  return planCache({
    ...options,
    ...(request.system !== undefined ? { system: request.system } : {}),
    messages: request.messages,
    ...(request.tools ? { tools: request.tools } : {}),
  });
}

/**
 * What the usage screen says about caching for one turn.
 *
 * Reports the *measured* saving from `usage`, not the planned one. The plan is a
 * request; the gateway decides, and a New API-style gateway in front of Anthropic
 * may not honour `cache_control` at all — in which case the honest thing to show
 * is that we asked and got nothing, rather than a projected saving that never
 * happened.
 */
export function describeCacheOutcome(usage: { cacheRead?: number; cacheWrite?: number }, plan: CachePlan): string {
  const read = usage.cacheRead ?? 0;
  const write = usage.cacheWrite ?? 0;
  if (read > 0) {
    return `${read.toLocaleString()} tokens served from cache at a tenth of the input price.`;
  }
  if (write > 0) {
    return `${write.toLocaleString()} tokens written to the cache. The next turn in this conversation reads them back at a tenth of the price.`;
  }
  if (plan.reason) return plan.reason;
  return 'Caching was requested for this turn and the gateway reported none. It may not support prompt caching.';
}
