/**
 * Getting a conversation under budget by degrees, cheapest loss first.
 *
 * The old behaviour had one lever: drop whole turns from the oldest end. That is
 * the most destructive thing available, and it was reached immediately — a
 * conversation one token over budget lost an entire exchange.
 *
 * There are two much cheaper things to give up first, and both are large:
 *
 *  1. **Replayed reasoning.** Thinking blocks are billed as input every turn they
 *     are sent, and they are the largest blocks in a reasoning conversation — a
 *     `max`-effort turn can carry 100k tokens of thinking. Their value to the next
 *     turn is close to zero: the model's own conclusions are in the visible reply
 *     underneath them. Dropping all but the most recent reasoning is the single
 *     biggest win available and loses nothing the user can see.
 *  2. **Long tool results.** A directory listing or an HTTP body pasted into a
 *     `tool_result` is mostly padding by the third turn. Truncating the middle and
 *     keeping both ends preserves what the model actually refers back to (the
 *     shape at the start, the conclusion at the end) at a fraction of the cost.
 *
 * Only then are whole turns dropped. Each step runs only if the conversation is
 * still over budget after the previous one, so a conversation that fits is
 * returned untouched — which matters for more than purity: an unmodified prefix
 * is a cacheable prefix (see `@/chat/cache`), and rewriting history to save 200
 * tokens can cost the entire cache read.
 *
 * Everything here is pure. Indices in the report refer to the *input* array, so
 * the caller can still mark the right stored rows as excluded.
 */

import type { ContentBlock, ToolResultBlock, UnifiedMessage } from '@/transports/types';
import { estimateMessagesTokens, selectMessagesWithinBudget } from '@/lib/tokens';

/** Characters kept per tool result before the middle is elided. */
export const TOOL_RESULT_CAP = 2_000;

/** Below this there is no point truncating: the marker would be a third of it. */
const MIN_TRUNCATABLE = 400;

export type TrimStep = 'strip_thinking' | 'truncate_tool_results' | 'drop_turns';

export interface TrimAction {
  step: TrimStep;
  /** Estimated tokens saved by this step. */
  saved: number;
  /** How many blocks or messages the step touched. */
  count: number;
}

export interface TrimOptions {
  /** Characters a tool result may keep. Defaults to {@link TOOL_RESULT_CAP}. */
  toolResultCap?: number;
  /**
   * How many trailing messages keep their thinking blocks. Default 1 — the
   * assistant turn currently being followed up on.
   */
  keepThinkingInLast?: number;
}

export interface TrimReport {
  /** The messages to send, in order. */
  messages: UnifiedMessage[];
  before: number;
  after: number;
  actions: TrimAction[];
  /** Indices into the input array that survived, ascending. */
  keep: number[];
  /** Indices into the input array that were dropped whole, ascending. */
  dropped: number[];
}

/**
 * Whether a message's thinking may be dropped.
 *
 * An assistant turn containing a `tool_use` keeps its thinking. The Anthropic API
 * requires the thinking block that preceded a tool call to be replayed with its
 * signature intact when the tool result comes back; dropping it produces a 400
 * rather than a smaller request. Cheap to respect, and the alternative is a
 * failure that only shows up once tools are on.
 */
function thinkingIsLoadBearing(message: UnifiedMessage): boolean {
  return message.content.some((block) => block.type === 'tool_use');
}

function withoutThinking(content: readonly ContentBlock[]): ContentBlock[] {
  return content.filter((block) => block.type !== 'thinking');
}

/**
 * Middle-out truncation with an honest marker.
 *
 * Head and tail rather than head alone because the two ends carry different
 * information — a listing's columns are at the top, an error is at the bottom —
 * and because a result cut off mid-way reads to the model as complete. The marker
 * says how much is missing so it can ask for the rest.
 */
export function truncateMiddle(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const elided = text.length - cap;
  const marker = `\n\n… ${elided.toLocaleString()} characters elided to fit the context window …\n\n`;
  // The marker is part of the budget, so a cap is a cap. Split what's left of it
  // two-thirds to the head: the beginning of a result is referred back to more.
  const room = Math.max(0, cap - marker.length);
  const head = Math.ceil(room * 0.66);
  const tail = room - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : '');
}

function truncatedResult(block: ToolResultBlock, cap: number): ToolResultBlock {
  return { ...block, content: truncateMiddle(block.content, cap) };
}

/**
 * Runs the ladder until the messages fit, or until there is nothing left to give.
 *
 * The steps are applied to a working copy in order; `actions` records only the
 * steps that actually ran and what each one bought, which is what the transcript
 * banner reports. A step that saves nothing is not recorded.
 */
export function trimToBudget(
  messages: readonly UnifiedMessage[],
  budget: number,
  options: TrimOptions = {},
): TrimReport {
  const cap = options.toolResultCap ?? TOOL_RESULT_CAP;
  const keepThinkingInLast = options.keepThinkingInLast ?? 1;
  const before = estimateMessagesTokens(messages);
  const actions: TrimAction[] = [];

  const allIndices = messages.map((_, index) => index);
  if (before <= budget) {
    return { messages: [...messages], before, after: before, actions, keep: allIndices, dropped: [] };
  }

  // Step 1 — replayed reasoning, everywhere but the tail.
  let working: UnifiedMessage[] = [...messages];
  const protectedFrom = Math.max(0, working.length - keepThinkingInLast);
  let strippedBlocks = 0;
  working = working.map((message, index) => {
    if (index >= protectedFrom || thinkingIsLoadBearing(message)) return message;
    const kept = withoutThinking(message.content);
    if (kept.length === message.content.length) return message;
    // A message whose only content was thinking would become empty, and an empty
    // content array is rejected on the Anthropic path. Leave it alone; the
    // drop-turns step can remove it whole if the budget still needs the room.
    if (kept.length === 0) return message;
    strippedBlocks += message.content.length - kept.length;
    return { role: message.role, content: kept };
  });
  if (strippedBlocks > 0) {
    const now = estimateMessagesTokens(working);
    const saved = before - now;
    if (saved > 0) actions.push({ step: 'strip_thinking', saved, count: strippedBlocks });
  }

  // Step 2 — long tool results. Every result over the cap, not just enough of
  // them to fit: truncating some and not others by position would make the same
  // result look different depending on when it was sent, and the cap is where the
  // value stops rather than a knob to tune per turn.
  if (estimateMessagesTokens(working) > budget) {
    const beforeStep = estimateMessagesTokens(working);
    let truncatedBlocks = 0;
    working = working.map((message) => {
      let changed = false;
      const content = message.content.map((block) => {
        if (block.type !== 'tool_result') return block;
        if (block.content.length <= Math.max(cap, MIN_TRUNCATABLE)) return block;
        changed = true;
        truncatedBlocks += 1;
        return truncatedResult(block, cap);
      });
      return changed ? { role: message.role, content } : message;
    });
    const saved = beforeStep - estimateMessagesTokens(working);
    if (truncatedBlocks > 0 && saved > 0) {
      actions.push({ step: 'truncate_tool_results', saved, count: truncatedBlocks });
    }
  }

  // Step 3 — whole turns, oldest first. Unchanged behaviour, reached last.
  // Steps 1 and 2 preserve length and order, so an index into `working` is still
  // an index into the caller's array, which is what makes `keep` and `dropped`
  // usable for marking stored rows excluded.
  let keep = allIndices;
  let dropped: number[] = [];
  if (estimateMessagesTokens(working) > budget) {
    const beforeStep = estimateMessagesTokens(working);
    const selection = selectMessagesWithinBudget(working, budget);
    keep = selection.keep;
    dropped = selection.dropped;
    working = keep.map((index) => working[index]).filter((m): m is UnifiedMessage => Boolean(m));
    const saved = beforeStep - estimateMessagesTokens(working);
    if (dropped.length > 0 && saved > 0) {
      actions.push({ step: 'drop_turns', saved, count: dropped.length });
    }
  }

  return { messages: working, before, after: estimateMessagesTokens(working), actions, keep, dropped };
}

/**
 * One sentence for the transcript, or `''` when nothing was trimmed.
 *
 * Named in terms of what was lost rather than what was saved, because "saved 40k
 * tokens" invites approval and "reasoning from earlier turns is no longer being
 * sent" invites a decision.
 */
export function describeTrim(report: TrimReport): string {
  if (!report.actions.length) return '';
  const parts: string[] = [];
  for (const action of report.actions) {
    switch (action.step) {
      case 'strip_thinking':
        parts.push('reasoning from earlier turns is no longer sent');
        break;
      case 'truncate_tool_results':
        parts.push(
          `${action.count} long tool result${action.count === 1 ? ' was' : 's were'} shortened in the middle`,
        );
        break;
      case 'drop_turns':
        parts.push(`${action.count} earlier message${action.count === 1 ? '' : 's'} left out entirely`);
        break;
    }
  }
  const saved = report.before - report.after;
  return `To fit the context window: ${parts.join('; ')}. About ${saved.toLocaleString()} tokens of input saved.`;
}
