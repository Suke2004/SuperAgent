/**
 * Token estimation and cost arithmetic.
 *
 * This is an *estimator*, deliberately. A real BPE tokenizer means shipping a
 * megabyte-plus vocabulary and running it on every keystroke; both transports
 * report exact counts in the response anyway. So the rule this file follows is:
 *
 *   - estimates drive the live composer counter and the context-pressure bar,
 *     where being 10% out changes nothing;
 *   - the numbers shown *per message* after a reply come from `usage` on the
 *     response and are never computed here.
 *
 * Anything that displays an estimate should say so, which is why
 * {@link formatTokens} exists alongside a separate `~` prefix at the call site
 * rather than being baked into the number.
 *
 * Accuracy: within roughly ±12% on English prose and code against cl100k/o200k
 * for inputs over a few hundred characters. Short strings are noisier because a
 * single long word can swing the count by a whole token.
 */

import type { ChatRequest, ContentBlock, TokenUsage, UnifiedMessage } from '@/transports/types';

/**
 * Characters per token for scripts written with an alphabet.
 *
 * 4.0 is the usual quoted figure for English prose. Slightly lower here because
 * this app's traffic skews to code and markdown, where punctuation density
 * pushes the real ratio down — under-counting the budget is the safer error.
 */
const CHARS_PER_TOKEN = 3.8;

/**
 * Tokens per character for CJK and other ideographic scripts, where a single
 * character carries a whole morpheme and BPE merges far less.
 */
const CJK_TOKENS_PER_CHAR = 0.9;

/**
 * Per-message framing: role markers and delimiters that both wire formats add
 * around every message. Small, but a 200-turn conversation is 800 tokens of it.
 */
const MESSAGE_OVERHEAD = 4;

/** Framing around the whole request: system prompt wrapper, BOS, and similar. */
const REQUEST_OVERHEAD = 8;

/**
 * Flat estimate for an image whose dimensions aren't known here.
 *
 * Anthropic's own rule is `(width × height) / 750`. The composer resizes to a
 * 1568px long edge before upload (Phase 3), which lands a typical 4:3 photo
 * around 1568×1176 → ~2.5k tokens. Use that rather than something optimistic:
 * a surprise on a metered connection is worse than a pessimistic bar.
 */
const IMAGE_TOKENS = 2_500;

/** Per-tool-definition overhead: name, description and JSON Schema all cost. */
const TOOL_DEFINITION_OVERHEAD = 12;

const CJK_PATTERN =
  /[ᄀ-ᇿ⺀-⻿　-〿぀-ヿ㄰-㆏㐀-䶿一-鿿ꥠ-꥿가-힯豈-﫿＀-ﾟ]/;

/** True for the surrogate-pair range covering CJK Extension B and beyond. */
function isSupplementaryCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x20000 && codePoint <= 0x3ffff) || // CJK Extension B–G
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) // Emoji and pictographs
  );
}

export interface TextTokenBreakdown {
  cjkChars: number;
  otherChars: number;
  tokens: number;
}

/**
 * Splits a string by script and weights each part separately.
 *
 * A single ratio can't cover both, and this app's gateway explicitly accepts
 * Chinese and Russian alongside English — a Chinese conversation estimated at
 * 4 chars/token would report a quarter of its real size and let the user sail
 * past the context window with the bar showing green.
 */
export function breakdownText(text: string): TextTokenBreakdown {
  let cjkChars = 0;
  let otherChars = 0;

  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (CJK_PATTERN.test(char) || isSupplementaryCjk(codePoint)) cjkChars += 1;
    else otherChars += 1;
  }

  const tokens = cjkChars * CJK_TOKENS_PER_CHAR + otherChars / CHARS_PER_TOKEN;
  return { cjkChars, otherChars, tokens: Math.ceil(tokens) };
}

/** Estimated tokens for a plain string. Returns 0 for the empty string. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return breakdownText(text).tokens;
}

/**
 * Estimated tokens for one content block.
 *
 * Thinking blocks count: replayed to the Anthropic API in later turns, they are
 * charged as input like anything else. Tool results count as their text.
 */
export function estimateBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text);
    case 'thinking':
      // The signature is an opaque blob that still occupies the request body.
      return estimateTextTokens(block.text) + (block.signature ? 8 : 0) + (block.redacted ? 32 : 0);
    case 'image':
      return IMAGE_TOKENS;
    case 'document':
      // Extracted text is exact-ish; a native document block is billed on the
      // server side after its own extraction, so base64 length is the only
      // signal available. Roughly 3 base64 chars per byte of source text.
      if (block.text !== undefined) return estimateTextTokens(block.text);
      return block.data ? Math.ceil(block.data.length / 3 / CHARS_PER_TOKEN) : 0;
    case 'tool_use':
      return estimateTextTokens(block.name) + estimateTextTokens(safeJson(block.input)) + 8;
    case 'tool_result':
      return estimateTextTokens(block.content) + 8;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Estimated tokens for one message, including its role framing. */
export function estimateMessageTokens(message: UnifiedMessage): number {
  let total = MESSAGE_OVERHEAD;
  for (const block of message.content) total += estimateBlockTokens(block);
  return total;
}

/** Estimated tokens for a list of messages. */
export function estimateMessagesTokens(messages: readonly UnifiedMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

export interface RequestEstimate {
  system: number;
  messages: number;
  tools: number;
  /** System + messages + tools + framing. What the gateway will bill as input. */
  total: number;
}

/**
 * Estimated input tokens for a whole request.
 *
 * Counts tool definitions, which is easy to forget and can dominate: a chatty
 * MCP server with forty tools costs more in schemas than the conversation does
 * in text. That is exactly why Phase 5 has per-tool enable/disable.
 */
export function estimateRequestTokens(request: Pick<ChatRequest, 'system' | 'messages' | 'tools'>): RequestEstimate {
  const system = request.system ? estimateTextTokens(request.system) : 0;
  const messages = estimateMessagesTokens(request.messages);
  let tools = 0;
  for (const tool of request.tools ?? []) {
    tools +=
      TOOL_DEFINITION_OVERHEAD +
      estimateTextTokens(tool.name) +
      estimateTextTokens(tool.description) +
      estimateTextTokens(safeJson(tool.inputSchema));
  }
  return { system, messages, tools, total: system + messages + tools + REQUEST_OVERHEAD };
}

/* -------------------------------------------------------------------------- */
/* Context window pressure                                                     */
/* -------------------------------------------------------------------------- */

export type PressureLevel = 'ok' | 'warn' | 'critical' | 'over';

export interface ContextPressure {
  /** Estimated input tokens the next request will carry. */
  used: number;
  /** The model's context window, from the registry. */
  window: number;
  /**
   * Tokens reserved for the reply. Subtracted from the window before the ratio
   * is taken: a conversation that fits but leaves no room to answer is full.
   */
  reserved: number;
  /** `used / (window - reserved)`, clamped at 0 but deliberately not at 1. */
  ratio: number;
  level: PressureLevel;
  /** Room left for input before the reply allowance is eaten into. */
  remaining: number;
}

/**
 * Where the conversation sits against the model's window.
 *
 * `reserved` is what makes this useful rather than decorative. The failure the
 * user actually hits is not "request too large" — the gateway rejects that
 * clearly — it's a reply truncated at three words because the prompt left
 * `max_tokens` worth of nothing. So the ratio is against usable space.
 */
export function contextPressure(
  used: number,
  window: number,
  reserved: number,
  warnAt: number,
): ContextPressure {
  const usable = Math.max(1, window - reserved);
  const ratio = Math.max(0, used / usable);
  const criticalAt = Math.min(0.97, (warnAt + 1) / 2);

  let level: PressureLevel;
  if (ratio >= 1) level = 'over';
  else if (ratio >= criticalAt) level = 'critical';
  else if (ratio >= warnAt) level = 'warn';
  else level = 'ok';

  return { used, window, reserved, ratio, level, remaining: Math.max(0, usable - used) };
}

/**
 * Picks the messages to send when the window is tight, oldest-first.
 *
 * Returns indices to *keep*, not a filtered array, so the transcript can mark
 * the excluded turns rather than silently sending less than the user sees. That
 * distinction was the point of making the strategy configurable at all.
 *
 * Whole turns are dropped in pairs where possible: sending an assistant reply
 * without the user message that prompted it reads as the model talking to
 * itself, and on the Anthropic path a leading assistant message is rejected.
 */
export function selectMessagesWithinBudget(
  messages: readonly UnifiedMessage[],
  budget: number,
): { keep: number[]; dropped: number[]; tokens: number } {
  const costs = messages.map(estimateMessageTokens);
  const keep: number[] = [];
  let total = 0;

  // Newest-first so the most recent turn always survives, even if it alone
  // exceeds the budget — dropping the message being answered is never right.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = costs[i] ?? 0;
    if (keep.length > 0 && total + cost > budget) break;
    keep.push(i);
    total += cost;
  }

  keep.reverse();

  // A kept run that starts on an assistant message is invalid on the Anthropic
  // path and confusing on both. Drop the orphan rather than repair it.
  while (keep.length > 1 && messages[keep[0] as number]?.role === 'assistant') {
    total -= costs[keep[0] as number] ?? 0;
    keep.shift();
  }

  const kept = new Set(keep);
  const dropped: number[] = [];
  for (let i = 0; i < messages.length; i += 1) if (!kept.has(i)) dropped.push(i);

  return { keep, dropped, tokens: total };
}

/* -------------------------------------------------------------------------- */
/* Cost                                                                        */
/* -------------------------------------------------------------------------- */

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  total: number;
}

/**
 * Cost for a usage record, or `null` when pricing is unknown.
 *
 * `null` rather than 0 on purpose: the registry leaves pricing blank by default
 * and a free-tier gateway may genuinely bill nothing, so "0.00" and "we don't
 * know" have to be distinguishable in the dashboard.
 *
 * Cached reads are billed at a discount by both upstream vendors, but a New API
 * gateway's own markup is unknowable from here, so they're charged at the input
 * rate. Thinking tokens are output tokens and are already inside `output` on
 * both paths — adding them again would double-count.
 */
export function estimateCost(usage: Partial<TokenUsage>, pricing?: ModelPricing): CostBreakdown | null {
  if (!pricing) return null;
  const inputTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const outputTokens = usage.output ?? 0;
  const input = (inputTokens / 1_000_000) * pricing.inputPerMTok;
  const output = (outputTokens / 1_000_000) * pricing.outputPerMTok;
  return { input, output, total: input + output };
}

/** Formats a cost with enough precision to be meaningful at per-message scale. */
export function formatCost(amount: number): string {
  if (amount === 0) return '0';
  if (amount < 0.0001) return '<0.0001';
  if (amount < 1) return amount.toFixed(4);
  return amount.toFixed(2);
}

/** Compact token count: `812`, `4.2k`, `1.31M`. */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(Math.round(count));
  if (count < 100_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/** `1.2k in · 830 out · 4.1k cached` — omits parts the provider didn't report. */
export function formatUsage(usage: Partial<TokenUsage>): string {
  const parts: string[] = [];
  if (usage.input !== undefined) parts.push(`${formatTokens(usage.input)} in`);
  if (usage.output !== undefined) parts.push(`${formatTokens(usage.output)} out`);
  if (usage.thinking !== undefined) parts.push(`${formatTokens(usage.thinking)} thinking`);
  if (usage.cacheRead) parts.push(`${formatTokens(usage.cacheRead)} cache read`);
  if (usage.cacheWrite) parts.push(`${formatTokens(usage.cacheWrite)} cache write`);
  return parts.join(' · ');
}
