/**
 * Anthropic-compatible transport.
 *
 *   Base URL is the **bare origin**, no /v1:  https://agentrouter.org
 *   POST <base>/v1/messages
 *   GET  <base>/v1/models
 *
 * Divergences from the OpenAI path that are resolved here, not in the UI:
 *
 *  - the system prompt is a top-level `system` field, not a message;
 *  - images are `{source: {type: "base64", media_type, data}}`, not data URLs;
 *  - PDFs and text files have native `document` blocks;
 *  - tool results are content blocks inside a user turn, so consecutive turns must
 *    be merged rather than emitted one per block;
 *  - streaming is a vocabulary of named events, not `delta` patches;
 *  - thinking is a first-class content block, and replaying one needs its
 *    `signature` echoed back verbatim;
 *  - `seed`, `presence_penalty` and `frequency_penalty` do not exist here.
 */

import { GatewayError, validationError } from './errors';
import { HttpClient, type FetchLike, type ParamDropInfo, type SendOptions } from './http';
import { describeBaseUrlIssue, parseModelList, pickProbeModel, summariseFailure } from './openai';
import type { RetryPolicy } from './retry';
import { parseEventData, type SseEvent } from './sse';
import {
  createResultAccumulator,
  type ChatRequest,
  type ChatResult,
  type ConnectionTestResult,
  type ConnectionTestStep,
  type ContentBlock,
  type DiscoveredModel,
  type StopReason,
  type StreamEvent,
  type StreamOptions,
  type TokenUsage,
  type Transport,
  type TransportConfig,
  type UnifiedMessage,
} from './types';
import { resolveThinkingBudget, validateAnthropicRequest } from './validate';

/** The version header Anthropic has required since 2023. */
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/**
 * Optional body keys the gateway may reject, in which case the request is retried
 * once without them. `max_tokens` is absent because the Anthropic API requires it.
 */
const ANTHROPIC_OPTIONAL_PARAMS = [
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'thinking',
  'tool_choice',
] as const;

export interface AnthropicTransportOptions extends TransportConfig {
  fetchImpl: FetchLike;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Overrides the default backoff. Set to `NO_RETRY_POLICY` for a single attempt. */
  retryPolicy?: RetryPolicy;
}

export class AnthropicTransport implements Transport {
  readonly kind = 'anthropic' as const;
  readonly baseUrl: string;

  private readonly http: HttpClient;

  constructor(options: AnthropicTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.http = new HttpClient({
      transport: 'anthropic',
      baseUrl: this.baseUrl,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      // The gateway issues Bearer tokens for both paths, so Bearer it is — even
      // though upstream Anthropic wants `x-api-key`.
      authHeader: 'bearer',
      headers: {
        'anthropic-version': options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
        ...(options.headers ?? {}),
      },
      ...(options.connectTimeoutMs !== undefined ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
      ...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Models                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * The gateway serves its model list from the OpenAI-shaped `/v1/models`, which
   * sits under this transport's bare origin. Same endpoint, reached from the other
   * side of the base-URL split.
   */
  async listModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const payload = await this.http.json<unknown>({
      path: '/v1/models',
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    return parseModelList(payload, this.http.url('/v1/models'));
  }

  /* ---------------------------------------------------------------------- */
  /* Streaming                                                               */
  /* ---------------------------------------------------------------------- */

  async *stream(request: ChatRequest, options: StreamOptions = {}): AsyncGenerator<StreamEvent, void, undefined> {
    const pending: StreamEvent[] = [];
    const send = this.buildSendOptions(request, true, options, pending);
    const state = createAnthropicStreamState();

    // Emitted before the request goes out, matching the OpenAI adapter, so a
    // consumer can open the assistant turn without knowing which transport is
    // active. `message_start` follows with the server's own id and model, and the
    // accumulator merges rather than replaces.
    yield { type: 'start', model: request.model };

    for await (const raw of this.http.sse(send)) {
      while (pending.length > 0) yield pending.shift() as StreamEvent;
      for (const event of translateAnthropicEvent(raw, state)) yield event;
    }
    while (pending.length > 0) yield pending.shift() as StreamEvent;

    if (!state.sawStop) yield { type: 'stop', reason: state.sawToolUse ? 'tool_use' : 'unknown' };
  }

  /* ---------------------------------------------------------------------- */
  /* Non-streaming                                                           */
  /* ---------------------------------------------------------------------- */

  async complete(request: ChatRequest, options: StreamOptions = {}): Promise<ChatResult> {
    const pending: StreamEvent[] = [];
    const send = this.buildSendOptions(request, false, options, pending);
    const payload = await this.http.json<AnthropicMessageResponse>(send);

    const accumulator = createResultAccumulator();
    for (const event of pending) accumulator.handle(event);
    accumulator.handle({
      type: 'start',
      ...(payload.id ? { id: payload.id } : {}),
      ...(payload.model ? { model: payload.model } : {}),
    });

    let toolIndex = 0;
    for (const block of payload.content ?? []) {
      switch (block.type) {
        case 'text':
          if (block.text) accumulator.handle({ type: 'text_delta', text: block.text });
          break;
        case 'thinking':
          if (block.thinking) accumulator.handle({ type: 'thinking_delta', text: block.thinking });
          if (block.signature) accumulator.handle({ type: 'thinking_signature', signature: block.signature });
          break;
        case 'redacted_thinking':
          if (block.data) accumulator.handle({ type: 'redacted_thinking', data: block.data });
          break;
        case 'tool_use': {
          const index = toolIndex;
          toolIndex += 1;
          accumulator.handle({
            type: 'tool_use_start',
            index,
            id: block.id ?? `toolu_${index}`,
            name: block.name ?? 'unknown',
          });
          accumulator.handle({ type: 'tool_use_delta', index, partialJson: JSON.stringify(block.input ?? {}) });
          accumulator.handle({ type: 'tool_use_stop', index });
          break;
        }
        default:
          break;
      }
    }

    if (payload.usage) accumulator.handle({ type: 'usage', usage: translateAnthropicUsage(payload.usage) });
    accumulator.handle({ type: 'stop', reason: translateStopReason(payload.stop_reason) });

    return accumulator.result();
  }

  /* ---------------------------------------------------------------------- */
  /* Token counting                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Exact input token count, when the gateway proxies Anthropic's endpoint.
   *
   * Expect a 404 here — most New API deployments don't forward it. Callers should
   * fall back to the local estimator rather than treat the failure as fatal.
   */
  async countTokens(request: ChatRequest, signal?: AbortSignal): Promise<number> {
    const body = buildAnthropicBody(request, false);
    delete body.max_tokens;
    delete body.stream;
    delete body.temperature;
    delete body.top_p;
    delete body.top_k;
    delete body.stop_sequences;

    const payload = await this.http.json<{ input_tokens?: number }>({
      path: '/v1/messages/count_tokens',
      method: 'POST',
      body,
      ...(signal ? { signal } : {}),
    });

    if (typeof payload.input_tokens !== 'number') {
      throw new GatewayError({
        kind: 'parse',
        message: 'count_tokens did not return an `input_tokens` number.',
        url: this.http.url('/v1/messages/count_tokens'),
      });
    }
    return payload.input_tokens;
  }

  /* ---------------------------------------------------------------------- */
  /* Connection test                                                         */
  /* ---------------------------------------------------------------------- */

  async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    const steps: ConnectionTestStep[] = [];

    const shapeIssue = describeBaseUrlIssue('anthropic', this.baseUrl);
    steps.push(
      shapeIssue
        ? { label: 'Base URL shape', status: 'failed', detail: shapeIssue }
        : {
            label: 'Base URL shape',
            status: 'ok',
            detail: `${this.baseUrl} — bare origin, as this transport requires. It appends /v1/messages itself.`,
          },
    );
    if (shapeIssue) {
      return { ok: false, steps, summary: 'The base URL is wrong for the Anthropic-compatible transport.' };
    }

    let models: DiscoveredModel[] | undefined;
    const modelsStarted = Date.now();
    try {
      models = await this.listModels(signal);
      steps.push({
        label: 'GET /v1/models',
        status: 'ok',
        detail: `${models.length} model${models.length === 1 ? '' : 's'} discovered.`,
        durationMs: Date.now() - modelsStarted,
      });
    } catch (error) {
      const gatewayError = error instanceof GatewayError ? error : GatewayError.wrap(error);
      steps.push({
        label: 'GET /v1/models',
        status: 'failed',
        detail: gatewayError.message,
        error: gatewayError,
        durationMs: Date.now() - modelsStarted,
      });
      // Model discovery is a convenience; /v1/messages is the transport. Keep going
      // with the known default so a missing model list doesn't mask a working path.
      steps.push({
        label: 'Model discovery fallback',
        status: 'ok',
        detail: 'Falling back to the built-in default claude-opus-4-6 for the message probe.',
      });
    }

    const probeModel = models && models.length > 0 ? pickProbeModel(models) : 'claude-opus-4-6';
    const chatStarted = Date.now();
    try {
      const result = await this.complete(
        {
          model: probeModel,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
          params: { maxTokens: 1 },
        },
        { ...(signal ? { signal } : {}) },
      );
      steps.push({
        label: 'POST /v1/messages',
        status: 'ok',
        detail: `${probeModel} answered. Reported ${result.usage.input} input / ${result.usage.output} output tokens.`,
        durationMs: Date.now() - chatStarted,
      });
    } catch (error) {
      const gatewayError = error instanceof GatewayError ? error : GatewayError.wrap(error);
      steps.push({
        label: 'POST /v1/messages',
        status: 'failed',
        detail: gatewayError.message,
        error: gatewayError,
        durationMs: Date.now() - chatStarted,
      });
      return {
        ok: false,
        steps,
        ...(models ? { models } : {}),
        summary: summariseFailure(gatewayError),
      };
    }

    return {
      ok: true,
      steps,
      ...(models ? { models } : {}),
      summary: models
        ? `Anthropic-compatible transport is working. ${models.length} models available.`
        : 'Anthropic-compatible transport is working, though the model list could not be read.',
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Body building                                                           */
  /* ---------------------------------------------------------------------- */

  private buildSendOptions(
    request: ChatRequest,
    streaming: boolean,
    options: StreamOptions,
    pending: StreamEvent[],
  ): SendOptions {
    const betas = request.wireHints?.betas;
    return {
      path: '/v1/messages',
      method: 'POST',
      body: buildAnthropicBody(request, streaming),
      optionalParams: ANTHROPIC_OPTIONAL_PARAMS,
      ...(betas?.length ? { extraHeaders: { 'anthropic-beta': betas.join(',') } } : {}),
      onParamDropped: (info: ParamDropInfo) => {
        pending.push({ type: 'param_dropped', param: info.param, message: info.message });
        options.onParamDropped?.(info.param, info.message);
      },
      ...(options.signal ? { signal: options.signal } : {}),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: AnthropicUsage;
}

interface AnthropicStreamFrame {
  type?: string;
  index?: number;
  message?: { id?: string; model?: string; usage?: AnthropicUsage };
  content_block?: AnthropicContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
  };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

/* -------------------------------------------------------------------------- */
/* Request translation                                                         */
/* -------------------------------------------------------------------------- */

export function buildAnthropicBody(request: ChatRequest, streaming: boolean): Record<string, unknown> {
  const report = validateAnthropicRequest(request);
  const firstError = report.errors[0];
  if (firstError) {
    // Caught here rather than paid for as a 400. The spec asks for these two
    // constraints to be validation, not an API round trip.
    throw validationError(firstError.message, 'Adjust the reasoning controls and send again.');
  }

  const { params, reasoning } = request;
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toAnthropicMessages(request.messages),
    max_tokens: params.maxTokens,
    stream: streaming,
  };

  if (request.system?.trim()) body.system = request.system;

  const budget = resolveThinkingBudget(reasoning, params.maxTokens);
  if (budget !== null) {
    body.thinking = { type: 'enabled', budget_tokens: budget };
  } else if (reasoning && !reasoning.enabled) {
    // Only sent when explicitly turned off; validation has already ruled out the
    // effort levels where `disabled` is a 400.
    body.thinking = { type: 'disabled' };
  }

  // Extended thinking pins temperature to 1, so sending anything else is a
  // rejection waiting to happen. Omit rather than override silently — the
  // validator has already warned about it.
  const thinkingOn = budget !== null;
  if (params.temperature !== undefined && !thinkingOn) body.temperature = params.temperature;
  if (params.topP !== undefined && !thinkingOn) body.top_p = params.topP;
  if (params.topK !== undefined && !thinkingOn) body.top_k = params.topK;
  if (params.stopSequences?.length) body.stop_sequences = params.stopSequences;

  // `seed`, `presence_penalty` and `frequency_penalty` have no Anthropic
  // equivalent. Dropped here; the UI greys them out on this transport.

  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
    if (request.toolChoice) {
      const choice = toAnthropicToolChoice(request.toolChoice);
      if (choice) body.tool_choice = choice;
    }
  }

  return { ...body, ...(request.extraBody ?? {}) };
}

function toAnthropicToolChoice(choice: NonNullable<ChatRequest['toolChoice']>): unknown | null {
  switch (choice.type) {
    case 'auto':
      return { type: 'auto' };
    case 'any':
      return { type: 'any' };
    case 'tool':
      return { type: 'tool', name: choice.name };
    case 'none':
      // Older API versions have no `none`; omitting `tools` is the caller's job if
      // they truly want tools off. Returning null omits the field.
      return { type: 'none' };
    default:
      return null;
  }
}

/**
 * Convert unified messages to the Anthropic wire shape.
 *
 * Adjacent same-role turns are merged, because tool results arrive as separate
 * unified messages but the API expects them batched into one user turn, and
 * strictly alternating roles.
 */
export function toAnthropicMessages(messages: UnifiedMessage[]): Record<string, unknown>[] {
  const out: { role: string; content: Record<string, unknown>[] }[] = [];

  for (const message of messages) {
    const blocks = message.content.flatMap(toAnthropicBlocks);
    // The API rejects an empty content array, so a message that translated to
    // nothing is skipped rather than sent hollow.
    if (blocks.length === 0) continue;

    const last = out[out.length - 1];
    if (last && last.role === message.role) {
      last.content.push(...blocks);
    } else {
      out.push({ role: message.role, content: blocks });
    }
  }

  return out.map((message) => ({ role: message.role, content: message.content }));
}

function toAnthropicBlocks(block: ContentBlock): Record<string, unknown>[] {
  switch (block.type) {
    case 'text':
      return block.text ? [{ type: 'text', text: block.text }] : [];

    case 'image':
      return [
        {
          type: 'image',
          source: { type: 'base64', media_type: block.mediaType, data: block.data },
        },
      ];

    case 'document': {
      // PDFs go native. Plain text uses the `text` source. Anything else falls back
      // to extracted text so the content still reaches the model.
      if (block.mediaType === 'application/pdf' && block.data) {
        return [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: block.data },
            ...(block.name ? { title: block.name } : {}),
          },
        ];
      }
      if (block.mediaType.startsWith('text/') && block.text) {
        return [
          {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: block.text },
            ...(block.name ? { title: block.name } : {}),
          },
        ];
      }
      if (block.text?.trim()) {
        const heading = block.name ? `--- ${block.name} (${block.mediaType}) ---\n` : '';
        return [{ type: 'text', text: `${heading}${block.text}` }];
      }
      return [
        {
          type: 'text',
          text:
            `[Attachment ${block.name ? `"${block.name}" ` : ''}(${block.mediaType}) could not be sent: ` +
            `no native document support for this type and no text was extracted.]`,
        },
      ];
    }

    case 'thinking': {
      // A thinking block replayed without its signature is a hard rejection, so an
      // unsigned one is dropped. Redacted thinking round-trips as its own block.
      if (block.redacted) return [{ type: 'redacted_thinking', data: block.redacted }];
      if (!block.signature || !block.text) return [];
      return [{ type: 'thinking', thinking: block.text, signature: block.signature }];
    }

    case 'tool_use':
      return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} }];

    case 'tool_result':
      return [
        {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: block.content,
          ...(block.isError ? { is_error: true } : {}),
        },
      ];

    default:
      return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Response translation                                                        */
/* -------------------------------------------------------------------------- */

export interface AnthropicStreamState {
  sawStop: boolean;
  sawToolUse: boolean;
  /** Wire block index → the kind of block open at that index. */
  blockKinds: Map<number, string>;
  /** Wire block index → local tool index, so tool indexes stay 0-based and dense. */
  toolIndexes: Map<number, number>;
  nextToolIndex: number;
}

export function createAnthropicStreamState(): AnthropicStreamState {
  return {
    sawStop: false,
    sawToolUse: false,
    blockKinds: new Map(),
    toolIndexes: new Map(),
    nextToolIndex: 0,
  };
}

/** Translate one raw SSE event into zero or more unified events. */
export function translateAnthropicEvent(raw: SseEvent, state: AnthropicStreamState): StreamEvent[] {
  const parsed = parseEventData<AnthropicStreamFrame>(raw);
  if (!parsed.ok) return [];

  const frame = parsed.value;
  // The `event:` line and the `type` field always agree in practice; the body wins
  // because it is what the API documents.
  const type = frame.type ?? raw.event;
  const events: StreamEvent[] = [];

  switch (type) {
    case 'error': {
      const message = frame.error?.message ?? 'The gateway reported an error mid-stream.';
      // Classified as `server` regardless of the reported type. It is retryable in
      // principle, but this arrives mid-stream where retrying would duplicate
      // already-rendered tokens, so the caller surfaces it instead.
      throw new GatewayError({
        kind: 'server',
        message,
        ...(frame.error?.type ? { gatewayType: frame.error.type } : {}),
        hint: 'Anything above this point is what actually arrived before the stream broke.',
      });
    }

    case 'message_start': {
      const message = frame.message;
      events.push({
        type: 'start',
        ...(message?.id ? { id: message.id } : {}),
        ...(message?.model ? { model: message.model } : {}),
      });
      if (message?.usage) events.push({ type: 'usage', usage: translateAnthropicUsage(message.usage) });
      break;
    }

    case 'content_block_start': {
      const index = frame.index ?? 0;
      const block = frame.content_block;
      const kind = block?.type ?? 'text';
      state.blockKinds.set(index, kind);

      if (kind === 'tool_use') {
        const local = state.nextToolIndex;
        state.nextToolIndex += 1;
        state.toolIndexes.set(index, local);
        state.sawToolUse = true;
        events.push({
          type: 'tool_use_start',
          index: local,
          id: block?.id ?? `toolu_${local}`,
          name: block?.name ?? '',
        });
      } else if (kind === 'redacted_thinking' && block?.data) {
        events.push({ type: 'redacted_thinking', data: block.data });
      } else if (kind === 'text' && block?.text) {
        // Rare, but a start frame can carry initial text.
        events.push({ type: 'text_delta', text: block.text });
      } else if (kind === 'thinking' && block?.thinking) {
        events.push({ type: 'thinking_delta', text: block.thinking });
      }
      break;
    }

    case 'content_block_delta': {
      const index = frame.index ?? 0;
      const delta = frame.delta;
      switch (delta?.type) {
        case 'text_delta':
          if (delta.text) events.push({ type: 'text_delta', text: delta.text });
          break;
        case 'thinking_delta':
          if (delta.thinking) events.push({ type: 'thinking_delta', text: delta.thinking });
          break;
        case 'signature_delta':
          if (delta.signature) events.push({ type: 'thinking_signature', signature: delta.signature });
          break;
        case 'input_json_delta': {
          const local = state.toolIndexes.get(index);
          if (local !== undefined && delta.partial_json) {
            events.push({ type: 'tool_use_delta', index: local, partialJson: delta.partial_json });
          }
          break;
        }
        default:
          // An unknown delta type is ignored rather than fatal: a new block kind
          // shouldn't kill an otherwise-good stream.
          break;
      }
      break;
    }

    case 'content_block_stop': {
      const index = frame.index ?? 0;
      const local = state.toolIndexes.get(index);
      if (local !== undefined) events.push({ type: 'tool_use_stop', index: local });
      state.blockKinds.delete(index);
      break;
    }

    case 'message_delta': {
      if (frame.usage) events.push({ type: 'usage', usage: translateAnthropicUsage(frame.usage) });
      const reason = frame.delta?.stop_reason;
      if (reason) {
        state.sawStop = true;
        events.push({ type: 'stop', reason: translateStopReason(reason) });
      }
      break;
    }

    case 'message_stop':
      // `message_delta` already carried the reason; this frame only closes the
      // stream. Emitting a second stop would double-count.
      break;

    case 'ping':
      break;

    default:
      break;
  }

  return events;
}

export function translateStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
      return 'tool_use';
    case 'pause_turn':
      return 'pause_turn';
    case 'refusal':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

/**
 * Anthropic folds thinking tokens into `output_tokens` and does not break them
 * out, so `thinking` stays undefined on this path rather than being guessed at.
 */
export function translateAnthropicUsage(usage: AnthropicUsage): Partial<TokenUsage> {
  const out: Partial<TokenUsage> = {};
  if (usage.input_tokens !== undefined) out.input = usage.input_tokens;
  if (usage.output_tokens !== undefined) out.output = usage.output_tokens;
  if (usage.cache_read_input_tokens !== undefined) out.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens !== undefined) out.cacheWrite = usage.cache_creation_input_tokens;
  return out;
}
