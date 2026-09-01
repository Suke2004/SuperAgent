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
import type { RetryAttempt, RetryPolicy } from './retry';
import { parseEventData, type SseEvent } from './sse';
import {
  createResultAccumulator,
  type ChatRequest,
  type ChatResult,
  type Citation,
  type ConnectionTestResult,
  type ConnectionTestStep,
  type ContentBlock,
  type DiscoveredModel,
  type ServerToolBlock,
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
 * Last-resort probe model, used only when discovery failed *and* the profile has
 * no configured model. A gateway that hides `/v1/models` still has to be probed
 * with something, and a Claude id is the likeliest to exist on this path.
 *
 * Not a fallback for a *configured* model: probing something other than what the
 * profile is set to is how a working key gets reported as `403 Forbidden`.
 */
const LAST_RESORT_PROBE_MODEL = 'claude-opus-4-6';

function fallbackProbeModel(configured: string | undefined): string {
  const wanted = configured?.trim();
  return wanted ? wanted : LAST_RESORT_PROBE_MODEL;
}

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

  /** The profile's configured model. Read by {@link testConnection} only. */
  private readonly defaultModel?: string;

  private readonly http: HttpClient;

  constructor(options: AnthropicTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (options.defaultModel) this.defaultModel = options.defaultModel;
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
    // A provider-side call and its result are two blocks that have to travel back as
    // one, keyed on the id that pairs them.
    const pendingServerTools = new Map<string, Record<string, unknown>[]>();
    for (const block of payload.content ?? []) {
      switch (block.type) {
        case 'text':
          if (block.text) accumulator.handle({ type: 'text_delta', text: block.text });
          for (const citation of citationsOf(block)) accumulator.handle({ type: 'citation', citation });
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
          if (block.type === SERVER_TOOL_USE) {
            pendingServerTools.set(block.id ?? '', [block as unknown as Record<string, unknown>]);
          } else if (block.type && SERVER_TOOL_RESULTS.has(block.type)) {
            accumulator.handle(
              serverToolEvent(pendingServerTools, block as unknown as Record<string, unknown>, block.tool_use_id ?? ''),
            );
          }
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
      // with the configured model so a missing model list doesn't mask a working path.
      steps.push({
        label: 'Model discovery fallback',
        status: 'ok',
        detail: `Falling back to ${fallbackProbeModel(this.defaultModel)} for the message probe.`,
      });
    }

    const probeModel =
      models && models.length > 0
        ? pickProbeModel(models, this.defaultModel)
        : fallbackProbeModel(this.defaultModel);

    if (models && models.length > 0 && this.defaultModel && probeModel !== this.defaultModel) {
      steps.push({
        label: 'Configured model',
        status: 'failed',
        detail:
          `${this.defaultModel} is not in the gateway's model list, so it would fail with a permission error. ` +
          `Probing ${probeModel} instead — switch the profile to a listed model.`,
      });
    }

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
        probedModel: probeModel,
        summary: summariseFailure(gatewayError),
      };
    }

    return {
      ok: true,
      steps,
      ...(models ? { models } : {}),
      probedModel: probeModel,
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
      ...(options.onRetry
        ? {
            onRetry: (info: RetryAttempt) =>
              options.onRetry?.({ attempt: info.attempt, delayMs: info.delayMs, message: info.error.message }),
          }
        : {}),
      ...(options.onRequest ? { onRequest: options.onRequest } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

/** The block kinds a provider-side tool produces, paired by `tool_use_id`. */
const SERVER_TOOL_USE = 'server_tool_use';
const SERVER_TOOL_RESULTS = new Set(['web_search_tool_result']);

/**
 * One {@link ServerToolBlock} from the provider's own wire blocks.
 *
 * `raw` is kept byte-for-byte as it arrived, in order: the API rejects a
 * `web_search_tool_result` whose `tool_use_id` no longer matches the
 * `server_tool_use` before it, so this is the one block kind that must not be
 * normalised. Everything else here is derived for display only, defensively —
 * `input` and `content` are provider JSON, not a shape this app authored.
 */
export function toServerToolBlock(raw: Record<string, unknown>[]): ServerToolBlock {
  const use = raw.find((block) => block.type === SERVER_TOOL_USE);
  const query = (use?.input as { query?: unknown } | undefined)?.query;
  const sources: { title?: string; url: string }[] = [];
  for (const block of raw) {
    if (!Array.isArray(block.content)) continue;
    for (const item of block.content as unknown[]) {
      const url = (item as { url?: unknown }).url;
      if (typeof url !== 'string' || !url) continue;
      const title = (item as { title?: unknown }).title;
      sources.push({ url, ...(typeof title === 'string' && title ? { title } : {}) });
    }
  }
  return {
    type: 'server_tool',
    transport: 'anthropic',
    name: typeof use?.name === 'string' && use.name ? use.name : 'web_search',
    raw,
    ...(typeof query === 'string' && query ? { summary: `Searched the web for “${query}”` } : {}),
    ...(sources.length ? { sources } : {}),
  };
}

/**
 * A finished provider-side pair as one event.
 *
 * An unpaired result is displayed but not replayed: `raw` is emptied, because the
 * API rejects a `web_search_tool_result` with no matching `server_tool_use` before
 * it, and a stream that lost the call frame would otherwise poison every later turn
 * in the conversation.
 */
function serverToolEvent(
  pending: Map<string, Record<string, unknown>[]>,
  result: Record<string, unknown>,
  id: string,
): StreamEvent {
  const use = pending.get(id);
  pending.delete(id);
  const block = toServerToolBlock(use ? [...use, result] : [result]);
  return { type: 'server_tool', block: use ? block : { ...block, raw: [] } };
}

/**
 * One {@link Citation} from a provider citation object, or `null`.
 *
 * Defensive for the same reason {@link toServerToolBlock} is: this is third-party
 * JSON reached through the model. A citation with no URL is dropped rather than
 * rendered as an unopenable row.
 */
export function toCitation(value: unknown): Citation | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as { url?: unknown; title?: unknown; cited_text?: unknown };
  if (typeof record.url !== 'string' || !record.url) return null;
  return {
    url: record.url,
    ...(typeof record.title === 'string' && record.title ? { title: record.title } : {}),
    ...(typeof record.cited_text === 'string' && record.cited_text ? { citedText: record.cited_text } : {}),
  };
}

/** The citations on one non-streamed text block, skipping anything unusable. */
function citationsOf(block: AnthropicContentBlock): Citation[] {
  if (!Array.isArray(block.citations)) return [];
  return block.citations.map(toCitation).filter((citation): citation is Citation => citation !== null);
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
  /** `web_search_tool_result` only: the `server_tool_use` this answers. */
  tool_use_id?: string;
  /** `web_search_tool_result` only: the pages found, or an error object. */
  content?: unknown;
  /** `text` only: sources the model attributed this block to. */
  citations?: unknown;
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
    /** `citations_delta` only: one citation object. */
    citation?: unknown;
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
    messages: toAnthropicMessages(request.messages, request.cache?.historyThrough),
    max_tokens: params.maxTokens,
    stream: streaming,
  };

  // A marked system prompt has to be sent in block form: `cache_control` is a
  // property of a content block, and the string form has nowhere to put it.
  if (request.system?.trim()) {
    body.system = request.cache?.system
      ? [{ type: 'text', text: request.system, cache_control: EPHEMERAL }]
      : request.system;
  }

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
    const tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
    // One marker on the last definition caches the whole manifest: breakpoints are
    // cumulative over everything before them in the prefix, and `tools` is first.
    if (request.cache?.tools) {
      const last = tools[tools.length - 1];
      if (last) Object.assign(last, { cache_control: EPHEMERAL });
    }
    body.tools = tools;
    if (request.toolChoice) {
      const choice = toAnthropicToolChoice(request.toolChoice);
      if (choice) body.tool_choice = choice;
    }
  }

  // Prepended, not appended. The cache marker above goes on the *last* entry, so a
  // server tool added after it would sit outside the cached prefix and break the
  // byte-identical prefix the whole caching design depends on. First also keeps the
  // order stable across turns, which is the other half of that requirement.
  const webSearch = request.serverTools?.webSearch;
  if (webSearch) {
    const definition: Record<string, unknown> = { type: WEB_SEARCH_TOOL, name: 'web_search' };
    if (webSearch.maxUses !== undefined) definition.max_uses = webSearch.maxUses;
    body.tools = [definition, ...((body.tools as unknown[]) ?? [])];
  }

  return { ...body, ...(request.extraBody ?? {}) };
}

/** The versioned name the API knows the server-side search tool by. */
export const WEB_SEARCH_TOOL = 'web_search_20250305';

/** The only cache type the API offers. Named so the three call sites cannot drift. */
const EPHEMERAL = { type: 'ephemeral' } as const;

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
 *
 * `cacheThrough` is an index into `messages`: the last block of the wire message
 * that ends at or before it gets a `cache_control` marker. "Ends at or before" is
 * the load-bearing part — if the requested message merged with a later one, marking
 * that wire message would cache more of the tail than the planner intended, and on
 * the common path that tail is the message the user just typed, so the entry would
 * be written fresh every turn and never read. Stepping back to the previous wire
 * message caches slightly less and caches it repeatedly, which is the whole point.
 */
export function toAnthropicMessages(
  messages: UnifiedMessage[],
  cacheThrough?: number,
): Record<string, unknown>[] {
  const out: { role: string; content: Record<string, unknown>[]; through: number }[] = [];

  for (const [index, message] of messages.entries()) {
    const blocks = message.content.flatMap(toAnthropicBlocks);
    // The API rejects an empty content array, so a message that translated to
    // nothing is skipped rather than sent hollow.
    if (blocks.length === 0) continue;

    const last = out[out.length - 1];
    if (last && last.role === message.role) {
      last.content.push(...blocks);
      last.through = index;
    } else {
      out.push({ role: message.role, content: blocks, through: index });
    }
  }

  if (cacheThrough !== undefined) {
    // The last wire message wholly inside the requested prefix.
    let target: (typeof out)[number] | undefined;
    for (const candidate of out) {
      if (candidate.through <= cacheThrough) target = candidate;
      else break;
    }
    const block = target?.content[target.content.length - 1];
    if (block) Object.assign(block, { cache_control: EPHEMERAL });
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
          // A string is the common shape and the cheaper one to read in a log; the
          // array form is only used when there is an image to carry alongside it.
          content: block.images?.length
            ? [
                { type: 'text', text: block.content },
                ...block.images.map((image) => ({
                  type: 'image' as const,
                  source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
                })),
              ]
            : block.content,
          ...(block.isError ? { is_error: true } : {}),
        },
      ];

    case 'server_tool':
      // Replayed exactly as it arrived, and only on the transport that produced it:
      // a `web_search_tool_result` whose `tool_use_id` no longer matches the
      // `server_tool_use` before it is a 400, and another provider has never heard
      // of either block kind.
      return block.transport === 'anthropic' ? block.raw : [];

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
  /**
   * Provider-side calls whose arguments are still streaming, by wire index.
   *
   * Kept apart from `toolIndexes` on purpose: these are not tools this app can run,
   * so they must never be handed to the tool loop as something to answer.
   */
  serverToolOpen: Map<number, { id: string; name: string; json: string }>;
  /** Finished `server_tool_use` blocks waiting for the result that pairs with them. */
  serverToolPending: Map<string, Record<string, unknown>[]>;
}

export function createAnthropicStreamState(): AnthropicStreamState {
  return {
    sawStop: false,
    sawToolUse: false,
    blockKinds: new Map(),
    toolIndexes: new Map(),
    nextToolIndex: 0,
    serverToolOpen: new Map(),
    serverToolPending: new Map(),
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
      } else if (kind === SERVER_TOOL_USE) {
        state.serverToolOpen.set(index, { id: block?.id ?? '', name: block?.name ?? 'web_search', json: '' });
      } else if (SERVER_TOOL_RESULTS.has(kind)) {
        // The result arrives whole rather than as deltas, so the pair is complete here.
        events.push(
          serverToolEvent(state.serverToolPending, block as unknown as Record<string, unknown>, block?.tool_use_id ?? ''),
        );
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
        case 'citations_delta': {
          const citation = toCitation(delta.citation);
          if (citation) events.push({ type: 'citation', citation });
          break;
        }
        case 'input_json_delta': {
          const local = state.toolIndexes.get(index);
          if (local !== undefined && delta.partial_json) {
            events.push({ type: 'tool_use_delta', index: local, partialJson: delta.partial_json });
            break;
          }
          const open = state.serverToolOpen.get(index);
          if (open && delta.partial_json) open.json += delta.partial_json;
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
      const open = state.serverToolOpen.get(index);
      if (open) {
        state.serverToolOpen.delete(index);
        // Arguments that never finished cannot be replayed, so the call is not
        // remembered; the result frame then shows without a replayable pair.
        // `safeParseJson` is deliberately not used: its `_raw` fallback exists so a
        // broken tool call can be reported to the model, and this block goes back on
        // the wire instead.
        try {
          const input: unknown = open.json.trim() ? JSON.parse(open.json) : {};
          state.serverToolPending.set(open.id, [
            { type: SERVER_TOOL_USE, id: open.id, name: open.name, input },
          ]);
        } catch {
          // Left unpaired on purpose.
        }
      }
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
