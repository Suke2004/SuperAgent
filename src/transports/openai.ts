/**
 * OpenAI-compatible transport.
 *
 *   Base URL **includes** `/v1`:  https://agentrouter.org/v1
 *   POST <base>/chat/completions
 *   GET  <base>/models
 *
 * Divergences from the Anthropic path that are resolved here, not in the UI:
 *
 *  - the system prompt is a `system` message, not a top-level field;
 *  - images are data URLs inside `image_url` blocks, not base64 `source` objects;
 *  - tool results are separate `role: "tool"` messages, not content blocks inside
 *    a user turn, so one unified message can expand into several wire messages;
 *  - streaming deltas are `choices[0].delta` patches rather than named
 *    content-block events;
 *  - stop reasons are `stop` / `length` / `tool_calls`;
 *  - reasoning arrives as `reasoning_content` (or `reasoning`) on the delta, and
 *    only on models that support it.
 */

import { GatewayError, validationError } from './errors';
import { HttpClient, type FetchLike, type ParamDropInfo, type SendOptions } from './http';
import type { RetryAttempt, RetryPolicy } from './retry';
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
} from './types';

/**
 * Optional body keys the gateway is allowed to reject, in which case the request
 * is retried once without them. `max_tokens` is deliberately absent: it isn't
 * optional, and a rejection there means a field *rename* (see `MAX_TOKENS_ALIAS`).
 */
const OPENAI_OPTIONAL_PARAMS = [
  'temperature',
  'top_p',
  'top_k',
  'stop',
  'seed',
  'presence_penalty',
  'frequency_penalty',
  'reasoning_effort',
  'stream_options',
  'tool_choice',
] as const;

/** Newer reasoning models reject `max_tokens` and want this instead. */
const MAX_TOKENS_ALIAS = 'max_completion_tokens';

export interface OpenAiTransportOptions extends TransportConfig {
  fetchImpl: FetchLike;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Overrides the default backoff. Set to `NO_RETRY_POLICY` for a single attempt. */
  retryPolicy?: RetryPolicy;
}

export class OpenAiTransport implements Transport {
  readonly kind = 'openai' as const;
  readonly baseUrl: string;

  /** The profile's configured model. Read by {@link testConnection} only. */
  private readonly defaultModel?: string;

  private readonly http: HttpClient;

  constructor(options: OpenAiTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (options.defaultModel) this.defaultModel = options.defaultModel;
    this.http = new HttpClient({
      transport: 'openai',
      baseUrl: this.baseUrl,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      authHeader: 'bearer',
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.connectTimeoutMs !== undefined ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
      ...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Models                                                                  */
  /* ---------------------------------------------------------------------- */

  async listModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const payload = await this.http.json<unknown>({
      path: '/models',
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    return parseModelList(payload, this.http.url('/models'));
  }

  /* ---------------------------------------------------------------------- */
  /* Streaming                                                               */
  /* ---------------------------------------------------------------------- */

  async *stream(request: ChatRequest, options: StreamOptions = {}): AsyncGenerator<StreamEvent, void, undefined> {
    const pending: StreamEvent[] = [];
    const send = this.buildSendOptions(request, true, options, pending);
    const state = createStreamState();

    yield { type: 'start', model: request.model };

    for await (const raw of this.streamWithMaxTokensFallback(send, pending)) {
      while (pending.length > 0) yield pending.shift() as StreamEvent;
      for (const event of translateChunk(raw, state)) yield event;
    }
    while (pending.length > 0) yield pending.shift() as StreamEvent;

    // Some gateways close without a finish_reason. Report what was observed rather
    // than inventing a reason.
    if (!state.sawStop) yield { type: 'stop', reason: state.sawToolCall ? 'tool_use' : 'unknown' };
  }

  /**
   * Retry once with `max_completion_tokens` when the gateway rejects `max_tokens`.
   *
   * This is a rename, not a drop: silently removing the output cap would let a
   * reasoning model burn the whole budget. The model registry can set
   * `wireHints.maxTokensField` to skip the failed first attempt entirely.
   */
  private async *streamWithMaxTokensFallback(
    send: SendOptions,
    pending: StreamEvent[],
  ): AsyncGenerator<SseEvent, void, undefined> {
    let fallback: Record<string, unknown> | null = null;
    try {
      yield* this.http.sse(send);
      return;
    } catch (error) {
      fallback = renameMaxTokens(error, send.body);
      if (!fallback) throw error;
      pending.push({
        type: 'param_dropped',
        param: 'max_tokens',
        message: `${(error as GatewayError).message} — retried as \`${MAX_TOKENS_ALIAS}\`.`,
      });
    }
    yield* this.http.sse({ ...send, body: fallback });
  }

  /* ---------------------------------------------------------------------- */
  /* Non-streaming                                                           */
  /* ---------------------------------------------------------------------- */

  async complete(request: ChatRequest, options: StreamOptions = {}): Promise<ChatResult> {
    const pending: StreamEvent[] = [];
    const send = this.buildSendOptions(request, false, options, pending);

    let payload: OpenAiCompletionResponse;
    try {
      payload = await this.http.json<OpenAiCompletionResponse>(send);
    } catch (error) {
      const renamed = renameMaxTokens(error, send.body);
      if (!renamed) throw error;
      pending.push({
        type: 'param_dropped',
        param: 'max_tokens',
        message: `${(error as GatewayError).message} — retried as \`${MAX_TOKENS_ALIAS}\`.`,
      });
      payload = await this.http.json<OpenAiCompletionResponse>({ ...send, body: renamed });
    }

    const accumulator = createResultAccumulator();
    for (const event of pending) accumulator.handle(event);
    accumulator.handle({
      type: 'start',
      ...(payload.id ? { id: payload.id } : {}),
      ...(payload.model ? { model: payload.model } : {}),
    });

    const choice = payload.choices?.[0];
    const message = choice?.message;
    const reasoning = message?.reasoning_content ?? message?.reasoning;
    if (typeof reasoning === 'string' && reasoning) {
      accumulator.handle({ type: 'thinking_delta', text: reasoning });
    }
    if (typeof message?.content === 'string' && message.content) {
      accumulator.handle({ type: 'text_delta', text: message.content });
    } else if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part?.text === 'string' && part.text) accumulator.handle({ type: 'text_delta', text: part.text });
      }
    }
    (message?.tool_calls ?? []).forEach((call, index) => {
      accumulator.handle({
        type: 'tool_use_start',
        index,
        id: call.id ?? `call_${index}`,
        name: call.function?.name ?? 'unknown',
      });
      if (call.function?.arguments) {
        accumulator.handle({ type: 'tool_use_delta', index, partialJson: call.function.arguments });
      }
      accumulator.handle({ type: 'tool_use_stop', index });
    });
    if (payload.usage) accumulator.handle({ type: 'usage', usage: translateUsage(payload.usage) });
    accumulator.handle({ type: 'stop', reason: translateFinishReason(choice?.finish_reason) });

    return accumulator.result();
  }

  /* ---------------------------------------------------------------------- */
  /* Connection test                                                         */
  /* ---------------------------------------------------------------------- */

  async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    const steps: ConnectionTestStep[] = [];

    // Step 1: the base URL shape. This is the mistake that wastes the most time,
    // so it is checked before a single byte goes out.
    const shapeIssue = describeBaseUrlIssue('openai', this.baseUrl);
    steps.push(
      shapeIssue
        ? { label: 'Base URL shape', status: 'failed', detail: shapeIssue }
        : {
            label: 'Base URL shape',
            status: 'ok',
            detail: `${this.baseUrl} — ends in /v1, as this transport requires.`,
          },
    );
    if (shapeIssue) {
      return { ok: false, steps, summary: 'The base URL is wrong for the OpenAI-compatible transport.' };
    }

    // Step 2: list models. Proves reachability, auth, and the client allowlist.
    let models: DiscoveredModel[] | undefined;
    const modelsStarted = Date.now();
    try {
      models = await this.listModels(signal);
      steps.push({
        label: 'GET /models',
        status: 'ok',
        detail: `${models.length} model${models.length === 1 ? '' : 's'} discovered.`,
        durationMs: Date.now() - modelsStarted,
      });
    } catch (error) {
      const gatewayError = error instanceof GatewayError ? error : GatewayError.wrap(error);
      steps.push({
        label: 'GET /models',
        status: 'failed',
        detail: gatewayError.message,
        error: gatewayError,
        durationMs: Date.now() - modelsStarted,
      });
      steps.push({
        label: 'POST /chat/completions',
        status: 'skipped',
        detail: 'Skipped: model discovery failed first.',
      });
      return { ok: false, steps, summary: summariseFailure(gatewayError) };
    }

    // Step 3: a one-token completion. Model discovery can succeed while the chat
    // path fails, so only this proves the transport works end to end. The probe
    // uses the profile's configured model when the gateway lists it — probing
    // something else turns a working setup into a 403 the user cannot explain.
    const chatStarted = Date.now();
    let probeModel: string;
    try {
      probeModel = pickProbeModel(models, this.defaultModel);
    } catch (error) {
      const gatewayError = error instanceof GatewayError ? error : GatewayError.wrap(error);
      steps.push({
        label: 'POST /chat/completions',
        status: 'failed',
        detail: gatewayError.message,
        error: gatewayError,
      });
      return { ok: false, steps, models, summary: gatewayError.message };
    }

    if (this.defaultModel && probeModel !== this.defaultModel) {
      steps.push({
        label: 'Configured model',
        status: 'failed',
        detail:
          `${this.defaultModel} is not in the gateway's model list, so it would fail with a permission error. ` +
          `Probing ${probeModel} instead — switch the profile to a listed model.`,
      });
    }

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
        label: 'POST /chat/completions',
        status: 'ok',
        detail: `${probeModel} answered. Reported ${result.usage.input} input / ${result.usage.output} output tokens.`,
        durationMs: Date.now() - chatStarted,
      });
    } catch (error) {
      const gatewayError = error instanceof GatewayError ? error : GatewayError.wrap(error);
      steps.push({
        label: 'POST /chat/completions',
        status: 'failed',
        detail: gatewayError.message,
        error: gatewayError,
        durationMs: Date.now() - chatStarted,
      });
      return {
        ok: false,
        steps,
        models,
        probedModel: probeModel,
        summary: `Model discovery worked but ${probeModel} could not be called: ${gatewayError.message}`,
      };
    }

    return {
      ok: true,
      steps,
      models,
      probedModel: probeModel,
      summary: `OpenAI-compatible transport is working. ${models.length} models available.`,
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
    return {
      path: '/chat/completions',
      method: 'POST',
      body: buildOpenAiBody(request, streaming),
      optionalParams: OPENAI_OPTIONAL_PARAMS,
      onParamDropped: (info: ParamDropInfo) => {
        pending.push({ type: 'param_dropped', param: info.param, message: info.message });
        options.onParamDropped?.(info.param, info.message);
      },
      ...(options.onRetry
        ? {
            onRetry: (info: RetryAttempt) =>
              options.onRetry?.({ attempt: info.attempt, delayMs: info.delayMs, message: info.error.message }),
          }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

interface OpenAiToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiMessage {
  role?: string;
  content?: string | { type?: string; text?: string }[] | null;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: OpenAiToolCall[];
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
  cache_creation_input_tokens?: number;
}

interface OpenAiCompletionResponse {
  id?: string;
  model?: string;
  choices?: { index?: number; message?: OpenAiMessage; finish_reason?: string | null }[];
  usage?: OpenAiUsage;
}

interface OpenAiStreamChunk {
  id?: string;
  model?: string;
  choices?: { index?: number; delta?: OpenAiMessage; finish_reason?: string | null }[];
  usage?: OpenAiUsage | null;
  error?: unknown;
}

/* -------------------------------------------------------------------------- */
/* Request translation                                                         */
/* -------------------------------------------------------------------------- */

export function buildOpenAiBody(request: ChatRequest, streaming: boolean): Record<string, unknown> {
  const { params, reasoning } = request;
  const maxTokensField = request.wireHints?.maxTokensField ?? 'max_tokens';

  const body: Record<string, unknown> = {
    model: request.model,
    messages: toOpenAiMessages(request),
    [maxTokensField]: params.maxTokens,
    stream: streaming,
  };

  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.stopSequences?.length) body.stop = params.stopSequences;
  if (params.seed !== undefined) body.seed = params.seed;
  if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
  if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;

  // `top_k` isn't part of the OpenAI schema; sent only when explicitly set, since
  // some gateways accept it as an extension. It's in the droppable list.
  if (params.topK !== undefined) body.top_k = params.topK;

  // Reasoning effort is only meaningful on models flagged reasoning-capable; the
  // caller decides that and omits `reasoning` otherwise.
  if (reasoning?.enabled && reasoning.effort) body.reasoning_effort = reasoning.effort;

  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
    if (request.toolChoice) body.tool_choice = toOpenAiToolChoice(request.toolChoice);
  }

  // Usage must come from the API rather than an estimate, so ask for it.
  if (streaming) body.stream_options = { include_usage: true };

  return { ...body, ...(request.extraBody ?? {}) };
}

function toOpenAiToolChoice(choice: NonNullable<ChatRequest['toolChoice']>): unknown {
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'none':
      return 'none';
    case 'any':
      return 'required';
    case 'tool':
      return { type: 'function', function: { name: choice.name } };
    default:
      return 'auto';
  }
}

/**
 * Flatten unified messages into the OpenAI wire shape.
 *
 * One unified message can become several wire messages: tool results must each be
 * their own `role: "tool"` entry and cannot be nested inside a user turn the way
 * Anthropic nests them.
 */
export function toOpenAiMessages(request: ChatRequest): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (request.system?.trim()) out.push({ role: 'system', content: request.system });

  for (const message of request.messages) {
    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool_result' }> => block.type === 'tool_result',
    );
    const toolUses = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
    );
    const rest = message.content.filter((block) => block.type !== 'tool_result' && block.type !== 'tool_use');

    // Tool results come first: they answer the previous assistant turn.
    for (const block of toolResults) {
      out.push({
        role: 'tool',
        tool_call_id: block.toolUseId,
        content: block.isError ? `ERROR: ${block.content}` : block.content,
      });
    }

    const parts = rest.flatMap(toOpenAiContentParts);
    const hasParts = parts.length > 0;

    if (message.role === 'assistant') {
      if (!hasParts && toolUses.length === 0) continue;
      const entry: Record<string, unknown> = { role: 'assistant' };
      // `content` must be present even when empty, or some gateways reject the turn.
      entry.content = hasParts ? collapseParts(parts) : '';
      if (toolUses.length > 0) {
        entry.tool_calls = toolUses.map((block) => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        }));
      }
      out.push(entry);
      continue;
    }

    if (!hasParts) continue;
    out.push({ role: 'user', content: collapseParts(parts) });
  }

  return out;
}

/**
 * A lone text part is sent as a bare string rather than a one-element array;
 * several proxies in front of older models only accept the string form.
 */
function collapseParts(parts: Record<string, unknown>[]): unknown {
  const only = parts[0];
  if (parts.length === 1 && only?.type === 'text') return only.text;
  return parts;
}

function toOpenAiContentParts(block: ContentBlock): Record<string, unknown>[] {
  switch (block.type) {
    case 'text':
      return block.text ? [{ type: 'text', text: block.text }] : [];

    case 'image':
      // Data URL, not a base64 `source` object — the encoding difference between
      // the two transports.
      return [{ type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.data}` } }];

    case 'document': {
      // No native document block on this path; text is extracted on device. If
      // extraction produced nothing, say so in the transcript rather than sending
      // an empty turn and leaving the model to guess.
      if (block.text?.trim()) {
        const heading = block.name ? `--- ${block.name} (${block.mediaType}) ---\n` : '';
        return [{ type: 'text', text: `${heading}${block.text}` }];
      }
      return [
        {
          type: 'text',
          text:
            `[Attachment ${block.name ? `"${block.name}" ` : ''}(${block.mediaType}) could not be converted ` +
            `to text on this device, so it was not sent.]`,
        },
      ];
    }

    case 'thinking':
      // Reasoning is display-only on this path: replaying it as visible text would
      // confuse the model and pay for the tokens twice.
      return [];

    default:
      return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Response translation                                                        */
/* -------------------------------------------------------------------------- */

export interface OpenAiStreamState {
  sawStop: boolean;
  sawToolCall: boolean;
  /** Wire index → stable local index, since some gateways omit `index`. */
  toolIndexes: Map<number, number>;
  /** Local index → the name seen so far, so a repeated id doesn't re-announce. */
  toolNames: Map<number, string>;
  nextToolIndex: number;
  openToolIndexes: Set<number>;
}

export function createStreamState(): OpenAiStreamState {
  return {
    sawStop: false,
    sawToolCall: false,
    toolIndexes: new Map(),
    toolNames: new Map(),
    nextToolIndex: 0,
    openToolIndexes: new Set(),
  };
}

/** Translate one raw SSE event into zero or more unified events. */
export function translateChunk(raw: SseEvent, state: OpenAiStreamState): StreamEvent[] {
  const parsed = parseEventData<OpenAiStreamChunk>(raw);
  if (!parsed.ok) {
    // `[DONE]` and malformed frames are both non-fatal: one ends the stream, the
    // other costs a single token rather than the whole reply.
    return [];
  }

  const chunk = parsed.value;
  const events: StreamEvent[] = [];

  // An error can arrive inside a 200 stream on some gateways.
  if (chunk.error) {
    throw new GatewayError({
      kind: 'server',
      message: extractEmbeddedErrorMessage(chunk.error),
      hint: 'The gateway reported an error mid-stream. Anything above this point is what actually arrived.',
    });
  }

  if (chunk.id || chunk.model) {
    events.push({
      type: 'start',
      ...(chunk.id ? { id: chunk.id } : {}),
      ...(chunk.model ? { model: chunk.model } : {}),
    });
  }

  const choice = chunk.choices?.[0];
  const delta = choice?.delta;

  const reasoning = delta?.reasoning_content ?? delta?.reasoning;
  if (typeof reasoning === 'string' && reasoning) events.push({ type: 'thinking_delta', text: reasoning });

  if (typeof delta?.content === 'string' && delta.content) {
    events.push({ type: 'text_delta', text: delta.content });
  } else if (Array.isArray(delta?.content)) {
    for (const part of delta.content) {
      if (typeof part?.text === 'string' && part.text) events.push({ type: 'text_delta', text: part.text });
    }
  }

  for (const call of delta?.tool_calls ?? []) {
    const wireIndex = call.index ?? 0;
    const name = call.function?.name ?? '';
    let index = state.toolIndexes.get(wireIndex);
    if (index === undefined) {
      index = state.nextToolIndex;
      state.nextToolIndex += 1;
      state.toolIndexes.set(wireIndex, index);
      state.toolNames.set(index, name);
      state.openToolIndexes.add(index);
      state.sawToolCall = true;
      events.push({ type: 'tool_use_start', index, id: call.id ?? `call_${index}`, name });
    } else if (name && !state.toolNames.get(index)) {
      // Some gateways send the name on a later delta than the first. Only re-announce
      // when the name is genuinely new: several repeat the id on *every* delta, and
      // re-firing the start event on each one would reset the arguments downstream.
      state.toolNames.set(index, name);
      events.push({ type: 'tool_use_start', index, id: call.id ?? `call_${index}`, name });
    }
    if (call.function?.arguments) {
      events.push({ type: 'tool_use_delta', index, partialJson: call.function.arguments });
    }
  }

  if (chunk.usage) events.push({ type: 'usage', usage: translateUsage(chunk.usage) });

  if (choice?.finish_reason) {
    for (const index of state.openToolIndexes) events.push({ type: 'tool_use_stop', index });
    state.openToolIndexes.clear();
    state.sawStop = true;
    events.push({ type: 'stop', reason: translateFinishReason(choice.finish_reason) });
  }

  return events;
}

function extractEmbeddedErrorMessage(embedded: unknown): string {
  if (typeof embedded === 'string') return embedded;
  if (embedded && typeof embedded === 'object') {
    const message = (embedded as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
    return JSON.stringify(embedded);
  }
  return String(embedded);
}

/**
 * `stop` covers both a natural end and a stop sequence on this path — the API
 * doesn't distinguish them, so neither can we without guessing.
 */
export function translateFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

export function translateUsage(usage: OpenAiUsage): Partial<TokenUsage> {
  const out: Partial<TokenUsage> = {};
  if (usage.prompt_tokens !== undefined) out.input = usage.prompt_tokens;
  if (usage.completion_tokens !== undefined) out.output = usage.completion_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined) out.thinking = reasoning;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined) out.cacheRead = cached;
  if (usage.cache_creation_input_tokens !== undefined) out.cacheWrite = usage.cache_creation_input_tokens;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

export function parseModelList(payload: unknown, url: string): DiscoveredModel[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null;

  if (!rows) {
    throw new GatewayError({
      kind: 'parse',
      message: 'The model list did not contain a `data` array.',
      hint: 'Open the debug log to see what the gateway actually returned for /models.',
      url,
    });
  }

  const models: DiscoveredModel[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      models.push({ id: row });
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : typeof record.model === 'string' ? record.model : undefined;
    if (!id) continue;
    const model: DiscoveredModel = { id };
    if (typeof record.owned_by === 'string') model.ownedBy = record.owned_by;
    if (typeof record.created === 'number') model.created = record.created;
    const extra = { ...record };
    delete extra.id;
    delete extra.owned_by;
    delete extra.created;
    delete extra.object;
    if (Object.keys(extra).length > 0) model.extra = extra;
    models.push(model);
  }

  // Stable, case-insensitive ordering so the picker doesn't reshuffle per refresh.
  return models.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }));
}

/**
 * Explain a base-URL/transport mismatch, or return null when it's fine.
 *
 * Exported so the settings screen can warn before the user hits send, rather than
 * making them decode a 404.
 */
export function describeBaseUrlIssue(kind: 'openai' | 'anthropic', baseUrl: string): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return 'The base URL is empty.';
  if (!/^https?:\/\//i.test(trimmed)) return `"${trimmed}" needs an http:// or https:// scheme.`;

  const endsWithV1 = /\/v\d+$/i.test(trimmed);
  if (kind === 'openai' && !endsWithV1) {
    return (
      `The OpenAI-compatible transport posts to <base>/chat/completions, so its base URL must end in /v1 — ` +
      `try "${trimmed}/v1". Only the Anthropic transport takes the bare origin.`
    );
  }
  if (kind === 'anthropic' && endsWithV1) {
    return (
      `The Anthropic-compatible transport appends /v1/messages itself, so its base URL must be the bare origin ` +
      `with no /v1 — try "${trimmed.replace(/\/v\d+$/i, '')}". Only the OpenAI transport takes the /v1 suffix.`
    );
  }
  return null;
}

/**
 * The model the connection test should probe.
 *
 * `preferred` is the profile's configured model, and it wins whenever the gateway
 * actually lists it — testing anything else answers a question nobody asked. When
 * it is not on the list the first discovered id is used instead, because a gateway
 * that serves four models and none of them the built-in default is a gateway that
 * works; reporting `403 Forbidden` for it would be a lie about the key.
 *
 * The `claude-` preference only breaks ties among discovered ids: this app exists
 * for the Claude path, so where the gateway offers both, that is the more useful
 * thing to have proved.
 */
export function pickProbeModel(models: DiscoveredModel[], preferred?: string): string {
  const wanted = preferred?.trim();
  if (wanted && models.some((model) => model.id === wanted)) return wanted;
  const claude = models.find((model) => model.id.startsWith('claude-'));
  if (claude) return claude.id;
  const first = models[0];
  if (first) return first.id;
  throw validationError(
    'The gateway returned an empty model list, so there is nothing to test against.',
    'Check that the token has at least one model enabled in the gateway console.',
  );
}

export function summariseFailure(error: GatewayError): string {
  switch (error.kind) {
    case 'client_rejected':
      return 'The gateway rejected this client, not the key. The token may be fine — the app needs allowlisting.';
    case 'key_rejected':
      return 'The gateway rejected the API key. Verify it in the gateway console and re-paste it.';
    case 'network':
      return 'Could not reach the gateway at all. Check connectivity, or try the backup domain.';
    case 'content_blocked':
      // A bare "Bad request (400)" here is the exact failure the language
      // restriction produces, and it reads as a bug in the app. Name the cause.
      return error.hint ? `${error.message} ${error.hint}` : error.message;
    default:
      return `${error.summary}: ${error.message}`;
  }
}

/**
 * If the failure was about `max_tokens`, return the body with the field renamed.
 * Returns null when the error is unrelated or the rename would change nothing.
 */
function renameMaxTokens(error: unknown, body: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!(error instanceof GatewayError) || !body) return null;
  if (!('max_tokens' in body)) return null;
  if (error.param !== 'max_tokens' && !/max_tokens/.test(error.message)) return null;
  if (error.kind !== 'unsupported_param' && error.kind !== 'bad_request') return null;

  const renamed = { ...body };
  renamed[MAX_TOKENS_ALIAS] = renamed.max_tokens;
  delete renamed.max_tokens;
  return renamed;
}
