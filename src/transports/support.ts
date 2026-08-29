/**
 * What each transport and model actually supports.
 *
 * Phase 2 requires every control to grey out *with an explanation* when the active
 * model or transport can't use it. That needs a single source of truth, or the
 * explanation drifts from the adapter's real behaviour — so the adapters and the
 * UI both read this table.
 *
 * Two separate reasons a control can be unavailable:
 *
 *  - the *transport* has no such field (`seed` on the Anthropic path), which is a
 *    hard fact of the wire format;
 *  - the *model* doesn't support the capability (vision, tool use, reasoning),
 *    which is a hand-editable flag because the gateway doesn't tell us.
 */

import type { ReasoningEffort, TransportKind } from './types';
import { ANTHROPIC_EFFORTS, OPENAI_EFFORTS } from './types';

/** Every tunable the UI can show. Keys match `SamplingParams` / `ReasoningConfig`. */
export type ControlKey =
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'maxTokens'
  | 'stopSequences'
  | 'seed'
  | 'presencePenalty'
  | 'frequencyPenalty'
  | 'reasoningEffort'
  | 'thinkingBudget';

export interface ControlSupport {
  supported: boolean;
  /** Why not. Shown next to the greyed-out control; empty when supported. */
  reason: string;
}

/**
 * Capability flags per model. Hand-editable, because `/v1/models` returns nothing
 * but ids — the gateway does not describe what its models can do.
 */
export interface ModelCapabilities {
  vision: boolean;
  /** Anthropic native document blocks (PDF/text) are supported. */
  documents: boolean;
  tools: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  /** Anthropic path: whether the effort ladder above `high` is accepted. */
  extendedEffort?: boolean;
  /**
   * Anthropic path: whether `cache_control` breakpoints are honoured.
   *
   * Manual like the rest, and worth being conservative about for a specific
   * reason: a gateway that proxies Anthropic without supporting prompt caching
   * accepts the markers and reports no cache tokens, so the request is charged at
   * the normal rate and nothing is lost. But one that *partially* supports it can
   * charge the 1.25× write premium for entries it never serves. Leaving this off
   * for an unknown gateway costs a saving; turning it on wrongly costs money.
   */
  promptCache?: boolean;
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  vision: false,
  documents: false,
  tools: true,
  reasoning: false,
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};

const NOT_ON_ANTHROPIC = 'The Anthropic Messages API has no such field, so it would be ignored or rejected.';
const NOT_ON_OPENAI = 'Not part of the OpenAI Chat Completions schema on this gateway.';

/** Transport-level support. Independent of which model is selected. */
const TRANSPORT_SUPPORT: Record<TransportKind, Partial<Record<ControlKey, string>>> = {
  // Values are the *reason it is unsupported*; absent means supported.
  anthropic: {
    seed: NOT_ON_ANTHROPIC,
    presencePenalty: NOT_ON_ANTHROPIC,
    frequencyPenalty: NOT_ON_ANTHROPIC,
  },
  openai: {
    topK: `${NOT_ON_OPENAI} Sent anyway when set, and dropped automatically if rejected.`,
    thinkingBudget:
      'The OpenAI path exposes reasoning as an effort level, not a token budget. Use reasoning effort instead.',
  },
};

export function controlSupport(
  key: ControlKey,
  transport: TransportKind,
  capabilities: ModelCapabilities = DEFAULT_CAPABILITIES,
): ControlSupport {
  const transportReason = TRANSPORT_SUPPORT[transport][key];
  if (transportReason) return { supported: false, reason: transportReason };

  if ((key === 'reasoningEffort' || key === 'thinkingBudget') && !capabilities.reasoning) {
    return {
      supported: false,
      reason:
        'This model is not flagged reasoning-capable. Flip the flag in Settings → Models if the gateway ' +
        'supports it — the gateway does not report capabilities, so the flag is manual.',
    };
  }

  return { supported: true, reason: '' };
}

/** Efforts offered for a transport, narrowed by the model's extended-effort flag. */
export function availableEfforts(
  transport: TransportKind,
  capabilities: ModelCapabilities = DEFAULT_CAPABILITIES,
): readonly ReasoningEffort[] {
  if (transport === 'openai') return OPENAI_EFFORTS;
  if (capabilities.extendedEffort === false) return ANTHROPIC_EFFORTS.filter((effort) => effort !== 'xhigh' && effort !== 'max');
  return ANTHROPIC_EFFORTS;
}

/**
 * Guess capabilities from a model id, as a starting point the user then edits.
 *
 * Deliberately conservative: a wrong `true` produces a confusing API error, while
 * a wrong `false` just greys out a control the user can re-enable in one tap.
 */
export function guessCapabilities(modelId: string): ModelCapabilities {
  const id = modelId.toLowerCase();
  const isClaude = id.startsWith('claude');
  const isGpt = /^(gpt|o\d|chatgpt)/.test(id);
  const isReasoner = /(^o\d|thinking|reason|-r1|deepseek-r)/.test(id) || (isClaude && /opus|sonnet/.test(id));

  return {
    vision: isClaude || isGpt || /vision|vl|multimodal/.test(id),
    documents: isClaude,
    tools: true,
    reasoning: isReasoner,
    contextWindow: isClaude ? 200_000 : 128_000,
    maxOutputTokens: isClaude ? 32_000 : 16_384,
    // Claude models on the Anthropic path are the only ones where an explicit
    // breakpoint does anything; OpenAI-compatible caching is automatic.
    ...(isClaude ? { extendedEffort: true, promptCache: true } : {}),
  };
}
