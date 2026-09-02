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
  dropHiddenMessages,
  flattenContent,
  forkConversation,
  getConversation,
  isToolTurn,
  listConversationPage,
  listMessages,
  newestTurnVariants,
  previewOf,
  recordUsage,
  selectTurn,
  setTurnAside,
  setPinned as dbSetPinned,
  setTags as dbSetTags,
  setArchivedBulk,
  tagConversations,
  updateConversation,
  updateMessage,
  deleteConversation as dbDeleteConversation,
  deleteConversations as dbDeleteConversations,
} from '@/db/conversations';
import type {
  Conversation,
  ConversationConfig,
  ListOptions,
  MessageMeta,
  StoredMessage,
  TagMode,
  TurnVariant,
} from '@/db/conversations';
import type { ListCursor } from '@/db/list-query';
import { buildRequest, composeSystem, validateConfig, hasBlockingIssue } from '@/chat/request';
import { formatBytes } from '@/chat/attachments';
import {
  builtinTools,
  CREATE_DOCUMENT,
  CREATE_PDF,
  FETCH_URL,
  parseDocument,
  parsePdf,
  parseWriteFile,
  READ_RESOURCE,
  RUN_CODE,
  WRITE_FILE,
} from '@/chat/builtins';
import { parseRunCode, runInSandbox } from '@/chat/sandbox';
import { writeGeneratedFile, writePdf } from '@/chat/files';
import { officeDocument } from '@/chat/ooxml';
import { fetchAsText } from '@/chat/web';
import { describeWithheldTools, selectTools } from '@/chat/tools';
import { blockedInPlanMode, describeBlockedCalls, planRefusal } from '@/chat/plan';
import { INVOKE_SKILL, invokeSkillTool, renderSkillCatalogue, resolveSkillCall } from '@/chat/skill';
import type { Skill } from '@/chat/skill';
import { MCP_TOOL_PREFIX } from '@/mcp/protocol';
import { planTurn } from '@/chat/budget';
import { boundSummary, summaryRequestBody, SUMMARY_FAILED_NOTE } from '@/chat/summary';
import { reportedUsage } from '@/chat/usage';
import { describeTrim, trimToBudget } from '@/chat/trim';
import type { TrimReport } from '@/chat/trim';
import { planCacheForRequest } from '@/chat/cache';
import { projectSystemPrompt } from '@/chat/project';
import { invalidateTransports, resolveTransport } from '@/lib/gateway';
import { newId } from '@/lib/id';
import { log } from '@/lib/log';
import { notifyReplyReady, primeNotifications } from '@/lib/notify';
import { estimateRequestTokens } from '@/lib/tokens';
import { capabilitiesFor, useModels, wireHintsFor } from '@/stores/models';
import { useCalibration } from '@/stores/calibration';
import { activeProfile, useProviders } from '@/stores/providers';
import { useMemory } from '@/stores/memory';
import { useSkills } from '@/stores/skills';
import { useMcp } from '@/stores/mcp';
import { useProjects } from '@/stores/projects';
import { useReachability } from '@/stores/reachability';
import { useSendQueue } from '@/stores/queue';
import { getSetting } from '@/stores/settings';
import { GatewayError } from '@/transports/errors';
import { summariseFailure } from '@/transports/index';
import type { ModelCapabilities } from '@/transports/support';
import type {
  Citation,
  ContentBlock,
  ServerToolBlock,
  StopReason,
  StreamEvent,
  TokenUsage,
  ToolDefinition,
  ToolUseBlock,
  Transport,
  UnifiedMessage,
} from '@/transports/types';

/** How often streaming state is published to subscribers, in milliseconds. */
const COMMIT_INTERVAL = 60;

/* -------------------------------------------------------------------------- */
/* Stream state                                                                */
/* -------------------------------------------------------------------------- */

export type StreamPhase =
  | 'preparing'
  | 'summarising'
  | 'connecting'
  | 'retrying'
  | 'streaming'
  | 'tools'
  | 'saving';

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
  /**
   * Debug log ids of the HTTP requests this turn opened, in order.
   *
   * On the live accumulator rather than in `runTurn`'s body because the failure path
   * writes its own row from `live`, and a turn that failed is the one whose raw
   * request a developer most wants to read. Not in {@link StreamState}: nothing on
   * screen shows this while the answer is arriving.
   */
  requestIds: string[];
  thinkingSignature?: string;
  redactedThinking: string[];
  /** Provider-side tool blocks, in the order the provider ran them. */
  serverTools: ServerToolBlock[];
  /** Sources the provider says it used, de-duplicated as they arrive. */
  citations: Citation[];
  stopReason: StopReason;
  id?: string;
}

const controllers = new Map<string, AbortController>();

/**
 * Conversations with a turn in flight, claimed synchronously.
 *
 * `streams[conversationId]` is the *published* marker, and it does not exist yet for
 * the whole prologue of a send: storing the user's row, re-reading the conversation
 * and possibly renaming it are three awaits of real SQLite before `runTurn` publishes
 * anything. A second tap on Send inside that window passed a `streams` check, stored
 * the draft a second time and started a second turn on the same conversation — which
 * then overwrote the first's entry in {@link controllers}, so Stop could only reach
 * one of the two. The same window reopens between tool rounds, where the stream is
 * cleared before the results are written and the next round begins.
 *
 * A `Set` rather than more state in the store: nothing renders from this, and the
 * point is that the claim lands in the same tick as the check.
 */
const inFlight = new Set<string>();

/**
 * Runs `body` unless this conversation is already busy.
 *
 * Wraps the actions that start a turn, not `runTurn` itself: by the time `runTurn` is
 * reached the duplicate user message has already been written, and the recursive tool
 * and `pause_turn` rounds run *inside* the caller's claim, which is what keeps them
 * covered too.
 */
async function once(conversationId: string, body: () => Promise<void>): Promise<void> {
  if (inFlight.has(conversationId)) return;
  inFlight.add(conversationId);
  try {
    await body();
  } finally {
    inFlight.delete(conversationId);
  }
}

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
  // Before the text: the model searched and then wrote the answer from what it found.
  blocks.push(...live.serverTools);
  if (live.text) {
    blocks.push({ type: 'text', text: live.text, ...(live.citations.length ? { citations: live.citations } : {}) });
  }
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
  /**
   * Where the loaded page stopped, or `null` once the list is fully loaded.
   *
   * A cursor rather than a page number: rows are ordered by `updated_at`, which
   * changes under the user as messages land, and an offset over a shifting order
   * shows some conversations twice and skips others.
   */
  listCursor?: ListCursor | null;
  /** True while {@link loadMore} is in flight, so `onEndReached` cannot stack requests. */
  listLoadingMore: boolean;

  /** Loaded transcripts, keyed by conversation id. */
  messages: Record<string, StoredMessage[]>;
  /** Composer text, kept per conversation so switching away doesn't lose it. */
  drafts: Record<string, string>;
  /**
   * Staged attachments, kept per conversation alongside the text draft.
   *
   * In the store rather than in the screen's `useState` for one reason that is not
   * tidiness: a resized photo is a megabyte of base64 that cost a permission
   * prompt, a camera and a re-encode to produce, and losing it because the user
   * checked something in another conversation is not a small annoyance. It is
   * cleared by the same code paths that clear the text draft.
   */
  attachments: Record<string, ContentBlock[]>;
  streams: Record<string, StreamState>;
  /**
   * What the last turn's context handling did, per conversation, as one sentence.
   *
   * Kept because trimming is the one thing the app does to the user's conversation
   * without being asked. Before this, the evidence that four turns had been left
   * out of a request was a debug-log line and a grey badge on rows the user has
   * already scrolled past. Not persisted: it describes the last request, and after
   * a relaunch there isn't one.
   */
  contextNotes: Record<string, string>;

  /**
   * Conversations whose last turn stopped at the tool-round cap.
   *
   * Its own map rather than a flag inside the note: every other note describes
   * something already done and has no action left, and this one is the only case
   * where there is a button to press.
   */
  stalled: Record<string, true>;

  /**
   * Alternative replies to the last user message, per conversation.
   *
   * Only ever the newest turn — see `newestTurnVariants`. Kept in the store rather
   * than derived from `messages`, because the whole point of the model is that the
   * variants the user is not reading are *not* in the transcript.
   */
  variants: Record<string, { answersId: string; variants: TurnVariant[] }>;

  loadList(options?: ListOptions): Promise<void>;
  /** Appends the next page. A no-op at the end of the list or while one is loading. */
  loadMore(): Promise<void>;
  open(conversationId: string): Promise<void>;
  reload(conversationId: string): Promise<void>;

  start(init?: { title?: string; model?: string; profileId?: string; projectId?: string }): Promise<string>;
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
  /** Moves a conversation into a project, or out of one with `undefined`. */
  setProject(conversationId: string, projectId: string | undefined): Promise<void>;
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

  /**
   * The bulk versions of archive, delete and retag.
   *
   * Separate actions rather than a loop over the single-row ones at the call
   * site, because the single-row ones cannot give the guarantee that matters:
   * `removeMany` is one transaction, so a selection is destroyed completely or
   * not at all. Fifty calls to `remove()` can stop in the middle with no undo
   * and no way for the user to say which half went.
   *
   * Each returns how many rows it actually affected, so the confirmation can
   * state what happened rather than what was asked for.
   */
  archiveMany(conversationIds: readonly string[], archived: boolean): Promise<number>;
  removeMany(conversationIds: readonly string[]): Promise<number>;
  tagMany(conversationIds: readonly string[], tags: readonly string[], mode: TagMode): Promise<number>;

  setDraft(conversationId: string, text: string): void;

  /**
   * Adds already-encoded attachment blocks to the draft.
   *
   * Blocks, not files: the picking, resizing and admission all happen in
   * `@/chat/attach` before anything reaches the store, so this cannot be the place
   * a 9 MB base64 string gets in by accident.
   */
  addAttachments(conversationId: string, blocks: readonly ContentBlock[]): void;
  /** Drops one staged attachment by position. */
  removeAttachment(conversationId: string, index: number): void;
  clearAttachments(conversationId: string): void;

  send(conversationId: string, options: SendOptions): Promise<void>;
  regenerate(conversationId: string, messageId: string): Promise<void>;
  /**
   * Pages between the alternative replies to the last user message.
   *
   * By index into {@link ChatState.variants}, not by direction: the pager renders
   * "2 of 3", so it already knows where it is, and a store that recomputed that from
   * a direction would be a second place for the numbering to disagree.
   */
  selectVariant(conversationId: string, index: number): Promise<void>;
  editAndResend(conversationId: string, messageId: string, text: string): Promise<void>;
  editInPlace(conversationId: string, messageId: string, text: string): Promise<void>;
  setExcluded(conversationId: string, messageId: string, excluded: boolean): Promise<void>;
  deleteMessage(conversationId: string, messageId: string): Promise<void>;
  fork(conversationId: string, messageId: string): Promise<string>;
  abort(conversationId: string): void;
  /**
   * Runs the last turn again, whatever it was.
   *
   * What "Try again" and the offline queue both mean: rewind to the last message and
   * ask for an answer. Expressed once here rather than as `regenerate(id, lastId)` at
   * two call sites that each have to work out what "last" is.
   */
  retryTurn(conversationId: string): Promise<void>;
  /**
   * Runs another turn on the history as it stands, with the tool-round count reset.
   *
   * What the Continue button next to "this turn was stopped" does. Not `retryTurn`:
   * the history already ends with the tool results, so there is nothing to rewind —
   * the model simply has not been asked to look at them yet.
   */
  continueTurn(conversationId: string): Promise<void>;
  dismissError(conversationId: string): void;
  /** Clears the last turn's context note once the user has read it. */
  dismissContextNote(conversationId: string): void;
}

export const useChat = create<ChatState>()((set, get) => ({
  conversations: [],
  listLoading: false,
  listLoadingMore: false,
  messages: {},
  drafts: {},
  attachments: {},
  streams: {},
  contextNotes: {},
  stalled: {},
  variants: {},

  async loadList(options) {
    set({ listLoading: true, listOptions: options });
    try {
      const { conversations, cursor } = await listConversationPage(options);
      set({ conversations, listCursor: cursor, listLoading: false, listError: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('chat', 'Could not load the conversation list', { error: message });
      set({ listLoading: false, listError: message });
    }
  },

  async loadMore() {
    const { listCursor, listLoading, listLoadingMore, listOptions } = get();
    // `listCursor === null` means the last page was short, i.e. the end of the
    // list; `undefined` means nothing has been loaded yet, which `loadList`
    // owns. Either way there is nothing to append.
    if (!listCursor || listLoading || listLoadingMore) return;

    set({ listLoadingMore: true });
    try {
      const { conversations, cursor } = await listConversationPage({ ...listOptions, after: listCursor });
      set((state) => ({
        // Filtering by id rather than concatenating: a conversation whose
        // `updated_at` moved above the cursor between pages can come back in an
        // earlier page too, and two rows with one key is a FlashList crash
        // rather than a cosmetic duplicate.
        conversations: [...state.conversations, ...conversations.filter((c) => !state.conversations.some((s) => s.id === c.id))],
        listCursor: cursor,
        listLoadingMore: false,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('chat', 'Could not load more conversations', { error: message });
      set({ listLoadingMore: false, listError: message });
    }
  },

  async open(conversationId) {
    if (get().messages[conversationId]) return;
    await get().reload(conversationId);
  },

  async reload(conversationId) {
    const messages = await listMessages(conversationId);
    // One extra grouped read per transcript load, and it is the only place the
    // variant set is refreshed: every path that changes the shape of the
    // conversation already ends in a `reload`.
    const variants = await newestTurnVariants(conversationId);
    set((state) => ({
      messages: { ...state.messages, [conversationId]: messages },
      variants: { ...state.variants, [conversationId]: variants },
    }));
  },

  async start(init) {
    const profile = init?.profileId ? useProviders.getState().byId(init.profileId) : activeProfile();
    const resolved = profile ?? activeProfile();
    // Copied in rather than applied at send time, so editing the default later does
    // not rewrite the prompt of a conversation the user has since tuned.
    const seedPrompt = getSetting('defaultSystemPrompt').trim();
    const conversation = await createConversation({
      profileId: resolved.id,
      model: init?.model ?? resolved.defaultModel,
      ...(init?.title ? { title: init.title } : {}),
      ...(init?.projectId ? { projectId: init.projectId } : {}),
      ...(seedPrompt ? { systemPrompt: seedPrompt } : {}),
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

  async setProject(conversationId, projectId) {
    await updateConversation(conversationId, { projectId: projectId ?? null });
    patchConversation(set, conversationId, projectId ? { projectId } : { projectId: undefined });
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
      const attachments = { ...state.attachments };
      const streams = { ...state.streams };
      const variants = { ...state.variants };
      delete messages[conversationId];
      delete drafts[conversationId];
      delete attachments[conversationId];
      delete streams[conversationId];
      delete variants[conversationId];
      return {
        conversations: state.conversations.filter((c) => c.id !== conversationId),
        messages,
        drafts,
        attachments,
        streams,
        variants,
      };
    });
  },

  setDraft(conversationId, text) {
    set((state) => ({ drafts: { ...state.drafts, [conversationId]: text } }));
  },

  addAttachments(conversationId, blocks) {
    if (!blocks.length) return;
    set((state) => ({
      attachments: {
        ...state.attachments,
        [conversationId]: [...(state.attachments[conversationId] ?? []), ...blocks],
      },
    }));
  },

  removeAttachment(conversationId, index) {
    set((state) => {
      const staged = state.attachments[conversationId];
      if (!staged || index < 0 || index >= staged.length) return {};
      const next = staged.filter((_, at) => at !== index);
      const attachments = { ...state.attachments };
      if (next.length) attachments[conversationId] = next;
      else delete attachments[conversationId];
      return { attachments };
    });
  },

  clearAttachments(conversationId) {
    set((state) => {
      if (!state.attachments[conversationId]) return {};
      const attachments = { ...state.attachments };
      delete attachments[conversationId];
      return { attachments };
    });
  },

  async archiveMany(conversationIds, archived) {
    if (archived) for (const id of conversationIds) get().abort(id);
    const changed = await setArchivedBulk(conversationIds, archived);
    // Reloaded rather than patched, for the same reason as `setArchived`:
    // `archived` decides membership of the list, and only the query's own filter
    // knows which of these rows still belongs in it.
    await get().loadList(get().listOptions);
    return changed;
  },

  async removeMany(conversationIds) {
    for (const id of conversationIds) get().abort(id);
    const removed = await dbDeleteConversations(conversationIds);
    // The in-memory caches are pruned from the same id list rather than from the
    // count the database returned. A row that had already been deleted elsewhere
    // does not come back in `removed`, but its draft and its cached messages are
    // still sitting in this store, and they are exactly as dead.
    const gone = new Set(conversationIds);
    set((state) => {
      const messages = { ...state.messages };
      const drafts = { ...state.drafts };
      const attachments = { ...state.attachments };
      const streams = { ...state.streams };
      const variants = { ...state.variants };
      for (const id of gone) {
        delete messages[id];
        delete drafts[id];
        delete attachments[id];
        delete streams[id];
        delete variants[id];
      }
      return {
        conversations: state.conversations.filter((c) => !gone.has(c.id)),
        messages,
        drafts,
        attachments,
        streams,
        variants,
      };
    });
    return removed;
  },

  async tagMany(conversationIds, tags, mode) {
    const affected = await tagConversations(conversationIds, tags, mode);
    // Re-read rather than computed locally. The three modes each combine with
    // whatever each row already carried, so reproducing the result in JavaScript
    // would mean reimplementing the SQL — and the tag filter chips above the list
    // are derived from these rows, so a near-miss shows up as a wrong count.
    await get().loadList(get().listOptions);
    return affected;
  },

  async send(conversationId, options) {
    return once(conversationId, async () => {
      if (get().streams[conversationId]) return;

      const content: ContentBlock[] = [];
      const text = options.text.trim();
      if (text) content.push({ type: 'text', text });
      if (options.attachments?.length) content.push(...options.attachments);
      if (!content.length) return;

      // The conversation is moving past the last reply, so its alternatives go now.
      // Keeping them would leave rows that no longer answer anything, and a later
      // regenerate could page one of them back into a history it was never written
      // for.
      if (get().variants[conversationId]?.variants.length) {
        await dropHiddenMessages(conversationId);
        set((state) => ({ variants: { ...state.variants, [conversationId]: { answersId: '', variants: [] } } }));
      }

      const message = await appendMessage(conversationId, { role: 'user', content });
      appendToTranscript(set, conversationId, message);
      // Both drafts clear together, and only after the row is stored: an attachment
      // dropped from the staging area before its message exists is a photo the user
      // has to take again.
      set((state) => {
        const attachments = { ...state.attachments };
        delete attachments[conversationId];
        return { drafts: { ...state.drafts, [conversationId]: '' }, attachments };
      });

      // First message names the conversation, so the list is readable without the
      // user having to rename anything.
      const conversation = await getConversation(conversationId);
      if (conversation && conversation.title === DEFAULT_TITLE && text) {
        await get().rename(conversationId, deriveTitle(text));
      }

      await runTurn(set, get, conversationId, {
        ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
      });
    });
  },

  async regenerate(conversationId, messageId) {
    return once(conversationId, async () => {
      if (get().streams[conversationId]) return;
      const messages = get().messages[conversationId] ?? (await listMessages(conversationId));
      const target = messages.find((m) => m.id === messageId);
      if (!target) return;

      // Regenerating an assistant reply rewinds to it; regenerating a user message
      // means "answer this again", so the rewind starts after it. The `inclusive`
      // flag is the whole mechanism — this used to also add `Number.EPSILON` to the
      // seq for the exclusive case, which expressed the intent but did nothing: one
      // ULP of a seq above 4 is larger than EPSILON, so the addition rounded away.
      const inclusive = target.role === 'assistant';
      const answersId = inclusive ? slotOf(messages, target.seq) : target.id;

      // Only the reply at the end of the conversation keeps its alternatives. Further
      // back, the turns after it were written against the answer being replaced, so
      // there is no history in which both versions make sense — that stays the
      // destructive rewind it has always been.
      if (!answersId || slotOf(messages, Number.POSITIVE_INFINITY) !== answersId) {
        await deleteMessagesFrom(conversationId, target.seq, inclusive);
        await get().reload(conversationId);
        await runTurn(set, get, conversationId, { regeneratedFrom: messageId });
        return;
      }

      const previous = await setTurnAside(conversationId, target.seq, inclusive, answersId);
      log.debug('chat', 'Kept the previous reply as a variant', { turnId: previous });
      await get().reload(conversationId);
      await runTurn(set, get, conversationId, { regeneratedFrom: messageId, turnId: newId('turn_'), answersId });
      // The new pass's rows are in the transcript already, but its `turn_id` only
      // becomes a *choice* once the variant set is re-read.
      await get().reload(conversationId);

      // A turn that wrote nothing at all — a connection that failed before the first
      // token, or a stop pressed on an empty reply — would otherwise leave the slot
      // with every variant hidden: the old answer still in the database, and no arrow
      // on screen able to reach it. Put it back. `selectTurn` directly rather than the
      // action, because a failed turn keeps its stream entry and the action refuses to
      // run while one exists.
      const slot = get().variants[conversationId];
      const newest = slot?.variants[slot.variants.length - 1];
      if (slot && newest && !slot.variants.some((v) => v.selected)) {
        await selectTurn(conversationId, slot.answersId, newest.turnId);
        await get().reload(conversationId);
      }
    });
  },

  async selectVariant(conversationId, index) {
    return once(conversationId, async () => {
      if (get().streams[conversationId]) return;
      const slot = get().variants[conversationId];
      const chosen = slot?.variants[index];
      if (!slot || !chosen || chosen.selected) return;
      await selectTurn(conversationId, slot.answersId, chosen.turnId);
      await get().reload(conversationId);
    });
  },

  async editAndResend(conversationId, messageId, text) {
    return once(conversationId, async () => {
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
    });
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
   *
   * Recorded twice on purpose. `excluded` is the column everything downstream
   * reads, and the trim ladder writes it too — recomputing it from scratch on every
   * send, which used to undo this the moment the user sent their next message.
   * {@link MessageMeta.userExcluded} is what tells the two apart.
   */
  async setExcluded(conversationId, messageId, excluded) {
    const messages = get().messages[conversationId] ?? (await listMessages(conversationId));
    const target = messages.find((m) => m.id === messageId);
    await updateMessage(messageId, { excluded, meta: { ...target?.meta, userExcluded: excluded } });
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

  async retryTurn(conversationId) {
    if (get().streams[conversationId]?.phase === 'streaming') return;
    const messages = get().messages[conversationId] ?? (await listMessages(conversationId));
    const last = messages[messages.length - 1];
    if (!last) return;
    get().dismissError(conversationId);
    // `regenerate` already knows the difference: a user message is answered again, a
    // partial assistant reply is rewound over.
    await get().regenerate(conversationId, last.id);
  },

  dismissError(conversationId) {
    // Dismissing the failure is also the way to say "don't send this on reconnect".
    useSendQueue.getState().drop(conversationId);
    set((state) => {
      const stream = state.streams[conversationId];
      if (!stream) return {};
      const streams = { ...state.streams };
      delete streams[conversationId];
      return { streams };
    });
  },

  async continueTurn(conversationId) {
    return once(conversationId, async () => {
      if (get().streams[conversationId]) return;
      get().dismissContextNote(conversationId);
      await runTurn(set, get, conversationId, {});
    });
  },

  dismissContextNote(conversationId) {
    set((state) => {
      if (state.contextNotes[conversationId] === undefined) return {};
      const contextNotes = { ...state.contextNotes };
      delete contextNotes[conversationId];
      const stalled = { ...state.stalled };
      delete stalled[conversationId];
      return { contextNotes, stalled };
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
                //
                // `previewOf` rather than the raw text: the database stores the
                // first line, clipped, and an optimistic patch that stored the
                // whole message made the row change shape on the next relaunch.
                //
                // A tool-only turn is excluded even though it has text — a skill
                // body flattens to a paragraph nobody wrote — matching what
                // `appendMessage` writes.
                ...(message.text && !isToolTurn(message.content) ? { preview: previewOf(message.text) } : {}),
              }
            : c,
        )
        .sort(byPinnedThenRecent),
    };
  });
}

/**
 * The variant grouping for every row one pass writes.
 *
 * Spread into all three `appendMessage` calls a turn can reach — the reply, the
 * tool results, and the partial reply a failure keeps — because a variant that
 * loses its tool rows leaves a `tool_use` unanswered, and the next request built
 * from that history is rejected outright.
 */
function turnColumns(options: RunOptions): { turnId?: string; answersId?: string } {
  if (!options.turnId || !options.answersId) return {};
  return { turnId: options.turnId, answersId: options.answersId };
}

/**
 * The last thing the user actually said before `beforeSeq`.
 *
 * The slot a regenerated reply answers. `role === 'user'` is not enough on its own:
 * tool results are stored as user messages — the API's convention — so the newest
 * `user` row in a tool-using turn is the app's own output, not a question anyone
 * asked. Empty string when there is none, which the caller reads as "nothing to
 * group by, rewind the old way".
 */
function slotOf(messages: readonly StoredMessage[], beforeSeq: number): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.seq >= beforeSeq) continue;
    if (message.role === 'user' && !isToolTurn(message.content)) return message.id;
  }
  return '';
}

/* -------------------------------------------------------------------------- */
/* The turn                                                                    */
/* -------------------------------------------------------------------------- */

interface RunOptions {
  modelOverride?: string;
  regeneratedFrom?: string;
  /**
   * Groups every row this pass writes, so paging away from the reply takes the tool
   * rows with it. Set only by `regenerate`; a first attempt needs no group.
   */
  turnId?: string;
  /** The user message this pass answers. Set with {@link RunOptions.turnId}. */
  answersId?: string;
  /**
   * How many times this turn has already been resumed after a `pause_turn`.
   *
   * Carried through the recursion rather than counted in the store because it is a
   * property of one turn, and the cap has to survive a screen change without
   * leaking into the next unrelated send.
   */
  pauseContinuations?: number;
  /**
   * How many `invoke_skill` rounds this turn has already run.
   *
   * Same reasoning as `pauseContinuations`: a property of this turn, not of the app.
   */
  toolRounds?: number;
}

/**
 * How many tool rounds one turn may run before the app stops it.
 *
 * Every round is a billed request carrying the whole history plus whatever the tool
 * returned, and a model that keeps calling tools instead of answering would spend
 * real money doing it. The user's `maxToolIterations` is the ceiling; it is clamped
 * to at least one round because zero would make every tool in the request a trap.
 */
function maxToolRounds(): number {
  return Math.max(1, getSetting('maxToolIterations'));
}

/**
 * Share of the context window the tool manifest may take.
 *
 * A tenth is enough for the built-ins plus a dozen MCP tools on a small model, and
 * leaves the window for the conversation — which is what the user is paying for.
 * Every request carries the whole manifest, so this is a per-round cost, not a
 * one-off.
 */
const TOOL_BUDGET_SHARE = 0.1;

/** What a resolved tool call returns, whichever kind of tool it was. */
interface ResolvedCall {
  content: string;
  isError?: true;
  /** The skill that was loaded, for the transcript badge. MCP calls have none. */
  name?: string;
  /** Images the tool returned, for transports that can carry one in a tool result. */
  images?: { mediaType: string; data: string }[];
  /** A file this call produced, for the transcript and the files list. */
  file?: { name: string; uri: string; bytes: number };
  /** True when plan mode refused the call, for the note above the composer. */
  blocked?: true;
}

/**
 * Route one `tool_use` block to whatever can answer it.
 *
 * Nothing here throws: an unknown name, a dead server, a user saying no — all of
 * them are tool *results*, because a `tool_use` left unanswered invalidates every
 * later request in the conversation.
 */
async function resolveCall(
  call: ToolUseBlock,
  skills: readonly Skill[],
  servers: readonly string[] | undefined,
  planMode = false,
): Promise<ResolvedCall> {
  // A truncated arguments blob never reaches a tool. `blocksOf` keeps it verbatim as
  // evidence the stream was cut off, and forwarding it would send a server
  // `{"__unparsed": "{\"path\": \"/et"}` — which fails as a schema error the model
  // cannot read as "your last call was cut off, send it again".
  if (call.input !== null && typeof call.input === 'object' && '__unparsed' in (call.input as object)) {
    return {
      content: `The arguments for ${call.name} arrived incomplete, so it was not run. Call it again.`,
      isError: true,
    };
  }
  // Before the routing, not inside each branch: a gate the user switched on has to
  // hold for every tool, including one added later that nobody thought to gate.
  if (planMode && blockedInPlanMode(call.name)) return { content: planRefusal(call.name), isError: true, blocked: true };
  if (call.name === INVOKE_SKILL) return resolveSkillCall(call.input, skills);
  if (call.name === WRITE_FILE) return resolveWriteFile(call.input);
  if (call.name === CREATE_PDF) return resolvePdf(call.input);
  if (call.name === CREATE_DOCUMENT) return resolveDocument(call.input);
  if (call.name === FETCH_URL) return resolveFetch(call.input);
  if (call.name === RUN_CODE) return resolveRunCode(call.input);
  if (call.name === READ_RESOURCE) return resolveResource(call.input, servers);
  if (call.name.startsWith(`${MCP_TOOL_PREFIX}_`)) return useMcp.getState().invoke(call.name, call.input, servers);
  return { content: `There is no tool called "${call.name}".`, isError: true };
}

/**
 * Writes the file the model asked for.
 *
 * The result names the file and says where it went, because the model's next sentence
 * is going to tell the user about it and "saved to your device" with no name is not
 * something a user can find. The `file` field is what puts a card in the transcript.
 */
async function resolveWriteFile(input: unknown): Promise<ResolvedCall> {
  const request = parseWriteFile(input);
  if (!request.ok) return { content: request.reason, isError: true };
  try {
    const file = await writeGeneratedFile(request.name, request.content);
    return {
      content: `Wrote ${file.name} (${formatBytes(file.bytes)}). It is in the app's files, where the user can share or open it.`,
      file: { name: file.name, uri: file.uri, bytes: file.bytes },
    };
  } catch (error) {
    return { content: `Could not write that file: ${message(error)}`, isError: true };
  }
}

/** Renders the PDF. Same shape as {@link resolveWriteFile}, different renderer. */
async function resolvePdf(input: unknown): Promise<ResolvedCall> {
  const request = parsePdf(input);
  if (!request.ok) return { content: request.reason, isError: true };
  try {
    const file = await writePdf(request.name, request.title, request.markdown);
    return {
      content: `Wrote ${file.name} (${formatBytes(file.bytes)}) as a PDF. It is in the app's files, where the user can share or open it.`,
      file: { name: file.name, uri: file.uri, bytes: file.bytes },
    };
  } catch (error) {
    return { content: `Could not render that PDF: ${message(error)}`, isError: true };
  }
}

/**
 * Writes the Word, Excel or PowerPoint file.
 *
 * The result says the file is editable, which is the whole reason this tool exists next
 * to `create_pdf`: a model that cannot tell the two apart will reach for the PDF, and a
 * PDF is where a document goes to stop being changed.
 */
async function resolveDocument(input: unknown): Promise<ResolvedCall> {
  const request = parseDocument(input);
  if (!request.ok) return { content: request.reason, isError: true };
  try {
    const file = await writeGeneratedFile(request.name, officeDocument(request.markdown, request.format));
    return {
      content:
        `Wrote ${file.name} (${formatBytes(file.bytes)}). It is in the app's files, where the user can preview, ` +
        `edit in Word, Excel or PowerPoint, save to a folder or share it.`,
      file: { name: file.name, uri: file.uri, bytes: file.bytes },
    };
  } catch (error) {
    return { content: `Could not write that document: ${message(error)}`, isError: true };
  }
}

/**
 * Fetches a page, if the user has switched web access on.
 *
 * The switch is re-read here rather than trusted from the manifest: the tool was
 * offered when the turn started, and a user who turned it off mid-turn has said no.
 */
async function resolveFetch(input: unknown): Promise<ResolvedCall> {
  if (!getSetting('allowWebFetch')) {
    return {
      content: 'Web access is switched off in this app (Settings → Tools). Ask the user to turn it on if the task needs it.',
      isError: true,
    };
  }
  const outcome = await fetchAsText(input);
  return outcome.isError ? { content: outcome.content, isError: true } : { content: outcome.content };
}

/**
 * Runs the model's code in the sandbox, if the user has switched it on.
 *
 * Re-reads the setting for the same reason `resolveFetch` does. Output is returned even
 * when the program threw: a stack trace is the most useful thing the model can be given
 * to fix its own code, and "it failed" is not.
 */
async function resolveRunCode(input: unknown): Promise<ResolvedCall> {
  if (!getSetting('allowRunCode')) {
    return {
      content:
        'Running code is switched off in this app (Settings → Built-in tools). Ask the user to turn it on if the task needs it.',
      isError: true,
    };
  }
  const request = parseRunCode(input);
  if (!request.ok) return { content: request.reason, isError: true };
  const result = await runInSandbox(request.code);
  if (!result.ok) {
    return { content: result.output || 'The code produced no output and did not finish cleanly.', isError: true };
  }
  return { content: result.output || 'The code ran and printed nothing.' };
}

/**
 * Reads an MCP resource, or lists what there is.
 *
 * Calling with no URI lists rather than failing: the enum in the schema can be long
 * enough to have been trimmed, and a model that cannot see the list would otherwise
 * guess at URIs.
 */
async function resolveResource(input: unknown, servers: readonly string[] | undefined): Promise<ResolvedCall> {
  const uri =
    input !== null && typeof input === 'object' && typeof (input as { uri?: unknown }).uri === 'string'
      ? (input as { uri: string }).uri
      : '';
  if (!uri) {
    const available = useMcp.getState().resources(servers);
    if (!available.length) return { content: 'No server in this conversation advertises any resources.', isError: true };
    return {
      content: ['Available resources:', ...available.map((r) => `- ${r.uri} (${r.serverName}): ${r.description}`)].join('\n'),
    };
  }
  const result = await useMcp.getState().readResource(uri, servers);
  return result.isError ? { content: result.content, isError: true } : { content: result.content };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How many times a paused turn will be resumed before the app stops on its own.
 *
 * `pause_turn` is the API asking to be called again with the partial turn appended;
 * each resumption is a billed request, so an unbounded loop is a bill the user
 * never approved. Three is enough for the long server-side tool runs this exists
 * for and small enough to be affordable when something upstream is stuck.
 */
const MAX_PAUSE_CONTINUATIONS = 3;

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

  // Any new attempt takes the conversation out of the offline queue; a failure that
  // is still a network failure puts it straight back.
  useSendQueue.getState().drop(conversationId);

  const profile = useProviders.getState().byId(conversation.profileId) ?? activeProfile();
  const model = options.modelOverride ?? conversation.model;
  const capabilities = capabilitiesFor(profile.id, model);
  const wireHints = wireHintsFor(profile.id, model);
  /** Read once per turn: a toggle flipped mid-stream must not half-apply. */
  const planMode = conversation.config.planMode === true;

  const live: LiveStream = {
    conversationId,
    model,
    startedAt: Date.now(),
    phase: 'preparing',
    text: '',
    thinking: '',
    toolIndex: new Map(),
    redactedThinking: [],
    serverTools: [],
    citations: [],
    usage: {},
    droppedParams: [],
    requestIds: [],
    stopReason: 'unknown',
    aborting: false,
  };

  let lastCommit = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Set to the next continuation index when the turn ended on `pause_turn`. */
  let resume: number | null = null;
  /** Set to the next round index when the turn ended asking for a skill. */
  let toolRound: number | null = null;
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
  // Asked here rather than at launch: a permission dialog makes sense a second after
  // the user sent something long, and makes none on a first cold start.
  void primeNotifications();

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

    // Read once per turn rather than per attempt: a retry has to send the same
    // prompt it estimated, and `promptBlock` returns nothing at all when the
    // memory switch is off. Read *before* the context strategy, because the memory
    // block is part of the prefix the history budget is computed against.
    const memoryBlock = useMemory.getState().promptBlock(conversation.config.memory);
    const calibrationKey = `${profile.id}::${model}`;
    const calibrationFactor = useCalibration.getState().factorFor(calibrationKey);
    const toolCalibrationFactor = useCalibration.getState().toolFactorFor(calibrationKey);

    // The project, for the same reason and read at the same point: its instructions
    // and documents are part of the prefix the history budget is computed against.
    if (conversation.projectId && !useProjects.getState().loaded) await useProjects.getState().load();
    const systemPrompt = projectSystemPrompt(
      useProjects.getState().byId(conversation.projectId),
      conversation.systemPrompt,
    );

    // The skills this conversation switched on, resolved against what is installed.
    // Loaded on demand rather than assumed: the startup load is fire-and-forget, and
    // a send during the first second of the app's life would otherwise silently get
    // no catalogue.
    if (conversation.config.skills?.length && !useSkills.getState().loaded) await useSkills.getState().load();
    const enabledSkills = useSkills.getState().enabledFor(conversation.config.skills);
    const skillCatalogue = renderSkillCatalogue(enabledSkills);

    // The same, for MCP servers: the definitions come from what discovery stored, so
    // an unreachable server still contributes its tools and fails per call rather
    // than blocking the send.
    if (conversation.config.servers?.length && !useMcp.getState().loaded) await useMcp.getState().load();
    const bridged = useMcp.getState().bridge(conversation.config.servers);

    // The manifest, fitted to a budget. `selectTools` existed with tests and no
    // caller, which was fine while the only tools were one skill loader and whatever
    // MCP contributed; with the built-ins added, a conversation on a small model with
    // two chatty servers can spend a third of its window on tool JSON before a word
    // is sent. `required` keeps the built-ins, which are small and always relevant;
    // the rest compete for what is left.
    const offered = [
      ...(enabledSkills.length ? [invokeSkillTool(enabledSkills)] : []),
      ...builtinTools({
        web: getSetting('allowWebFetch'),
        code: getSetting('allowRunCode'),
        resources: useMcp.getState().resources(conversation.config.servers).map((resource) => resource.uri),
      }),
      ...bridged.map((tool) => tool.definition),
    ];
    const selection = selectTools({
      tools: offered,
      budget: Math.round(capabilities.contextWindow * TOOL_BUDGET_SHARE),
      required: [INVOKE_SKILL, WRITE_FILE, CREATE_PDF, CREATE_DOCUMENT],
    });
    const withheldNote = describeWithheldTools(selection.withheld);

    const { messages, summary, changed, trim, summaryFailed } = await applyContextStrategy({
      conversationId,
      conversation,
      stored,
      capabilities,
      live,
      publish,
      signal: controller.signal,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(memoryBlock.text ? { memory: memoryBlock.text } : {}),
      ...(skillCatalogue ? { skills: skillCatalogue } : {}),
      ...(selection.tools.length ? { tools: selection.tools } : {}),
      calibration: calibrationFactor,
      toolCalibration: toolCalibrationFactor,
    });

    if (changed) await get().reload(conversationId);

    if (trim?.actions.length) {
      // Sizes and step names only. The trimmed content is conversation text, and
      // `redactString` protects keys rather than content.
      log.info('chat', describeTrim(trim), {
        before: trim.before,
        after: trim.after,
        steps: trim.actions.map((action) => `${action.step}:${action.saved}`),
      });
    }

    // The same sentence, on screen. `describeTrim` is written for a person, and the
    // debug log is not where a user finds out that four of their turns were left
    // out of the request they just paid for.
    const note = [trim?.actions.length ? describeTrim(trim) : '', summaryFailed ? SUMMARY_FAILED_NOTE : '']
      .filter(Boolean)
      .join(' ');
    setContextNote(set, conversationId, note);

    const request = buildRequest({
      transport: profile.kind,
      model,
      capabilities,
      wireHints,
      config: conversation.config,
      ...(systemPrompt ? { systemPrompt } : {}),
      messages,
      ...(summary ? { summary } : {}),
      ...(memoryBlock.text ? { memory: memoryBlock.text } : {}),
      ...(skillCatalogue ? { skills: skillCatalogue } : {}),
      ...(withheldNote ? { withheld: withheldNote } : {}),
      ...(selection.tools.length ? { tools: selection.tools } : {}),
    });
    // Provider-side search is not part of the manifest: it is not a tool this app can
    // answer, so offering it on a transport that cannot run it would leave the model
    // calling into nothing. Anthropic only, and only when the user has switched it on.
    if (profile.kind === 'anthropic' && getSetting('allowWebSearch')) {
      request.serverTools = { webSearch: {} };
    }
    // Breakpoints last, over the assembled request, and suppressed when history was
    // rewritten this turn: a rewritten prefix cannot be a cache hit, so asking for
    // a write would pay the 1.25× premium for an entry nothing will read.
    const cachePlan = planCacheForRequest(request, {
      enabled: getSetting('promptCaching'),
      supported: profile.kind === 'anthropic' && capabilities.promptCache !== false,
      historyRewritten: Boolean(trim?.actions.length),
    });
    if (!cachePlan.reason) {
      request.cache = {
        tools: cachePlan.tools,
        system: cachePlan.system,
        ...(cachePlan.historyThrough !== undefined ? { historyThrough: cachePlan.historyThrough } : {}),
      };
    }

    live.phase = 'connecting';
    publish(true);

    // What the composer's gauge would have said about this exact prompt. Kept so the
    // gateway's own `prompt_tokens` can be compared against it below — the only
    // ground truth this app ever gets about its estimator. The tool share is kept
    // separately so the manifest can be calibrated against the residual rather than
    // being blended into one factor with prose it tokenizes nothing like.
    const estimate = estimateRequestTokens(request);
    const estimatedPrompt = estimate.total;

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
        onRequest: (requestId) => live.requestIds.push(requestId),
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

    const usage = reportedUsage(live.usage);
    const blocks = blocksOf(live);
    const meta: MessageMeta = {};
    if (live.droppedParams.length) meta.droppedParams = live.droppedParams.map((d) => d.param);
    if (live.requestIds.length) meta.requestIds = [...live.requestIds];
    if (options.modelOverride) meta.modelOverride = true;
    if (options.regeneratedFrom) meta.regeneratedFrom = options.regeneratedFrom;
    if (request.reasoning?.effort) meta.effort = request.reasoning.effort;
    if (request.reasoning?.budgetTokens) meta.budgetTokens = request.reasoning.budgetTokens;
    if (live.failover) meta.failedOverTo = live.failover.to;

    // Every tool call this turn made, resolved before the assistant row is written so
    // its `meta` can name the skills — which is what puts them in the transcript's
    // badges rather than only in the tool result blocks.
    //
    // Calls that will stop to ask the user run one at a time: two approval sheets
    // fighting over the screen is not an interface. Everything already approved runs
    // together, which is the difference between a five-tool round costing five
    // sequential network waits and costing one.
    const calls = blocks.filter((block): block is ToolUseBlock => block.type === 'tool_use');
    const invocations: { call: ToolUseBlock; result: ResolvedCall }[] = [];
    if (calls.length) {
      live.phase = 'tools';
      publish(true);

      const asks = (call: ToolUseBlock): boolean =>
        call.name.startsWith(`${MCP_TOOL_PREFIX}_`) &&
        useMcp.getState().needsApproval(call.name, conversation.config.servers);
      const resolve = (call: ToolUseBlock) =>
        resolveCall(call, enabledSkills, conversation.config.servers, planMode);

      const settled = new Map<string, ResolvedCall>();
      await Promise.all(
        calls.filter((call) => !asks(call)).map(async (call) => void settled.set(call.id, await resolve(call))),
      );
      for (const call of calls.filter(asks)) settled.set(call.id, await resolve(call));

      // Back into the model's own order: a `tool_result` block has to line up with
      // the `tool_use` it answers.
      for (const call of calls) {
        const result = settled.get(call.id);
        if (result) invocations.push({ call, result });
      }
      live.phase = 'saving';
      publish(true);

      // Said out loud, because the difference between "the model planned" and "the
      // model did it" is not visible in a transcript that reads the same either way.
      const blockedNote = describeBlockedCalls(invocations.filter((i) => i.result.blocked).length);
      if (blockedNote) setContextNote(set, conversationId, blockedNote);
    }
    const invoked = invocations.map((i) => i.result.name).filter((name): name is string => Boolean(name));
    if (invoked.length) meta.skillsInvoked = invoked;
    if (invocations.length) meta.toolRounds = (options.toolRounds ?? 0) + 1;

    const message = await appendMessage(conversationId, {
      role: 'assistant',
      content: blocks,
      model,
      usage,
      stopReason: live.stopReason,
      ...(Object.keys(meta).length ? { meta } : {}),
      ...turnColumns(options),
    });
    appendToTranscript(set, conversationId, message);

    // One labelled sample of how wrong the estimator is for this model. Only when
    // the gateway actually reported a prompt count — an absent one is not a zero.
    if (usage.input !== undefined) {
      useCalibration.getState().record(calibrationKey, estimatedPrompt, usage.input, estimate.tools);
    }

    const pricing = useModels.getState().get(`${profile.id}::${model}`)?.pricing;
    await recordUsage({      profileId: profile.id,
      model,
      usage,
      conversationId,
      ...(pricing ? { pricing } : {}),
    });

    clearStream(set, conversationId);

    if (memoryBlock.included.length) useMemory.getState().noteUsed(memoryBlock.included.map((m) => m.id));

    // After the stream is cleared, unawaited, and unable to throw: the turn has
    // already succeeded and the user is reading the answer. A distillation pass
    // that fails, or that the user navigates away from, must not turn a completed
    // turn into a visible error. The throttle lives in the store.
    //
    // Skipped on a turn that only asked for a skill: there is no answer yet to learn
    // anything from, and the round that produces one will run this.
    if (!invocations.length) {
      void useMemory.getState().distil({
        conversationId,
        profileId: profile.id,
        model,
        ...(conversation.config.memory !== undefined ? { memory: conversation.config.memory } : {}),
        messages: get().messages[conversationId] ?? [],
      });
    }

    // A `tool_use` stop is the model asking for a skill body. The results go in as a
    // `user` message — the API's convention for tool output, and what
    // `MessageView` re-attributes so it does not read as something the user said —
    // and then the turn is run again so the model can answer with what it now knows.
    //
    // The results are stored even when the cap stops the loop: a `tool_use` left
    // unanswered in the history makes every later request invalid, so refusing to
    // continue must not also refuse to close the call.
    if (invocations.length) {
      // Images ride along only where they can be seen: a text-only model would get a
      // request rejected for a block it cannot take, and the result text already
      // names what the tool returned.
      const carryImages = capabilities.vision === true && profile.kind === 'anthropic';
      const results = await appendMessage(conversationId, {
        role: 'user',
        content: invocations.map(({ call, result }) => ({
          type: 'tool_result' as const,
          toolUseId: call.id,
          content: result.content,
          ...(carryImages && result.images?.length ? { images: result.images } : {}),
          ...(result.isError ? { isError: true } : {}),
        })),
        ...turnColumns(options),
      });
      appendToTranscript(set, conversationId, results);

      const done = options.toolRounds ?? 0;
      if (done + 1 < maxToolRounds()) toolRound = done + 1;
      else {
        log.warn('chat', 'The model kept calling tools without answering; stopping', { rounds: done + 1 });
        setContextNote(
          set,
          conversationId,
          `The model called tools ${done + 1} times without answering, so this turn was stopped.`,
          true,
        );
      }
    }

    // `pause_turn` is not an answer: it is the API saying "call me again with what
    // you have". The stored assistant message is the partial turn, so resuming is a
    // plain send with no new user message — the transcript already ends where the
    // model left off. Presenting it as a finished reply is how a half-done turn
    // looks like a model that stopped mid-sentence for no reason.
    if (live.stopReason === 'pause_turn') {
      const done = options.pauseContinuations ?? 0;
      if (done < MAX_PAUSE_CONTINUATIONS) resume = done + 1;
      else {
        log.warn('chat', 'The model paused this turn too many times; stopping', { continuations: done });
        setContextNote(
          set,
          conversationId,
          `The model paused and was resumed ${done} times without finishing, so this turn was stopped.`,
          true,
        );
      }
    }
  } catch (error) {
    await handleTurnFailure(set, conversationId, live, error, options);
  } finally {
    await finish();
  }

  // Outside the `finally`, so the resumed turn registers its own abort controller
  // after this one has been cleaned up rather than racing it.
  if (resume !== null) await runTurn(set, get, conversationId, { ...options, pauseContinuations: resume });
  else if (toolRound !== null) await runTurn(set, get, conversationId, { ...options, toolRounds: toolRound });
  // Neither branch taken means the reply is finished rather than merely paused, so
  // this is the one place a turn ends — a tool round or a continuation is not an
  // answer and must not buzz the phone as if it were. `notifyReplyReady` decides
  // whether anything is shown; a foreground turn and an abort say nothing.
  else
    await notifyReplyReady({
      conversationId,
      title: conversation.title === DEFAULT_TITLE ? '' : conversation.title,
      text: live.text,
      stopReason: live.stopReason,
    });
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
  if (live.requestIds.length) meta.requestIds = [...live.requestIds];
  if (options.modelOverride) meta.modelOverride = true;
  if (live.failover) meta.failedOverTo = live.failover.to;

  if (blocks.length) {
    const message = await appendMessage(conversationId, {
      role: 'assistant',
      content: blocks,
      model: live.model,
      usage: reportedUsage(live.usage),
      stopReason: aborted ? 'aborted' : live.stopReason,
      ...(aborted ? {} : { error: detail }),
      ...(Object.keys(meta).length ? { meta } : {}),
      ...turnColumns(options),
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
  if (gatewayError?.kind === 'network') {
    useReachability.getState().markUnreachable(detail);
    // Queued for the reconnect, not resent here: the user's message is already a
    // row, so the queue only has to remember which conversation is waiting.
    useSendQueue.getState().queue(conversationId);
  } else if (gatewayError) useReachability.getState().markReachable();
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

/** Records (or clears, on an empty string) what the last turn did to the context. */
function setContextNote(set: Setter, conversationId: string, note: string, continuable = false): void {
  set((state) => {
    const contextNotes = { ...state.contextNotes };
    if (note) contextNotes[conversationId] = note;
    else delete contextNotes[conversationId];
    const stalled = { ...state.stalled };
    if (continuable) stalled[conversationId] = true;
    else delete stalled[conversationId];
    return { contextNotes, stalled };
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
    case 'server_tool':
      live.serverTools.push(event.block);
      break;
    case 'citation':
      // Same de-dupe as the transport accumulator: a provider cites one page for
      // several consecutive sentences, and eight identical rows is not a source list.
      if (!live.citations.some((existing) => existing.url === event.citation.url)) {
        live.citations.push(event.citation);
      }
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
  /**
   * The conversation's prompt with its project folded in, when there is one.
   *
   * Passed rather than read off `conversation`, because the project's instructions and
   * documents are part of the prefix the request will carry: budgeting against the
   * conversation's own prompt alone is how a project with 40k characters of knowledge
   * plans a history that does not fit.
   */
  systemPrompt?: string;
  /** The rendered memory block, so the budget counts what the request will carry. */
  memory?: string;
  /** The skill catalogue, for the same reason. */
  skills?: string;
  /**
   * The tool manifest this turn will carry, for the same reason again.
   *
   * `budget.ts` was written to count tools and was never handed any, so a
   * conversation with two chatty MCP servers planned its history against a prefix
   * tens of thousands of tokens smaller than the one that went on the wire — the
   * exact failure `prefixCost` counting tools exists to prevent.
   */
  tools?: readonly ToolDefinition[];
  /** Correction factor for this model's estimator, from `@/stores/calibration`. */
  calibration?: number;
  /** The same, measured against tool definitions rather than prose. */
  toolCalibration?: number;
}

interface StrategyResult {
  messages: UnifiedMessage[];
  summary?: string;
  /** True when any message's `excluded` flag changed and the transcript is stale. */
  changed: boolean;
  /** What the trim ladder gave up, when it ran. Absent when nothing was trimmed. */
  trim?: TrimReport;
  /** Set when summarisation was wanted and failed, so the turn can say so. */
  summaryFailed?: boolean;
}

/**
 * Decides which turns actually go on the wire.
 *
 * `warn` sends everything and lets the pressure indicator do the talking, because
 * silently truncating a conversation the user can see in front of them is worse
 * than a rejected request. The other two strategies trim, via the ladder in
 * `@/chat/trim` — replayed reasoning first, then long tool results, and only then
 * whole turns.
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
  //
  // A row the *user* excluded is not eligible at all — not on the wire, and not
  // passed to `setExclusions`, which is what keeps the recomputation below from
  // resetting a flag it did not set. Trim-set exclusions are deliberately not
  // filtered here: those are this function's own previous answer, and it recomputes
  // them from scratch so a bigger window brings those turns back.
  const eligible = stored.filter((m) => m.content.length > 0 && !m.meta?.userExcluded);
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

  // The same prefix the request will actually carry — prompt, memory, skills and
  // summary — rather than the prompt alone. Counting less than is sent is how a
  // budget declared roomy produces a request over the window.
  const system = composeSystem(input.systemPrompt ?? conversation.systemPrompt, previousSummary, input.memory, input.skills);
  const budget = planTurn({
    transport: 'anthropic',
    contextWindow: capabilities.contextWindow,
    params,
    ...(conversation.config.reasoning ? { reasoning: conversation.config.reasoning } : {}),
    ...(system ? { system } : {}),
    ...(input.tools?.length ? { tools: input.tools } : {}),
    ...(input.calibration ? { calibration: input.calibration } : {}),
    ...(input.toolCalibration ? { toolCalibration: input.toolCalibration } : {}),
  });

  // With the ladder off, the two cheap steps are disabled by making them
  // impossible rather than by a flag inside `trimToBudget`: keeping thinking in
  // every message and capping tool results at infinity leaves only the old
  // behaviour, dropping whole turns.
  const trimOptions = getSetting('progressiveTrim')
    ? {}
    : { keepThinkingInLast: all.length, toolResultCap: Number.MAX_SAFE_INTEGER };
  const report = trimToBudget(all, budget.history, trimOptions);
  if (!report.actions.length) return sendEverything();

  const droppedMessages = report.dropped
    .map((index) => eligible[index])
    .filter((m): m is StoredMessage => Boolean(m));
  const changed = await setExclusions(eligible, new Set(droppedMessages.map((m) => m.id)));

  const wantsSummary = strategy === 'summarise' && droppedMessages.length > 0;
  const outcome = wantsSummary
    ? await summariseDropped(input, droppedMessages, previousSummary)
    : { text: previousSummary, failed: false };
  const summary = outcome.text;

  return {
    messages: report.messages,
    ...(summary ? { summary } : {}),
    changed,
    trim: report,
    ...(outcome.failed ? { summaryFailed: true } : {}),
  };
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
 * the message the user just sent — but the caller is told, because a reply that
 * quietly forgot the first half of the conversation reads as the model being
 * stupid rather than as a summarisation that failed.
 *
 * Three things here are not incidental:
 *
 *  - **The result is bounded** by `boundSummary`, so a summary of summaries
 *    terminates. Without it the notes grow every time they are extended and are
 *    charged as input on every remaining turn.
 *  - **Its usage is its own `usage_event`.** This is the only request the app
 *    makes that the user did not ask for, and a bill that grows for invisible
 *    reasons is a trust failure rather than a rounding error. It carries the
 *    conversation's id, so the dashboard can attribute the spend to the thread
 *    that caused it.
 *  - **The config write re-reads the row first.** `input.conversation` was read
 *    before the stream started; spreading that stale copy would clobber any
 *    setting changed since — the merge-not-replace rule from the data model.
 */
async function summariseDropped(
  input: StrategyInput,
  dropped: readonly StoredMessage[],
  previous: string | undefined,
): Promise<{ text: string | undefined; failed: boolean }> {
  if (!dropped.length) return { text: previous, failed: false };

  input.live.phase = 'summarising';
  input.publish(true);

  const transcript = dropped
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${flattenContent(m.content)}`)
    .join('\n\n');

  try {
    const { transport } = await resolveTransport({ profileId: input.conversation.profileId });
    const result = await transport.complete(
      {
        model: input.conversation.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: summaryRequestBody(previous, transcript) }] }],
        params: { maxTokens: 1_024 },
      },
      { signal: input.signal },
    );

    const usage = reportedUsage(result.usage);
    if (Object.keys(usage).length) {
      const pricing = useModels.getState().get(`${input.conversation.profileId}::${input.conversation.model}`)?.pricing;
      await recordUsage({
        profileId: input.conversation.profileId,
        model: input.conversation.model,
        usage,
        conversationId: input.conversationId,
        ...(pricing ? { pricing } : {}),
      });
    }

    const summary = boundSummary(
      result.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    );
    if (!summary) return { text: previous, failed: true };

    const lastDropped = dropped[dropped.length - 1];
    const fresh = await getConversation(input.conversationId);
    await updateConversation(input.conversationId, {
      config: {
        ...(fresh?.config ?? input.conversation.config),
        summary: { throughSeq: lastDropped?.seq ?? 0, text: summary },
      },
    });
    return { text: summary, failed: false };
  } catch (error) {
    log.warn('chat', 'Could not summarise the dropped turns; sending without a summary', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { text: previous, failed: true };
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

/** What the last turn's context handling did, if it did anything. */
export function useContextNote(conversationId: string): string | undefined {
  return useChat((state) => state.contextNotes[conversationId]);
}

/** Whether the last turn stopped at a cap and can simply be asked to carry on. */
export function useCanContinue(conversationId: string): boolean {
  return useChat((state) => state.stalled[conversationId] === true);
}

const NO_VARIANTS: TurnVariant[] = [];

/**
 * The alternative replies to the last user message, oldest attempt first.
 *
 * Empty until that reply has been regenerated, which is what the pager keys off:
 * one answer is not a set of choices, and an arrow with nowhere to go is worse than
 * no arrow.
 */
export function useVariants(conversationId: string): TurnVariant[] {
  return useChat((state) => state.variants[conversationId]?.variants ?? NO_VARIANTS);
}

const NO_ATTACHMENTS: ContentBlock[] = [];

/**
 * The attachments staged for this conversation.
 *
 * A shared frozen-by-convention empty array rather than `[]`, for the same reason
 * `useMessages` does it: a fresh literal is a new identity on every render, which
 * would defeat every memo downstream of the composer on the screen that re-renders
 * most often.
 */
export function useAttachments(conversationId: string): ContentBlock[] {
  return useChat((state) => state.attachments[conversationId] ?? NO_ATTACHMENTS);
}
