/**
 * Chat state.
 *
 * SQLite is the source of truth; this store is a reactive cache over it plus the
 * transient state a stream needs while it is running. Nothing here is persisted
 * through `zustand/persist` — a half-written stream should not survive a restart,
 * and everything that should survive is already a row.
 *
 * The one performance-critical decision: token deltas are accumulated into a
 * mutable object and published to the store on a timer rather than per event. A
 * fast model emits well over a hundred deltas a second, and a `set()` per delta
 * re-renders the transcript at that rate — which is exactly the "long code blocks
 * tank scroll performance" failure, arriving from the other direction.
 */

import { create } from 'zustand';

import {
  appendMessage,
  createConversation,
  DEFAULT_TITLE,
  deleteMessage as dbDeleteMessage,
  deleteMessagesFrom,
  deriveTitle,
  flattenContent,
  forkConversation,
  getConversation,
  listConversations,
  listMessages,
  recordUsage,
  setPinned as dbSetPinned,
  setTags as dbSetTags,
  updateConversation,
  updateMessage,
  deleteConversation as dbDeleteConversation,
} from '@/db/conversations';
import type {
  Conversation,
  ConversationConfig,
  ListOptions,
  MessageMeta,
  StoredMessage,
} from '@/db/conversations';
import { buildRequest, SUMMARY_INSTRUCTION, validateConfig, hasBlockingIssue } from '@/chat/request';
import { invalidateTransports, resolveTransport } from '@/lib/gateway';
import { log } from '@/lib/log';
import { estimateMessageTokens, estimateRequestTokens, selectMessagesWithinBudget } from '@/lib/tokens';
import { capabilitiesFor, useModels, wireHintsFor } from '@/stores/models';
import { useCalibration } from '@/stores/calibration';import { activeProfile, useProviders } from '@/stores/providers';
import { useReachability } from '@/stores/reachability';
import { getSetting } from '@/stores/settings';
import { GatewayError } from '@/transports/errors';
import { summariseFailure } from '@/transports/index';
import type { ModelCapabilities } from '@/transports/support';
import type {
  ContentBlock,
  StopReason,
  StreamEvent,
  TokenUsage,
  Transport,
  UnifiedMessage,
} from '@/transports/types';

/** How often streaming state is published to subscribers, in milliseconds. */
const COMMIT_INTERVAL = 60;

/* -------------------------------------------------------------------------- */
/* Stream state                                                                */
/* -------------------------------------------------------------------------- */

export type StreamPhase = 'preparing' | 'summarising' | 'connecting' | 'retrying' | 'streaming' | 'saving';

export interface PartialToolCall {
  id: string;
  name: string;
  partialJson: string;
}

/** What the transport is waiting on, when it is between attempts. */
export interface RetryState {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** How long the backoff will sleep before attempt `attempt + 1`. */
  delayMs: number;
  /** The gateway's own reason, verbatim. */
  message: string;
  /**
   * When the wait started.
   *
   * Recorded here rather than derived in the UI: a countdown needs an origin, and
   * the component only learns about the retry on its next render — which may be
   * hundreds of milliseconds late, and later still after a re-mount.
   */
  at: number;
}

export interface StreamState {
  conversationId: string;
  model: string;
  startedAt: number;
  phase: StreamPhase;
  text: string;
  thinking: string;
  toolCalls: PartialToolCall[];
  usage: Partial<TokenUsage>;
  droppedParams: { param: string; message: string }[];
  failover?: { from: string; to: string };
  /** Set while the transport is sleeping between attempts. */
  retry?: RetryState;
  /**
   * When the first byte of the answer arrived, as a millisecond timestamp.
   *
   * Kept so the UI can report time-to-first-token rather than a single elapsed
   * clock that says "Streaming · 0s" for three seconds before anything appears.
   */
  firstByteAt?: number;
  /** Set when the turn ended badly. Always the gateway's own words. */
  error?: string;
  /** Set once the user pressed stop. */
  aborting: boolean;
}

/**
 * Mutable accumulator, published to the store as an immutable copy.
 *
 * `toolCalls` is omitted here because it is derived: the live copy indexes calls
 * by stream block index so deltas can find them, and `snapshot` flattens that
 * map. Keeping both would be two places to forget to update.
 */
interface LiveStream extends Omit<StreamState, 'toolCalls'> {
  /** Tool call scratch space, indexed by the stream's block index. */
  toolIndex: Map<number, PartialToolCall>;
  thinkingSignature?: string;
  redactedThinking: string[];
  stopReason: StopReason;
  id?: string;
}

const controllers = new Map<string, AbortController>();

function snapshot(live: LiveStream): StreamState {
  const state: StreamState = {
    conversationId: live.conversationId,
    model: live.model,
    startedAt: live.startedAt,
    phase: live.phase,
    text: live.text,
    thinking: live.thinking,
    toolCalls: [...live.toolIndex.values()],
    usage: live.usage,
    droppedParams: live.droppedParams,
    aborting: live.aborting,
  };
  if (live.failover) state.failover = live.failover;
  if (live.retry) state.retry = live.retry;
  if (live.firstByteAt) state.firstByteAt = live.firstByteAt;
  if (live.error) state.error = live.error;
  return state;
}

/** The content blocks a finished (or aborted) stream should be stored as. */
function blocksOf(live: LiveStream): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (live.thinking) {
    blocks.push({
      type: 'thinking',
      text: live.thinking,
      ...(live.thinkingSignature ? { signature: live.thinkingSignature } : {}),
    });
  }
  for (const data of live.redactedThinking) {
    blocks.push({ type: 'thinking', text: '', redacted: data });
  }
  if (live.text) blocks.push({ type: 'text', text: live.text });
  for (const call of live.toolIndex.values()) {
    let input: unknown = {};
    try {
      input = call.partialJson ? JSON.parse(call.partialJson) : {};
    } catch {
      // A truncated arguments blob is worth keeping verbatim: it is the evidence
      // that the stream was cut off mid-call.
      input = { __unparsed: call.partialJson };
    }
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input });
  }
  return blocks;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export interface SendOptions {
  /** Text typed in the composer. Blank is allowed when attachments are present. */
  text: string;
  attachments?: ContentBlock[];
  /** Overrides the conversation's model for this message only. */
  modelOverride?: string;
}

export interface ChatState {
  conversations: Conversation[];
  listLoading: boolean;
  listError?: string;
  /**
   * The filter the current list was loaded with.
   *
   * Kept so a mutation that changes list *membership* — archiving — can re-run the
   * same query instead of guessing whether the row still belongs.
   */
  listOptions?: ListOptions;

  /** Loaded transcripts, keyed by conversation id. */
  messages: Record<string, StoredMessage[]>;
  /** Composer text, kept per conversation so switching away doesn't lose it. */
  drafts: Record<string, string>;
  streams: Record<string, StreamState>;

  loadList(options?: ListOptions): Promise<void>;
  open(conversationId: string): Promise<void>;
  reload(conversationId: string): Promise<void>;

  start(init?: { title?: string; model?: string; profileId?: string }): Promise<string>;
  rename(conversationId: string, title: string): Promise<void>;
  setSystemPrompt(conversationId: string, prompt: string): Promise<void>;
  setModel(conversationId: string, model: string): Promise<void>;
  /**
   * Repoints a conversation at another provider profile.
   *
   * Needed because a deleted profile leaves its conversations unsendable, and the
   * transcript is worth keeping — so the fix has to be reachable from the
   * conversation itself rather than only by not deleting the profile.
   */
  setProfile(conversationId: string, profileId: string): Promise<void>;
  setConfig(conversationId: string, patch: Partial<ConversationConfig>): Promise<void>;
  setPinned(conversationId: string, pinned: boolean): Promise<void>;
  /**
   * Moves a conversation out of the list without destroying it.
   *
   * The only non-destructive way to tidy up that this app had was delete, so
   * "I am done with this thread" and "this thread should not exist" were the same
   * button. The column and the query filter were already there.
   */
  setArchived(conversationId: string, archived: boolean): Promise<void>;
  setTags(conversationId: string, tags: string[]): Promise<void>;
  remove(conversationId: string): Promise<void>;

  setDraft(conversationId: string, text: string): void;

  send(conversationId: string, options: SendOptions): Promise<void>;
  regenerate(conversationId: string, messageId: string): Promise<void>;
  editAndResend(conversationId: string, messageId: string, text: string): Promise<void>;
  editInPlace(conversationId: string, messageId: string, text: string): Promise<void>;
  setExcluded(conversationId: string, messageId: string, excluded: boolean): Promise<void>;
  deleteMessage(conversationId: string, messageId: string): Promise<void>;
  fork(conversationId: string, messageId: string): Promise<string>;
  abort(conversationId: string): void;
  dismissError(conversationId: string): void;
}

export const useChat = create<ChatState>()((set, get) => ({
  conversations: [],
  listLoading: false,
  messages: {},
  drafts: {},
  streams: {},

  async loadList(options) {
    set({ listLoading: true, listOptions: options });
    try {
      const conversations = await listConversations(options);
      set({ conversations, listLoading: false, listError: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('chat', 'Could not load the conversation list', { error: message });
      set({ listLoading: false, listError: message });
    }
  },

  async open(conversationId) {
    if (get().messages[conversationId]) return;
    await get().reload(conversationId);
  },

  async reload(conversationId) {
    const messages = await listMessages(conversationId);
    set((state) => ({ messages: { ...state.messages, [conversationId]: messages } }));
  },

  async start(init) {
    const profile = init?.profileId ? useProviders.getState().byId(init.profileId) : activeProfile();
    const resolved = profile ?? activeProfile();
    const conversation = await createConversation({
      profileId: resolved.id,
      model: init?.model ?? resolved.defaultModel,
      ...(init?.title ? { title: init.title } : {}),
    });
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      messages: { ...state.messages, [conversation.id]: [] },
    }));
    return conversation.id;
  },

  async rename(conversationId, title) {
    const trimmed = title.trim() || 'Untitled';
    await updateConversation(conversationId, { title: trimmed });
    patchConversation(set, conversationId, { title: trimmed });
  },

  async setSystemPrompt(conversationId, prompt) {
    const value = prompt.trim();
    await updateConversation(conversationId, { systemPrompt: value || null });
    patchConversation(set, conversationId, value ? { systemPrompt: value } : { systemPrompt: undefined });
  },

  async setModel(conversationId, model) {
    await updateConversation(conversationId, { model });
    patchConversation(set, conversationId, { model });
  },

  async setProfile(conversationId, profileId) {
    await updateConversation(conversationId, { profileId });
    patchConversation(set, conversationId, { profileId });
    // The cached transport is keyed by profile, and the old key may not exist any
    // more — which is the usual reason for calling this.
    invalidateTransports(profileId);
  },

  async setConfig(conversationId, patch) {
    const current = get().conversations.find((c) => c.id === conversationId) ?? (await getConversation(conversationId));
    if (!current) return;
    const config = { ...current.config, ...patch };
    await updateConversation(conversationId, { config });
    patchConversation(set, conversationId, { config });
  },

  async setPinned(conversationId, pinned) {
    await dbSetPinned(conversationId, pinned);
    // Re-sorting locally rather than re-querying keeps the row from jumping twice.
    set((state) => ({
      conversations: [...state.conversations]
        .map((c) => (c.id === conversationId ? { ...c, pinned } : c))
        .sort(byPinnedThenRecent),
    }));
  },

  async setArchived(conversationId, archived) {
    // A live stream on a conversation being archived is stopped: the row is about to
    // leave the list, and a reply arriving into a list the user cannot see is worse
    // than a turn they can re-send.
    if (archived) get().abort(conversationId);
    await updateConversation(conversationId, { archived });
    // Reloaded rather than patched, because `archived` decides membership of the
    // list rather than the contents of a row — the last query's own filter is the
    // only thing that knows whether this row still belongs.
    await get().loadList(get().listOptions);
  },

  async setTags(conversationId, tags) {    await dbSetTags(conversationId, tags);
    const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    patchConversation(set, conversationId, { tags: cleaned });
  },

  async remove(conversationId) {
    get().abort(conversationId);
    await dbDeleteConversation(conversationId);
    set((state) => {
      const messages = { ...state.messages };
      const drafts = { ...state.drafts };
      const streams = { ...state.streams };
      delete messages[conversationId];
      delete drafts[conversationId];
      delete streams[conversationId];
      return {
        conversations: state.conversations.filter((c) => c.id !== conversationId),
        messages,
        drafts,
        streams,
      };
    });
  },

  setDraft(conversationId, text) {
    set((state) => ({ drafts: { ...state.drafts, [conversationId]: text } }));
  },

  async send(conversationId, options) {
    if (get().streams[conversationId]) return;

    const content: ContentBlock[] = [];
    const text = options.text.trim();
    if (text) content.push({ type: 'text', text });
    if (options.attachments?.length) content.push(...options.attachments);
    if (!content.length) return;

    const message = await appendMessage(conversationId, { role: 'user', content });
    appendToTranscript(set, conversationId, message);
    set((state) => ({ drafts: { ...state.drafts, [conversationId]: '' } }));

    // First message names the conversation, so the list is readable without the
    // user having to rename anything.
    const conversation = await getConversation(conversationId);
    if (conversation && conversation.title === DEFAULT_TITLE && text) {
      await get().rename(conversationId, deriveTitle(text));
    }

    await runTurn(set, get, conversationId, {
      ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
    });
  },

  async regenerate(conversationId, messageId) {
    if (get().streams[conversationId]) return;
    const messages = get().messages[conversationId] ?? (await listMessages(conversationId));
    const target = messages.find((m) => m.id === messageId);
    if (!target) return;

    // Regenerating an assistant reply rewinds to it; regenerating a user message
    // means "answer this again", so the rewind starts after it.
    const from = target.role === 'assistant' ? target.seq : target.seq + Number.EPSILON;
    await deleteMessagesFrom(conversationId, from, target.role === 'assistant');
    await get().reload(conversationId);
    await runTurn(set, get, conversationId, { regeneratedFrom: messageId });
  },

  async editAndResend(conversationId, messageId, text) {
    if (get().streams[conversationId]) return;
    const messages = get().messages[conversationId] ?? (await listMessages(conversationId));
    const target = messages.find((m) => m.id === messageId);
    if (!target) return;

    // Keep any non-text blocks — re-attaching images to fix a typo would be a
    // miserable way to spend a Tuesday.
    const kept = target.content.filter((block) => block.type !== 'text');
    const content: ContentBlock[] = text.trim() ? [{ type: 'text', text: text.trim() }, ...kept] : kept;
    if (!content.length) return;

    const meta: MessageMeta = { ...target.meta, editedAt: Date.now() };
    await updateMessage(messageId, { content, meta });
    await deleteMessagesFrom(conversationId, target.seq, false);
    await get().reload(conversationId);
    await runTurn(set, get, conversationId, {});
  },

  async editInPlace(conversationId, messageId, text) {
    const messages = get().messages[conversationId] ?? (await listMessages(conversationId));
    const target = messages.find((m) => m.id === messageId);
    if (!target) return;
    const kept = target.content.filter((block) => block.type !== 'text');
    const content: ContentBlock[] = text.trim() ? [{ type: 'text', text: text.trim() }, ...kept] : kept;
    await updateMessage(messageId, { content, meta: { ...target.meta, editedAt: Date.now() } });
    await get().reload(conversationId);
  },

  /**
   * Drops a message out of the context window without deleting it.
   *
   * The row stays in the transcript and stays in the database; it just stops being
   * sent. `toUnifiedMessages` already filters on this flag, so the whole mechanism
   * existed except for a way to set it. Useful for pruning a long tool transcript
   * or a wrong turn without losing the record of what happened.
   */
  async setExcluded(conversationId, messageId, excluded) {
    await updateMessage(messageId, { excluded });
    await get().reload(conversationId);
  },

  async deleteMessage(conversationId, messageId) {
    await dbDeleteMessage(messageId);
    await get().reload(conversationId);
    const refreshed = await getConversation(conversationId);
    if (refreshed) patchConversation(set, conversationId, { preview: refreshed.preview });
  },

  async fork(conversationId, messageId) {
    const fork = await forkConversation(conversationId, messageId);
    set((state) => ({ conversations: [fork, ...state.conversations].sort(byPinnedThenRecent) }));
    await get().reload(fork.id);
    return fork.id;
  },

  abort(conversationId) {
    const controller = controllers.get(conversationId);
    if (!controller) return;
    // Mark before aborting so the transcript shows "stopping" rather than looking
    // frozen while the socket unwinds.
    set((state) => {
      const stream = state.streams[conversationId];
      if (!stream) return {};
      return { streams: { ...state.streams, [conversationId]: { ...stream, aborting: true } } };
    });
    controller.abort();
  },

  dismissError(conversationId) {
    set((state) => {
      const stream = state.streams[conversationId];
      if (!stream) return {};
      const streams = { ...state.streams };
      delete streams[conversationId];
      return { streams };
    });
  },
}));

/* -------------------------------------------------------------------------- */
/* Helpers over store state                                                    */
/* -------------------------------------------------------------------------- */

type Setter = (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void;
type Getter = () => ChatState;

function byPinnedThenRecent(a: Conversation, b: Conversation): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}

function patchConversation(set: Setter, id: string, patch: Partial<Conversation>): void {
  set((state) => ({
    conversations: state.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  }));
}

function appendToTranscript(set: Setter, conversationId: string, message: StoredMessage): void {
  set((state) => {
    const existing = state.messages[conversationId] ?? [];
    return {
      messages: { ...state.messages, [conversationId]: [...existing, message] },
      conversations: state.conversations
        .map((c) =>
          c.id === conversationId
            ? {
                ...c,
                updatedAt: message.createdAt,
                lastMessageAt: message.createdAt,
                // Only a message with text may set the preview. A message whose
                // content is all images or tool calls has an empty `text`, and
                // writing that through renders "No messages yet" on a conversation
                // with a screenful of them.
                ...(message.text ? { preview: message.text } : {}),
              }
            : c,
        )
        .sort(byPinnedThenRecent),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* The turn                                                                    */
/* -------------------------------------------------------------------------- */

interface RunOptions {
  modelOverride?: string;
  regeneratedFrom?: string;
}

/**
 * Runs one assistant turn: builds the request, streams it, stores the result.
 *
 * Every terminal path — success, abort, gateway error, transport error — writes a
 * message row. An aborted stream keeps what it received, because a half-finished
 * answer is usually still worth reading, and an errored turn stores the gateway's
 * text so the failure survives a screen change.
 */
async function runTurn(set: Setter, get: Getter, conversationId: string, options: RunOptions): Promise<void> {
  const conversation = await getConversation(conversationId);
  if (!conversation) return;

  const profile = useProviders.getState().byId(conversation.profileId) ?? activeProfile();
  const model = options.modelOverride ?? conversation.model;
  const capabilities = capabilitiesFor(profile.id, model);
  const wireHints = wireHintsFor(profile.id, model);

  const live: LiveStream = {
    conversationId,
    model,
    startedAt: Date.now(),
    phase: 'preparing',
    text: '',
    thinking: '',
    toolIndex: new Map(),
    redactedThinking: [],
    usage: {},
    droppedParams: [],
    stopReason: 'unknown',
    aborting: false,
  };

  let lastCommit = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const publish = (force = false): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const wait = COMMIT_INTERVAL - (Date.now() - lastCommit);
    if (!force && wait > 0) {
      timer = setTimeout(() => publish(true), wait);
      return;
    }
    lastCommit = Date.now();
    const value = snapshot(live);
    set((state) => ({ streams: { ...state.streams, [conversationId]: value } }));
  };
  publish(true);

  const controller = new AbortController();
  controllers.set(conversationId, controller);

  const finish = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    controllers.delete(conversationId);
  };

  try {
    const stored = await listMessages(conversationId);
    const issues = validateConfig({
      transport: profile.kind,
      capabilities,
      params: buildRequest({
        transport: profile.kind,
        model,
        capabilities,
        config: conversation.config,
        messages: [],
      }).params,
      ...(conversation.config.reasoning ? { reasoning: conversation.config.reasoning } : {}),
    });
    if (hasBlockingIssue(issues)) {
      const blocking = issues.filter((issue) => issue.level === 'error').map((issue) => issue.message);
      throw new GatewayError({
        kind: 'validation',
        message: blocking.join(' '),
        hint: 'Adjust the settings for this conversation and send again.',
      });
    }

    const { messages, summary, changed } = await applyContextStrategy({
      conversationId,
      conversation,
      stored,
      capabilities,
      live,
      publish,
      signal: controller.signal,
    });

    if (changed) await get().reload(conversationId);

    const request = buildRequest({
      transport: profile.kind,
      model,
      capabilities,
      wireHints,
      config: conversation.config,
      ...(conversation.systemPrompt ? { systemPrompt: conversation.systemPrompt } : {}),
      messages,
      ...(summary ? { summary } : {}),
    });

    live.phase = 'connecting';
    publish(true);

    // What the composer's gauge would have said about this exact prompt. Kept so the
    // gateway's own `prompt_tokens` can be compared against it below — the only
    // ground truth this app ever gets about its estimator.
    const estimatedPrompt = estimateRequestTokens(request).total;

    let yielded = false;
    const consume = async (transport: Transport): Promise<void> => {
      for await (const event of transport.stream(request, {
        signal: controller.signal,
        onParamDropped: (param, message) => {
          live.droppedParams.push({ param, message });
          publish(true);
        },
        onRetry: (info) => {
          // A 20-second backoff labelled "Streaming" is indistinguishable from a
          // hung request, so the wait gets its own phase and says why.
          live.phase = 'retrying';
          live.retry = { ...info, at: Date.now() };
          publish(true);
        },
      })) {
        if (!yielded) {
          yielded = true;
          live.phase = 'streaming';
          live.firstByteAt = Date.now();
          delete live.retry;
          // A byte from the gateway is the only proof of reachability worth having.
          useReachability.getState().markReachable();
        }
        applyEvent(live, event);
        // Text and thinking arrive by the hundred; everything else is rare and
        // worth showing immediately.
        publish(event.type !== 'text_delta' && event.type !== 'thinking_delta');
      }
    };

    const primary = await resolveTransport({ profileId: profile.id });
    try {
      await consume(primary.transport);
    } catch (error) {
      // Failover is only safe before the first event: once bytes have arrived, a
      // retry elsewhere would duplicate the visible answer and the credits.
      const canFailover =
        !yielded &&
        getSetting('autoFailover') &&
        profile.fallbackBaseUrl !== undefined &&
        error instanceof GatewayError &&
        error.kind === 'network';
      if (!canFailover) throw error;

      const fallback = await resolveTransport({ profileId: profile.id, useFallback: true });
      log.warn('chat', `Primary unreachable; retrying on ${fallback.baseUrl}.`, { from: primary.baseUrl });
      useProviders.getState().setFailover({ profileId: profile.id, from: primary.baseUrl, to: fallback.baseUrl });
      live.failover = { from: primary.baseUrl, to: fallback.baseUrl };
      live.phase = 'connecting';
      delete live.retry;
      publish(true);
      await consume(fallback.transport);
    }

    live.phase = 'saving';
    publish(true);

    const usage = normaliseUsage(live.usage);
    const meta: MessageMeta = {};
    if (live.droppedParams.length) meta.droppedParams = live.droppedParams.map((d) => d.param);
    if (options.modelOverride) meta.modelOverride = true;
    if (options.regeneratedFrom) meta.regeneratedFrom = options.regeneratedFrom;
    if (request.reasoning?.effort) meta.effort = request.reasoning.effort;
    if (request.reasoning?.budgetTokens) meta.budgetTokens = request.reasoning.budgetTokens;
    if (live.failover) meta.failedOverTo = live.failover.to;

    const message = await appendMessage(conversationId, {
      role: 'assistant',
      content: blocksOf(live),
      model,
      usage,
      stopReason: live.stopReason,
      ...(Object.keys(meta).length ? { meta } : {}),
    });
    appendToTranscript(set, conversationId, message);

    // One labelled sample of how wrong the estimator is for this model. Only when
    // the gateway actually reported a prompt count — an absent one is not a zero.
    if (usage.input !== undefined) {
      useCalibration.getState().record(`${profile.id}::${model}`, estimatedPrompt, usage.input);
    }

    const pricing = useModels.getState().get(`${profile.id}::${model}`)?.pricing;
    await recordUsage({      profileId: profile.id,
      model,
      usage,
      conversationId,
      ...(pricing ? { pricing } : {}),
    });

    clearStream(set, conversationId);
  } catch (error) {
    await handleTurnFailure(set, conversationId, live, error, options);
  } finally {
    await finish();
  }
}

/**
 * Stores what the turn managed to produce, plus why it stopped.
 *
 * An abort is not an error: the user asked for it, and the partial answer is
 * saved with `stopReason: 'aborted'` so the transcript can say so.
 *
 * A failure that produced **nothing** writes no row at all. It used to write an
 * empty assistant message with the error baked into it, and that stub was a
 * genuinely expensive mistake: it was permanent (Dismiss cleared the banner, not
 * the row), it had no text so it overwrote the conversation's preview with an
 * empty string — a list row reading "No messages yet" next to "6 messages" — and
 * it stayed in the transcript as an empty bubble forever. There is nothing to keep
 * in that case; the failure lives in the stream entry, where Dismiss can reach it
 * and Try again can act on it.
 *
 * A failure that produced *partial* content still writes a row, because half an
 * answer is usually worth reading, and the error is recorded on it.
 */
async function handleTurnFailure(
  set: Setter,
  conversationId: string,
  live: LiveStream,
  error: unknown,
  options: RunOptions,
): Promise<void> {
  const aborted = live.aborting || (error instanceof GatewayError && error.kind === 'aborted');
  const gatewayError = error instanceof GatewayError ? error : null;
  const detail = gatewayError ? summariseFailure(gatewayError) : error instanceof Error ? error.message : String(error);

  const blocks = blocksOf(live);
  const meta: MessageMeta = {};
  if (aborted) meta.aborted = true;
  if (live.droppedParams.length) meta.droppedParams = live.droppedParams.map((d) => d.param);
  if (options.modelOverride) meta.modelOverride = true;
  if (live.failover) meta.failedOverTo = live.failover.to;

  if (blocks.length) {
    const message = await appendMessage(conversationId, {
      role: 'assistant',
      content: blocks,
      model: live.model,
      usage: normaliseUsage(live.usage),
      stopReason: aborted ? 'aborted' : live.stopReason,
      ...(aborted ? {} : { error: detail }),
      ...(Object.keys(meta).length ? { meta } : {}),
    });
    appendToTranscript(set, conversationId, message);
  }

  if (aborted) {
    clearStream(set, conversationId);
    return;
  }

  log.error('chat', 'Turn failed', { error: detail, kind: gatewayError?.kind });
  // Only a `network` failure is evidence about reachability. A 401 or a 400 proves
  // the opposite — the host answered — so it clears the banner rather than raising
  // it, which is how "unreachable" stays a claim about the connection rather than a
  // catch-all for "the last request did not work".
  if (gatewayError?.kind === 'network') useReachability.getState().markUnreachable(detail);
  else if (gatewayError) useReachability.getState().markReachable();
  // The stream entry survives with the error on it, so the composer can show a
  // retry affordance without the transcript losing the failure. Dismissing it is
  // now the only record that disappears, which is the point: nothing was written.
  set((state) => {
    const stream = state.streams[conversationId];
    if (!stream) return {};
    const next: StreamState = { ...stream, phase: 'saving', error: detail, aborting: false };
    delete next.retry;
    return { streams: { ...state.streams, [conversationId]: next } };
  });
}

function clearStream(set: Setter, conversationId: string): void {
  set((state) => {
    const streams = { ...state.streams };
    delete streams[conversationId];
    return { streams };
  });
}

/** Folds one stream event into the accumulator. Never destructive. */
function applyEvent(live: LiveStream, event: StreamEvent): void {
  switch (event.type) {
    case 'start':
      if (event.id) live.id = event.id;
      if (event.model) live.model = event.model;
      break;
    case 'text_delta':
      live.text += event.text;
      break;
    case 'thinking_delta':
      live.thinking += event.text;
      break;
    case 'thinking_signature':
      live.thinkingSignature = event.signature;
      break;
    case 'redacted_thinking':
      live.redactedThinking.push(event.data);
      break;
    case 'tool_use_start':
      live.toolIndex.set(event.index, { id: event.id, name: event.name, partialJson: '' });
      break;
    case 'tool_use_delta': {
      const call = live.toolIndex.get(event.index);
      if (call) call.partialJson += event.partialJson;
      break;
    }
    case 'tool_use_stop':
      break;
    case 'usage':
      live.usage = { ...live.usage, ...event.usage };
      break;
    case 'stop':
      live.stopReason = event.reason;
      break;
    case 'param_dropped':
      if (!live.droppedParams.some((d) => d.param === event.param)) {
        live.droppedParams.push({ param: event.param, message: event.message });
      }
      break;
    case 'failover':
      live.failover = { from: event.from, to: event.to };
      break;
  }
}

/**
 * Copies only the usage fields the gateway actually reported.
 *
 * It used to default `input` and `output` to 0, which made "this gateway does not
 * stream prompt usage" indistinguishable from "this turn cost nothing" — including
 * in the cost column, where a zero is a claim about money.
 */
function normaliseUsage(partial: Partial<TokenUsage>): Partial<TokenUsage> {
  const usage: Partial<TokenUsage> = {};
  if (partial.input !== undefined) usage.input = partial.input;
  if (partial.output !== undefined) usage.output = partial.output;
  if (partial.thinking !== undefined) usage.thinking = partial.thinking;
  if (partial.cacheRead !== undefined) usage.cacheRead = partial.cacheRead;
  if (partial.cacheWrite !== undefined) usage.cacheWrite = partial.cacheWrite;
  return usage;
}

/* -------------------------------------------------------------------------- */
/* Context strategy                                                            */
/* -------------------------------------------------------------------------- */

interface StrategyInput {
  conversationId: string;
  conversation: Conversation;
  stored: StoredMessage[];
  capabilities: ModelCapabilities;
  live: LiveStream;
  publish(force?: boolean): void;
  signal: AbortSignal;
}

interface StrategyResult {
  messages: UnifiedMessage[];
  summary?: string;
  /** True when any message's `excluded` flag changed and the transcript is stale. */
  changed: boolean;
}

/**
 * Decides which turns actually go on the wire.
 *
 * `warn` sends everything and lets the pressure indicator do the talking, because
 * silently truncating a conversation the user can see in front of them is worse
 * than a rejected request. The other two strategies drop or summarise.
 *
 * `excluded` is recomputed from scratch every turn rather than accumulated: it
 * records what the *most recent* request left out, so switching to a model with a
 * larger window, or deleting some history, brings those turns back rather than
 * leaving them permanently orphaned by a decision taken three messages ago.
 */
async function applyContextStrategy(input: StrategyInput): Promise<StrategyResult> {
  const { conversation, stored, capabilities } = input;
  const strategy = conversation.config.contextStrategy ?? getSetting('contextStrategy');
  const previousSummary = conversation.config.summary?.text;

  // Built by hand rather than through `toUnifiedMessages`, which filters out
  // already-excluded rows: the indices returned by the budget selector have to
  // line up with `eligible` for the dropped set to name the right messages.
  const eligible = stored.filter((m) => m.content.length > 0);
  const all: UnifiedMessage[] = eligible.map((m) => ({ role: m.role, content: m.content }));

  const sendEverything = async (): Promise<StrategyResult> => ({
    messages: all,
    ...(previousSummary ? { summary: previousSummary } : {}),
    changed: await setExclusions(eligible, EMPTY_SET),
  });

  if (strategy === 'warn') return sendEverything();

  const params = buildRequest({
    transport: 'anthropic',
    model: conversation.model,
    capabilities,
    config: conversation.config,
    messages: [],
  }).params;
  // Output and thinking are charged against the context window too, so the space
  // available for history is what is left after reserving room for the reply.
  const reserved = params.maxTokens + (conversation.config.reasoning?.budgetTokens ?? 0);
  const systemCost = estimateMessageTokens({
    role: 'user',
    content: [{ type: 'text', text: `${conversation.systemPrompt ?? ''}\n${previousSummary ?? ''}` }],
  });
  const budget = Math.max(1_024, capabilities.contextWindow - reserved - systemCost - 512);

  const { keep, dropped } = selectMessagesWithinBudget(all, budget);
  if (!dropped.length) return sendEverything();

  const droppedMessages = dropped.map((index) => eligible[index]).filter((m): m is StoredMessage => Boolean(m));
  const keptMessages = keep.map((index) => all[index]).filter((m): m is UnifiedMessage => Boolean(m));
  const changed = await setExclusions(eligible, new Set(droppedMessages.map((m) => m.id)));

  const summary =
    strategy === 'summarise' ? await summariseDropped(input, droppedMessages, previousSummary) : previousSummary;

  return { messages: keptMessages, ...(summary ? { summary } : {}), changed };
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Writes the exclusion flags for a whole conversation, returning whether
 * anything moved. Only rows whose flag actually differs are written, so the
 * common case — no trim needed, nothing previously trimmed — is zero statements.
 */
async function setExclusions(messages: readonly StoredMessage[], excluded: ReadonlySet<string>): Promise<boolean> {
  let changed = false;
  for (const message of messages) {
    const shouldExclude = excluded.has(message.id);
    if (message.excluded !== shouldExclude) {
      await updateMessage(message.id, { excluded: shouldExclude });
      changed = true;
    }
  }
  return changed;
}

/**
 * Asks the model to compress the turns being dropped.
 *
 * Non-streaming and capped low, and it extends the previous summary rather than
 * re-reading the whole history, so the cost is proportional to what was just
 * dropped rather than to the conversation's length. If it fails, the turn
 * continues with the plain drop: losing the summary is much better than losing
 * the message the user just sent.
 */
async function summariseDropped(
  input: StrategyInput,
  dropped: readonly StoredMessage[],
  previous: string | undefined,
): Promise<string | undefined> {
  if (!dropped.length) return previous;

  input.live.phase = 'summarising';
  input.publish(true);

  const transcript = dropped
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${flattenContent(m.content)}`)
    .join('\n\n');

  const body = previous
    ? `Existing notes:\n\n${previous}\n\nNewly removed turns:\n\n${transcript}\n\n${SUMMARY_INSTRUCTION} ` +
      'Merge the existing notes with the new turns into one set of notes.'
    : `${transcript}\n\n${SUMMARY_INSTRUCTION}`;

  try {
    const { transport } = await resolveTransport({ profileId: input.conversation.profileId });
    const result = await transport.complete(
      {
        model: input.conversation.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: body }] }],
        params: { maxTokens: 1_024 },
      },
      { signal: input.signal },
    );
    const summary = result.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!summary) return previous;

    const lastDropped = dropped[dropped.length - 1];
    await updateConversation(input.conversationId, {
      config: {
        ...input.conversation.config,
        summary: { throughSeq: lastDropped?.seq ?? 0, text: summary },
      },
    });
    return summary;
  } catch (error) {
    log.warn('chat', 'Could not summarise the dropped turns; sending without a summary', {
      error: error instanceof Error ? error.message : String(error),
    });
    return previous;
  }
}

/* -------------------------------------------------------------------------- */
/* Selectors                                                                   */
/* -------------------------------------------------------------------------- */

const NO_MESSAGES: StoredMessage[] = [];

export function useMessages(conversationId: string): StoredMessage[] {
  return useChat((state) => state.messages[conversationId] ?? NO_MESSAGES);
}

export function useStream(conversationId: string): StreamState | undefined {
  return useChat((state) => state.streams[conversationId]);
}

export function useConversation(conversationId: string): Conversation | undefined {
  return useChat((state) => state.conversations.find((c) => c.id === conversationId));
}

export function useDraft(conversationId: string): string {
  return useChat((state) => state.drafts[conversationId] ?? '');
}
