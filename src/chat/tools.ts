/**
 * Tool definitions, and what they cost to offer.
 *
 * A tool manifest is the most expensive thing in a request that nobody looks at.
 * It is sent in full on every turn, whether or not the model calls anything, and
 * an MCP server with forty tools will happily contribute 8–15k tokens of JSON
 * Schema to a conversation that is 2k tokens of text. On the Anthropic path that
 * is also *the* thing worth caching, which makes its stability as important as its
 * size (see `@/chat/cache`).
 *
 * Two levers, in the order they should be pulled:
 *
 *  1. **Slim each definition.** JSON Schema written for a validator carries a lot
 *     that a model does not read: `$schema`, `$id`, `title`, `examples`,
 *     `$comment`, and descriptions with three paragraphs of prose where one
 *     sentence decides the call. Removing them changes nothing about what the
 *     model may send — the constraints are still there — and routinely takes 30–50%
 *     off a verbose manifest.
 *  2. **Offer fewer.** When slimming is not enough, tools are dropped by priority
 *     and the model is *told* they were withheld, because a model that silently
 *     cannot see a tool invents a workaround and reports success.
 *
 * The order tools are emitted in is deliberately *not* the priority order. See
 * {@link selectTools}.
 */

import type { ToolDefinition } from '@/transports/types';
import { estimateToolTokens } from '@/lib/tokens';

/** Schema keys a model does not read and a validator will not miss on the wire. */
const DECORATIVE_SCHEMA_KEYS = new Set(['$schema', '$id', '$comment', 'title', 'examples', 'deprecated', 'readOnly', 'writeOnly']);

/** Characters a tool description may keep before it is cut at a sentence. */
export const DESCRIPTION_CAP = 320;

/** Characters a *property* description may keep. Tighter: there are many of them. */
export const PROPERTY_DESCRIPTION_CAP = 160;

export interface SlimOptions {
  descriptionCap?: number;
  propertyDescriptionCap?: number;
  /** When false, only the decorative keys go and prose is left alone. */
  trimDescriptions?: boolean;
}

/**
 * Truncates at the last sentence boundary inside the cap, or at a word boundary
 * if there is no sentence end.
 *
 * Cutting mid-sentence produces a description that reads as a statement the author
 * did not make — "Deletes the record and" — which is worse than a shorter true
 * one. The ellipsis is kept so the model can tell it was cut.
 */
export function clampProse(text: string, cap: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= cap) return collapsed;
  const window = collapsed.slice(0, cap);
  const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (sentence > cap * 0.4) return window.slice(0, sentence + 1);
  const word = window.lastIndexOf(' ');
  return `${(word > cap * 0.4 ? window.slice(0, word) : window).trimEnd()}…`;
}

/**
 * Strips decoration from a JSON Schema and clamps its prose.
 *
 * Recursive over objects and arrays, and it does not touch anything semantic —
 * `type`, `enum`, `required`, `properties`, `items`, `anyOf`, formats and numeric
 * bounds all survive verbatim, because they are the difference between a tool the
 * model can call correctly and one it guesses at.
 */
export function slimSchema(value: unknown, options: SlimOptions = {}): unknown {
  const cap = options.propertyDescriptionCap ?? PROPERTY_DESCRIPTION_CAP;
  const trimProse = options.trimDescriptions !== false;

  if (Array.isArray(value)) return value.map((item) => slimSchema(item, options));
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (DECORATIVE_SCHEMA_KEYS.has(key)) continue;
    if (key === 'description' && typeof child === 'string') {
      if (!trimProse) {
        out[key] = child;
        continue;
      }
      const clamped = clampProse(child, cap);
      // A description that clamped to nothing is worse than none at all.
      if (clamped) out[key] = clamped;
      continue;
    }
    out[key] = slimSchema(child, options);
  }
  return out;
}

/** One definition, slimmed. Pure; the input is never mutated. */
export function slimTool(tool: ToolDefinition, options: SlimOptions = {}): ToolDefinition {
  const cap = options.descriptionCap ?? DESCRIPTION_CAP;
  const description =
    options.trimDescriptions === false ? tool.description : clampProse(tool.description, cap);
  const schema = slimSchema(tool.inputSchema, options) as Record<string, unknown>;
  return { name: tool.name, description, inputSchema: schema };
}

export interface ToolCost {
  name: string;
  tokens: number;
}

/** Per-tool cost, most expensive first. What a "which tools are costing me?" screen shows. */
export function toolCosts(tools: readonly ToolDefinition[]): ToolCost[] {
  return tools
    .map((tool) => ({ name: tool.name, tokens: estimateToolTokens(tool) }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
}

export interface SelectToolsInput {
  tools: readonly ToolDefinition[];
  /** Token ceiling for the whole manifest. */
  budget: number;
  /** Names that are kept whatever the budget says — the user pinned them. */
  required?: readonly string[];
  /**
   * Names in most-recently-used order. Recency is the only usage signal available
   * on device, and it is a good one: a tool called two turns ago is far more
   * likely to be called again than one that has never been called.
   */
  recent?: readonly string[];
  slim?: SlimOptions | false;
}

export interface ToolSelection {
  /** The manifest to send, in the input's order. */
  tools: ToolDefinition[];
  /** Names left out, alphabetically. */
  withheld: string[];
  tokens: number;
  /** What slimming alone saved, before anything was withheld. */
  slimmed: number;
}

/**
 * Picks a manifest that fits.
 *
 * Priority for *inclusion* is: required first, then most-recently-used, then the
 * input order. Cost breaks no ties — dropping a cheap tool the user just called in
 * favour of an expensive one they have never touched is the wrong trade, and
 * "smallest first" maximises the tool *count* rather than the chance the right
 * tool is present.
 *
 * The kept set is then emitted **in the caller's original order**, which is the
 * subtle part. Anthropic's prompt cache keys on an exact prefix; a manifest
 * reordered by recency changes its bytes on almost every turn and throws the tool
 * block's cache away each time. Since the tools block is usually the largest
 * cacheable thing in the request, a recency-ordered manifest can cost more in lost
 * cache reads than the whole selection saves.
 */
export function selectTools(input: SelectToolsInput): ToolSelection {
  const slimOptions = input.slim === false ? undefined : (input.slim ?? {});
  const prepared = input.tools.map((tool) => (slimOptions ? slimTool(tool, slimOptions) : tool));
  const slimmed = prepared.length
    ? input.tools.reduce((sum, tool) => sum + estimateToolTokens(tool), 0) -
      prepared.reduce((sum, tool) => sum + estimateToolTokens(tool), 0)
    : 0;

  const required = new Set(input.required ?? []);
  const recency = new Map((input.recent ?? []).map((name, index) => [name, index]));
  const rank = (tool: ToolDefinition, index: number): number => {
    if (required.has(tool.name)) return -1_000_000 + index;
    const seen = recency.get(tool.name);
    if (seen !== undefined) return -100_000 + seen;
    return index;
  };

  const order = prepared.map((tool, index) => ({ tool, index })).sort((a, b) => rank(a.tool, a.index) - rank(b.tool, b.index));

  const kept = new Set<number>();
  let tokens = 0;
  for (const { tool, index } of order) {
    const cost = estimateToolTokens(tool);
    if (required.has(tool.name)) {
      kept.add(index);
      tokens += cost;
      continue;
    }
    if (tokens + cost > input.budget) continue;
    kept.add(index);
    tokens += cost;
  }

  const tools = prepared.filter((_, index) => kept.has(index));
  const withheld = prepared
    .filter((_, index) => !kept.has(index))
    .map((tool) => tool.name)
    .sort();

  return { tools, withheld, tokens, slimmed };
}

/**
 * The sentence appended to the system prompt when tools were withheld.
 *
 * Returns `''` when nothing was withheld, so the prefix of a request with a
 * complete manifest is byte-identical to what it would have been without this
 * feature — which is what keeps the cache warm on the common path.
 *
 * Names them. A model told only "some tools are unavailable" will either
 * hallucinate a call to one it half-remembers or claim a task is impossible; a
 * model given the list can say which one it needs.
 */
export function describeWithheldTools(withheld: readonly string[]): string {
  if (!withheld.length) return '';
  const names = withheld.map((name) => `\`${name}\``).join(', ');
  return (
    `# Tools not currently offered\n\n` +
    `These tools exist but were left out of this request to fit the context window: ${names}. ` +
    'Do not attempt to call them. If one of them is what the task needs, say so and say why, rather than ' +
    'working around it.'
  );
}
