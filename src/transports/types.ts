/**
 * Provider-agnostic transport types.
 *
 * The two transports differ in far more than base URL: message shape, where the
 * system prompt lives, how images are encoded, the streaming event vocabulary,
 * the tool-call schema, and the stop-reason names all diverge. Everything above
 * this file speaks only the types declared here; each adapter owns its own
 * translation in both directions.
 *
 * The base-URL distinction is the single easiest thing to get wrong, so it is
 * encoded in the type system rather than left to a comment:
 *
 *   Anthropic-compatible → https://agentrouter.org        (bare origin, no /v1)
 *                          POST <base>/v1/messages
 *   OpenAI-compatible    → https://agentrouter.org/v1     (WITH /v1)
 *                          POST <base>/chat/completions, GET <base>/models
 */

import type { GatewayError } from './errors';

export type TransportKind = 'anthropic' | 'openai';

/* -------------------------------------------------------------------------- */
/* Content                                                                     */
/* -------------------------------------------------------------------------- */

export interface TextBlock {
  type: 'text';
  text: string;
  /**
   * Where the model says this text came from, when it cited anything.
   *
   * Only produced by a server-side search: the provider attaches a citation to the
   * text block as it writes, which is a stronger claim than the source list on the
   * {@link ServerToolBlock} — that says "these pages were found", this says "this
   * sentence came from that page".
   *
   * Not replayed. The API does not require citations on a text block sent back to
   * it, and unlike `ServerToolBlock.raw` there is no id pairing that breaks without
   * them, so they stay a display-and-export concern and cost nothing on the wire.
   */
  citations?: Citation[];
}

/** One cited source. Provider JSON, narrowed to the three fields worth showing. */
export interface Citation {
  url: string;
  title?: string;
  /** The passage the provider says was used. Quoted in an export, not the transcript. */
  citedText?: string;
}

export interface ImageBlock {
  type: 'image';
  /** e.g. `image/jpeg`. */
  mediaType: string;
  /** Raw base64, with no `data:` prefix. Adapters add whatever wrapper they need. */
  data: string;
}

export interface DocumentBlock {
  type: 'document';
  /** e.g. `application/pdf`, `text/plain`. */
  mediaType: string;
  /** Raw base64 for native document blocks. */
  data?: string;
  /** Text already extracted on device, for transports without document support. */
  text?: string;
  name?: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  /**
   * Anthropic returns a signature that must be echoed back verbatim when the
   * thinking block is replayed in a later turn, or the API rejects the request.
   */
  signature?: string;
  /** Anthropic may return redacted thinking as an opaque blob. */
  redacted?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  /** Rendered result text. Structured results are JSON-stringified by the caller. */
  content: string;
  /**
   * Images the tool returned, base64.
   *
   * Set only when the model can see them: a transport that cannot carry an image in
   * a tool result drops these and sends the text, which already says an image was
   * returned. A screenshot tool whose picture is thrown away is a tool the model
   * will keep calling and keep learning nothing from.
   */
  images?: { mediaType: string; data: string }[];
  isError?: boolean;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | DocumentBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ServerToolBlock;

/**
 * A tool the *provider* ran, kept verbatim so it can be replayed.
 *
 * Web search on the Anthropic path is not a tool this app executes: the model calls
 * it server-side and the results come back inside the same stream as
 * `server_tool_use` / `web_search_tool_result` blocks. Two things follow, and both are
 * why this block exists rather than the results being flattened into text.
 *
 *  1. **It has to round-trip byte-for-byte.** A later turn replays the assistant's
 *     content, and the API rejects a `web_search_tool_result` whose `tool_use_id` no
 *     longer matches a `server_tool_use` — or that has been rewritten into prose. So
 *     `raw` is the wire block untouched, and the adapter that produced it hands it
 *     straight back.
 *  2. **Only its own transport can send it.** The OpenAI path has no such block, and
 *     forwarding one would be a schema error on a message the user cannot edit. The
 *     `transport` field is what every adapter checks before replaying.
 *
 * `summary` and `sources` are the app's own reading of `raw`, for the transcript.
 * Derived once at translation time rather than re-parsed by the renderer, because the
 * shape is the provider's and this is the file that knows it.
 */
export interface ServerToolBlock {
  type: 'server_tool';
  transport: TransportKind;
  /** What the provider ran, e.g. `web_search`. */
  name: string;
  /** The wire blocks, verbatim and in order. Never rewritten. */
  raw: Record<string, unknown>[];
  /** One line for the transcript, e.g. `Searched the web for "expo sdk 57"`. */
  summary?: string;
  /** Pages the search returned, for the source list under the message. */
  sources?: { title?: string; url: string }[];
}

export type UnifiedRole = 'user' | 'assistant';

export interface UnifiedMessage {
  role: UnifiedRole;
  content: ContentBlock[];
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

export type ToolChoice = { type: 'auto' } | { type: 'none' } | { type: 'any' } | { type: 'tool'; name: string };

/**
 * Tools the *provider* runs, rather than ones this app executes.
 *
 * Kept apart from {@link ToolDefinition} because there is no schema to send and no
 * result to return: the provider is told the tool exists by name and version, and the
 * calls and their results arrive inside the reply. A transport with no equivalent
 * ignores this field, which is why it is not a `ToolDefinition` with a magic name —
 * that would put a tool in the manifest that the model could call and nothing could
 * answer.
 */
export interface ServerTools {
  /** Anthropic path only. `maxUses` caps searches per turn; the API defaults to 5. */
  webSearch?: { maxUses?: number };
}

/* -------------------------------------------------------------------------- */
/* Sampling and reasoning                                                      */
/* -------------------------------------------------------------------------- */

/** Effort ladder. `xhigh` and `max` are Anthropic-path only. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const OPENAI_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'] as const;
export const ANTHROPIC_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface ReasoningConfig {
  /** When false, thinking is explicitly disabled. */
  enabled: boolean;
  /** OpenAI path: sent as `reasoning_effort`. Anthropic path: the effort ladder. */
  effort?: ReasoningEffort;
  /** Anthropic path: explicit `thinking.budget_tokens`. */
  budgetTokens?: number;
}

export interface SamplingParams {
  maxTokens: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  seed?: number;
  /** OpenAI path only. */
  presencePenalty?: number;
  /** OpenAI path only. */
  frequencyPenalty?: number;
}

/** Names of the optional params, used for the drop-and-retry diagnostic. */
export const OPTIONAL_PARAM_KEYS = [
  'temperature',
  'top_p',
  'top_k',
  'stop',
  'stop_sequences',
  'seed',
  'presence_penalty',
  'frequency_penalty',
  'reasoning_effort',
  'thinking',
] as const;

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Per-model wire quirks, set from the model registry's hand-editable flags.
 *
 * These are genuinely wire-level: they change the shape of the request rather
 * than its meaning, so they don't belong in `SamplingParams`. Each has a runtime
 * fallback in the adapter, so a wrong or absent hint costs one extra round trip
 * rather than a failed request.
 */
export interface WireHints {
  /**
   * OpenAI path: newer reasoning models reject `max_tokens` and require
   * `max_completion_tokens`. Wrong guess → the adapter renames and retries once.
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Anthropic path: values for the `anthropic-beta` header. */
  betas?: string[];
}

/**
 * Where to ask the provider to cache the request prefix.
 *
 * Transport-agnostic on purpose even though only the Anthropic path can act on it:
 * the OpenAI-compatible path caches automatically and needs no markers, so it
 * ignores this field rather than the caller having to know which is which.
 *
 * The decision of *where* the marks go is `@/chat/cache`'s, not the adapter's. The
 * adapter only knows how to express them on the wire.
 */
export interface CacheMarks {
  /** Cache the tool manifest, by marking the last definition. */
  tools?: boolean;
  /** Cache the system prompt. */
  system?: boolean;
  /**
   * Cache history through this index into `messages`, inclusive. The adapter may
   * place the marker earlier than asked when the message at that index merged with
   * a later one on the wire, but never later.
   */
  historyThrough?: number;
}

export interface ChatRequest {
  model: string;
  /** Placed per-transport: a top-level `system` field, or a `system` message. */
  system?: string;
  messages: UnifiedMessage[];
  params: SamplingParams;
  reasoning?: ReasoningConfig;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /** Tools the provider runs itself. See {@link ServerTools}. */
  serverTools?: ServerTools;
  /** Prompt-cache breakpoints. See {@link CacheMarks}. */
  cache?: CacheMarks;
  /** Per-model wire quirks. See {@link WireHints}. */
  wireHints?: WireHints;
  /** Extra body fields, merged last. An escape hatch for gateway-specific knobs. */
  extraBody?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Usage and stop reasons                                                      */
/* -------------------------------------------------------------------------- */

export interface TokenUsage {
  input: number;
  output: number;
  /** Reasoning tokens, when the provider reports them separately. */
  thinking?: number;
  /** Tokens read from the prompt cache. */
  cacheRead?: number;
  /** Tokens written to the prompt cache. */
  cacheWrite?: number;
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'content_filter'
  /**
   * Anthropic-only: the model paused a long-running turn and expects to be asked
   * to continue. Kept distinct from `end_turn` because the turn isn't finished —
   * flattening the two would make a resumable pause look like a complete answer.
   */
  | 'pause_turn'
  | 'aborted'
  | 'unknown';

/* -------------------------------------------------------------------------- */
/* Stream events                                                               */
/* -------------------------------------------------------------------------- */

export type StreamEvent =
  | { type: 'start'; id?: string; model?: string }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_signature'; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use_start'; index: number; id: string; name: string }
  | { type: 'tool_use_delta'; index: number; partialJson: string }
  | { type: 'tool_use_stop'; index: number }
  /**
   * A tool the provider ran and answered on its own, already whole.
   *
   * One event rather than start/delta/stop: nothing streams usefully out of a search
   * result, and the app has no half-state to show. See {@link ServerToolBlock}.
   */
  | { type: 'server_tool'; block: ServerToolBlock }
  /**
   * A source the model attributed the text it is writing to.
   *
   * Separate from `text_delta` because it arrives on its own frame and applies to the
   * text block being written, not to a span this app could locate in it. Collected
   * onto the one text block the accumulator produces.
   */
  | { type: 'citation'; citation: Citation }
  | { type: 'usage'; usage: Partial<TokenUsage> }
  | { type: 'stop'; reason: StopReason }
  /**
   * A parameter was rejected and the request was retried without it. Surfaced so
   * the UI can tell the user exactly what was dropped.
   */
  | { type: 'param_dropped'; param: string; message: string }
  /** The active provider became unreachable and a fallback base URL was used. */
  | { type: 'failover'; from: string; to: string };

/** The assembled result of a stream, or of a non-streaming call. */
export interface ChatResult {
  id?: string;
  model?: string;
  content: ContentBlock[];
  stopReason: StopReason;
  usage: TokenUsage;
  /** Params the gateway rejected and we retried without. */
  droppedParams: string[];
}

/* -------------------------------------------------------------------------- */
/* Models                                                                      */
/* -------------------------------------------------------------------------- */

export interface DiscoveredModel {
  id: string;
  /** `owned_by` from `/v1/models`, when present. */
  ownedBy?: string;
  created?: number;
  /** Anything else the gateway returned, kept for the model detail screen. */
  extra?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Connection test                                                             */
/* -------------------------------------------------------------------------- */

export interface ConnectionTestStep {
  label: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
  /** Populated on failure so the UI can show the gateway's own message. */
  error?: GatewayError;
  durationMs?: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  steps: ConnectionTestStep[];
  /** Models discovered during the test, if the models call succeeded. */
  models?: DiscoveredModel[];
  /**
   * The model the chat probe actually used.
   *
   * Reported so the caller can tell the difference between "your configured model
   * works" and "your configured model is not served, but this one is" — and offer
   * to switch rather than leaving the profile pointing at an id the gateway 403s.
   */
  probedModel?: string;
  /** Overall human-readable verdict. Never a bare "failed". */
  summary: string;
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

export interface TransportConfig {
  kind: TransportKind;
  /**
   * For `anthropic`: the bare origin, e.g. `https://agentrouter.org`.
   * For `openai`: the origin **with** `/v1`, e.g. `https://agentrouter.org/v1`.
   */
  baseUrl: string;
  apiKey: string;
  /**
   * The model the profile is configured to use.
   *
   * Only the connection test reads it, and that is the point: probing a hardcoded
   * id against a gateway that does not serve it reports `403 Forbidden` for a
   * working key, which is the single most expensive false negative this app can
   * produce. Whoever builds the transport already knows the configured model, so
   * the test asks about that one first.
   */
  defaultModel?: string;
  /** Extra headers, e.g. `anthropic-beta`. Never contains the key. */
  headers?: Record<string, string>;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Anthropic API version header. */
  anthropicVersion?: string;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** Called when the adapter drops a rejected parameter and retries. */
  onParamDropped?: (param: string, message: string) => void;
  /**
   * Called before each backoff sleep.
   *
   * Exposed because a 20-second wait labelled "Streaming" is indistinguishable
   * from a hung request: the UI needs to be able to say "rate limited, retrying in
   * 8s (attempt 2 of 4)".
   */
  onRetry?: (info: { attempt: number; delayMs: number; message: string }) => void;
}

export interface Transport {
  readonly kind: TransportKind;
  readonly baseUrl: string;

  /** `GET <base>/models`. The Anthropic transport reads the OpenAI-side list. */
  listModels(signal?: AbortSignal): Promise<DiscoveredModel[]>;

  /** Streaming chat. Yields unified events; aborts promptly on `signal`. */
  stream(request: ChatRequest, options?: StreamOptions): AsyncGenerator<StreamEvent, void, undefined>;

  /** Non-streaming chat, for token counting probes and the offline queue. */
  complete(request: ChatRequest, options?: StreamOptions): Promise<ChatResult>;

  /** Exact token count, when the provider exposes an endpoint for it. */
  countTokens?(request: ChatRequest, signal?: AbortSignal): Promise<number>;

  /** Multi-step diagnostic used by the "test connection" button. */
  testConnection(signal?: AbortSignal): Promise<ConnectionTestResult>;
}

/** Collapse a stream into a {@link ChatResult}. Shared by both adapters. */
export function createResultAccumulator(): {
  handle(event: StreamEvent): void;
  result(): ChatResult;
} {
  let id: string | undefined;
  let model: string | undefined;
  let stopReason: StopReason = 'unknown';
  const usage: TokenUsage = { input: 0, output: 0 };
  const droppedParams: string[] = [];

  let text = '';
  let thinking = '';
  let signature: string | undefined;
  const redacted: string[] = [];
  const serverTools: ServerToolBlock[] = [];
  const citations: Citation[] = [];
  const toolCalls = new Map<number, { id: string; name: string; json: string }>();

  return {
    handle(event) {
      switch (event.type) {
        case 'start':
          id = event.id ?? id;
          model = event.model ?? model;
          break;
        case 'text_delta':
          text += event.text;
          break;
        case 'thinking_delta':
          thinking += event.text;
          break;
        case 'thinking_signature':
          signature = event.signature;
          break;
        case 'redacted_thinking':
          redacted.push(event.data);
          break;
        case 'server_tool':
          serverTools.push(event.block);
          break;
        case 'citation':
          // De-duplicated on the URL: a provider cites the same page for consecutive
          // sentences, and a source list that repeats one page eight times is noise.
          if (!citations.some((existing) => existing.url === event.citation.url)) citations.push(event.citation);
          break;
        case 'tool_use_start': {
          // Non-destructive, like `start` above. Some gateways repeat the call id
          // (and sometimes the name) on every delta, which re-fires this event; a
          // plain `set` would reset `json` and throw away the arguments already
          // accumulated, leaving truncated JSON.
          const existing = toolCalls.get(event.index);
          if (existing) {
            if (event.id) existing.id = event.id;
            if (event.name) existing.name = event.name;
          } else {
            toolCalls.set(event.index, { id: event.id, name: event.name, json: '' });
          }
          break;
        }
        case 'tool_use_delta': {
          const existing = toolCalls.get(event.index);
          if (existing) existing.json += event.partialJson;
          break;
        }
        case 'usage':
          if (event.usage.input !== undefined) usage.input = event.usage.input;
          if (event.usage.output !== undefined) usage.output = event.usage.output;
          if (event.usage.thinking !== undefined) usage.thinking = event.usage.thinking;
          if (event.usage.cacheRead !== undefined) usage.cacheRead = event.usage.cacheRead;
          if (event.usage.cacheWrite !== undefined) usage.cacheWrite = event.usage.cacheWrite;
          break;
        case 'stop':
          stopReason = event.reason;
          break;
        case 'param_dropped':
          droppedParams.push(event.param);
          break;
        default:
          break;
      }
    },

    result() {
      const content: ContentBlock[] = [];
      if (thinking) {
        const block: ThinkingBlock = { type: 'thinking', text: thinking };
        if (signature) block.signature = signature;
        content.push(block);
      }
      for (const blob of redacted) {
        content.push({ type: 'thinking', text: '', redacted: blob });
      }
      // Before the text, which is the order they happened in: the model searched and
      // then wrote the answer.
      content.push(...serverTools);
      if (text) content.push({ type: 'text', text, ...(citations.length ? { citations } : {}) });
      for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: safeParseJson(call.json),
        });
      }
      const result: ChatResult = { content, stopReason, usage, droppedParams };
      if (id !== undefined) result.id = id;
      if (model !== undefined) result.model = model;
      return result;
    },
  };
}

/**
 * Parse accumulated tool-call JSON.
 *
 * Streamed tool arguments arrive as JSON fragments; if the stream is cut short
 * the accumulated text is invalid. Returning the raw string under `_raw` lets the
 * loop surface a tool error to the model instead of throwing.
 */
export function safeParseJson(json: string): unknown {
  const trimmed = json.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { _raw: trimmed, _parseError: 'incomplete or invalid JSON in streamed tool arguments' };
  }
}
