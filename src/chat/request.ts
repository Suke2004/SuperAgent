/**
 * Turning a stored conversation into a wire request.
 *
 * Pure functions, no I/O and no store reads, so the validation rules below are
 * unit-testable and so the chat store has one obvious place to look when a
 * request comes out wrong.
 *
 * Two of the rules here exist because the gateway answers them with a 400 that
 * takes a while to interpret, and the spec asks for them as validation instead:
 *
 *   - Extended thinking cannot be *disabled* at effort `xhigh` or `max` on
 *     current Claude models. Sending that combination is rejected outright.
 *   - `max_tokens` caps total output *including* thinking, so a small
 *     `max_tokens` with a large thinking budget starves the visible answer.
 */

import type { ConversationConfig } from '@/db/conversations';
import type { ModelCapabilities } from '@/transports/support';
import { controlSupport } from '@/transports/support';
import type {
  ChatRequest,
  ReasoningConfig,
  ReasoningEffort,
  SamplingParams,
  TransportKind,
  UnifiedMessage,
  WireHints,
} from '@/transports/types';

/* -------------------------------------------------------------------------- */
/* Thinking budgets                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Effort level → thinking token budget.
 *
 * This mapping is this app's own choice, not something the gateway defines: the
 * Anthropic Messages API takes `thinking.budget_tokens`, so an effort ladder has
 * to be translated into a number somewhere. Exposed as a table rather than
 * hidden in a formula so the numbers can be argued with, and the slider stays
 * available for anyone who would rather set the budget directly.
 */
export const EFFORT_BUDGETS: Record<ReasoningEffort, number> = {
  minimal: 1_024,
  low: 4_096,
  medium: 16_384,
  high: 32_768,
  xhigh: 63_999,
  max: 127_999,
};

/** Anthropic's documented floor. Below this the API rejects the request. */
export const MIN_THINKING_BUDGET = 1_024;

/** Efforts at which thinking cannot be switched off. */
const FORCED_THINKING_EFFORTS: ReasoningEffort[] = ['xhigh', 'max'];

export function budgetForEffort(effort: ReasoningEffort): number {
  return EFFORT_BUDGETS[effort];
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export type IssueLevel = 'error' | 'warning';

export interface ConfigIssue {
  level: IssueLevel;
  /** Which control the message belongs next to. */
  field: 'maxTokens' | 'thinkingBudget' | 'reasoningEffort' | 'temperature' | 'topP' | 'stopSequences' | 'seed';
  message: string;
}

export interface ValidationInput {
  transport: TransportKind;
  capabilities: ModelCapabilities;
  params: SamplingParams;
  reasoning?: ReasoningConfig;
}

/**
 * Everything wrong with a parameter set, as messages to show beside the
 * controls.
 *
 * `error` means the request would be rejected and the send button should refuse;
 * `warning` means it would succeed but produce something the user probably
 * doesn't want. Both are returned together so the settings sheet can render one
 * list.
 */
export function validateConfig(input: ValidationInput): ConfigIssue[] {
  const { transport, capabilities, params, reasoning } = input;
  const issues: ConfigIssue[] = [];

  const thinkingOn = Boolean(reasoning?.enabled);
  const effort = reasoning?.effort;

  if (params.maxTokens < 1) {
    issues.push({ level: 'error', field: 'maxTokens', message: 'Max output tokens must be at least 1.' });
  }

  if (params.maxTokens > capabilities.maxOutputTokens) {
    issues.push({
      level: 'warning',
      field: 'maxTokens',
      message:
        `This model is recorded as capping output at ${capabilities.maxOutputTokens.toLocaleString()} tokens. ` +
        'The gateway may reject a higher value — adjust the cap in Settings → Models if it accepts it.',
    });
  }

  // Rule 1: the effort ladder above `high` implies thinking. Disabling it there
  // is a 400 rather than a quiet default, so refuse before sending.
  if (transport === 'anthropic' && !thinkingOn && effort && FORCED_THINKING_EFFORTS.includes(effort)) {
    issues.push({
      level: 'error',
      field: 'reasoningEffort',
      message:
        `Extended thinking cannot be turned off at effort ${effort}. Current Claude models only accept ` +
        'thinking: disabled at high or below — pick a lower effort, or leave thinking on.',
    });
  }

  if (thinkingOn && transport === 'anthropic') {
    const budget = reasoning?.budgetTokens ?? (effort ? budgetForEffort(effort) : EFFORT_BUDGETS.medium);

    if (budget < MIN_THINKING_BUDGET) {
      issues.push({
        level: 'error',
        field: 'thinkingBudget',
        message: `The thinking budget must be at least ${MIN_THINKING_BUDGET.toLocaleString()} tokens.`,
      });
    }

    // Rule 2: max_tokens is the total output allowance, thinking included.
    if (budget >= params.maxTokens) {
      issues.push({
        level: 'error',
        field: 'maxTokens',
        message:
          `Max output tokens (${params.maxTokens.toLocaleString()}) is not above the thinking budget ` +
          `(${budget.toLocaleString()}). Thinking is charged against the same allowance, so there would be ` +
          'nothing left for the answer.',
      });
    } else if (params.maxTokens - budget < 1_024) {
      issues.push({
        level: 'warning',
        field: 'maxTokens',
        message:
          `Only ${(params.maxTokens - budget).toLocaleString()} tokens are left for the visible answer after ` +
          'the thinking budget. Expect a reply that stops mid-sentence.',
      });
    }

    if (params.temperature !== undefined || params.topP !== undefined || params.topK !== undefined) {
      issues.push({
        level: 'warning',
        field: 'temperature',
        message:
          'Sampling controls are not accepted alongside extended thinking on the Anthropic path. They will be ' +
          'left out of the request.',
      });
    }
  }

  if (params.temperature !== undefined && (params.temperature < 0 || params.temperature > 2)) {
    issues.push({ level: 'error', field: 'temperature', message: 'Temperature must be between 0 and 2.' });
  }
  if (params.topP !== undefined && (params.topP <= 0 || params.topP > 1)) {
    issues.push({ level: 'error', field: 'topP', message: 'top_p must be greater than 0 and at most 1.' });
  }
  if (params.temperature !== undefined && params.topP !== undefined) {
    issues.push({
      level: 'warning',
      field: 'topP',
      message:
        'Setting temperature and top_p together is discouraged by both providers; the results are hard to ' +
        'reason about. Prefer one.',
    });
  }
  if (params.stopSequences && params.stopSequences.length > 4 && transport === 'openai') {
    issues.push({
      level: 'warning',
      field: 'stopSequences',
      message: 'The OpenAI schema accepts at most 4 stop sequences. Extra ones are likely to be rejected.',
    });
  }
  if (params.seed !== undefined && !controlSupport('seed', transport, capabilities).supported) {
    issues.push({
      level: 'warning',
      field: 'seed',
      message: 'Seed has no equivalent on this transport and will be dropped from the request.',
    });
  }

  return issues;
}

export function hasBlockingIssue(issues: readonly ConfigIssue[]): boolean {
  return issues.some((issue) => issue.level === 'error');
}

/* -------------------------------------------------------------------------- */
/* Stop sequences                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Stop sequences as one text field: one sequence per line.
 *
 * Newline-separated rather than comma-separated because a comma is a perfectly
 * ordinary thing to want to stop on, and a separator the value can contain is a
 * field that cannot express half its domain.
 *
 * Nothing is trimmed. `  ` and `Human: ` are both legitimate sequences and
 * trailing space is exactly the sort of thing someone stops on, so only lines that
 * are entirely empty are dropped. A stray `\r` from a paste is removed, because
 * that is never what was meant.
 */
export function parseStopSequences(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const sequence = line.replace(/\r$/, '');
    if (sequence !== '') seen.add(sequence);
  }
  return [...seen];
}

/** The inverse, for seeding the field from what the conversation currently sends. */
export function formatStopSequences(sequences: readonly string[] | undefined): string {
  return (sequences ?? []).join('\n');
}

/* -------------------------------------------------------------------------- */
/* Defaults and merging                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The parameter set a conversation sends when the user has changed nothing.
 *
 * Deliberately sparse: every optional field left `undefined` is one the adapter
 * omits from the request, which is the right default against a gateway that may
 * reject or silently drop anything it doesn't recognise.
 */
export function defaultParams(capabilities: ModelCapabilities): SamplingParams {
  return { maxTokens: Math.min(8_192, capabilities.maxOutputTokens) };
}

export function mergeParams(
  capabilities: ModelCapabilities,
  overrides: Partial<SamplingParams> | undefined,
): SamplingParams {
  const base = defaultParams(capabilities);
  if (!overrides) return base;
  const merged: SamplingParams = { ...base, ...overrides };
  // A stored `maxTokens` of 0 or NaN — from a half-typed field — would make every
  // reply empty, which looks like a gateway fault rather than a settings mistake.
  if (!Number.isFinite(merged.maxTokens) || merged.maxTokens < 1) merged.maxTokens = base.maxTokens;
  return merged;
}

/**
 * Resolves the reasoning config actually sent, given the transport and model.
 *
 * Returns `undefined` when reasoning should be left out of the request entirely,
 * which is different from `{enabled: false}` — the latter sends an explicit
 * `thinking: {type: 'disabled'}` on the Anthropic path.
 */
export function resolveReasoning(
  transport: TransportKind,
  capabilities: ModelCapabilities,
  configured: ReasoningConfig | undefined,
): ReasoningConfig | undefined {
  if (!configured) return undefined;
  if (!capabilities.reasoning) return undefined;

  if (transport === 'openai') {
    if (!configured.enabled) return undefined;
    return { enabled: true, ...(configured.effort ? { effort: configured.effort } : { effort: 'medium' }) };
  }

  if (!configured.enabled) return { enabled: false };

  const effort = configured.effort ?? 'medium';
  const budget = configured.budgetTokens ?? budgetForEffort(effort);
  return { enabled: true, effort, budgetTokens: Math.max(MIN_THINKING_BUDGET, Math.floor(budget)) };
}

/* -------------------------------------------------------------------------- */
/* Building                                                                    */
/* -------------------------------------------------------------------------- */

export interface BuildInput {
  transport: TransportKind;
  model: string;
  capabilities: ModelCapabilities;
  wireHints?: WireHints;
  config: ConversationConfig;
  systemPrompt?: string;
  messages: UnifiedMessage[];
  /** Prepended to the system prompt when the `summarise` strategy has run. */
  summary?: string;
  /** Long-term memory, already budgeted and rendered by `@/chat/memory`. */
  memory?: string;
  /** The skill catalogue — names and descriptions only — from `@/chat/skill`. */
  skills?: string;
  tools?: ChatRequest['tools'];
  /** Overrides the conversation's params for one message. */
  paramOverrides?: Partial<SamplingParams>;
}

export function buildRequest(input: BuildInput): ChatRequest {
  const params = mergeParams(input.capabilities, { ...input.config.params, ...input.paramOverrides });
  const reasoning = resolveReasoning(input.transport, input.capabilities, input.config.reasoning);

  const system = composeSystem(input.systemPrompt, input.summary, input.memory, input.skills);

  const request: ChatRequest = {
    model: input.model,
    messages: input.messages,
    params,
  };
  if (system) request.system = system;
  if (reasoning) request.reasoning = reasoning;
  if (input.wireHints) request.wireHints = input.wireHints;
  if (input.tools?.length) request.tools = input.tools;
  return request;
}

/**
 * Joins the user's system prompt with the memory block, the skill catalogue and any
 * rolling summary.
 *
 * Order is the whole content of this function. The user's prompt comes first
 * because it is the only part they wrote. Memory comes next, framed as notes and
 * explicitly subordinate, so a remembered "prefers terse answers" cannot quietly
 * outrank a prompt asking for detail today. The skill catalogue follows: it is a
 * list of what is available rather than an instruction, so it belongs below
 * anything that says what to do. The summary comes last, under its own heading, so
 * a model reading it treats it as context rather than as instructions.
 */
export function composeSystem(
  prompt: string | undefined,
  summary: string | undefined,
  memory?: string,
  skills?: string,
): string | undefined {
  const parts: string[] = [];
  if (prompt?.trim()) parts.push(prompt.trim());
  if (memory?.trim()) parts.push(memory.trim());
  if (skills?.trim()) parts.push(skills.trim());
  if (summary?.trim()) {
    parts.push(
      `# Summary of earlier conversation\n\nEarlier turns were removed to fit the context window. ` +
        `This is what they contained:\n\n${summary.trim()}`,
    );
  }
  return parts.length ? parts.join('\n\n') : undefined;
}

/** The prompt used by the `summarise` context strategy. */
export const SUMMARY_INSTRUCTION =
  'Summarise the conversation above as compactly as you can without losing anything that later turns might ' +
  'need: decisions made, facts established, code or names introduced, and anything the user asked you to ' +
  'remember. Write it as notes, not prose. Do not add commentary, and do not address the user.';
