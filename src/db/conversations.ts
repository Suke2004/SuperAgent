/**
 * Conversation and message persistence.
 *
 * The only module that writes SQL for chat data. Everything above it works with
 * the types declared here, so the storage shape — JSON content blocks, a
 * denormalised text column, float sequence keys — stays an implementation detail.
 *
 * Two conventions worth knowing before reading the queries:
 *
 *   - Content is stored as JSON `ContentBlock[]`, which is what gets sent to the
 *     gateway, plus a flattened `text` column that FTS indexes and the list
 *     previews read. Both are written by the same statement so they cannot drift.
 *   - `seq` is a float. Appending uses `max(seq) + 1`; inserting between two
 *     messages averages their keys. Renumbering a conversation to keep integers
 *     tidy would rewrite every row for no benefit.
 */

import {
  addTagSql,
  chunk,
  clearTagsSql,
  deleteConversationsSql,
  normaliseIds,
  removeTagSql,
  setArchivedSql,
} from '@/db/bulk';
import { buildListQuery, DEFAULT_PAGE_SIZE, nextCursor } from '@/db/list-query';
import type { ListCursor } from '@/db/list-query';
import { DEFAULT_TITLE, flattenContent, isToolTurn, previewOf } from '@/db/content';
import { database, localDay } from '@/db/schema';
import { buildFtsQuery, buildLikePattern, excerpt, LIKE_ESCAPE } from '@/db/search';
import {
  ANCHOR_SLOT_SQL,
  DROP_HIDDEN_SQL,
  HIDE_TURN_SQL,
  LIST_TURNS_SQL,
  NEWEST_SLOT_SQL,
  SELECT_TURN_SQL,
  stampTurnSql,
} from '@/db/variants';
import { newId } from '@/lib/id';
import { log } from '@/lib/log';
import { estimateCost } from '@/lib/tokens';
import type { ModelPricing } from '@/lib/tokens';
import type {
  ContentBlock,
  ReasoningConfig,
  ReasoningEffort,
  SamplingParams,
  StopReason,
  TokenUsage,
  UnifiedMessage,
  UnifiedRole,
} from '@/transports/types';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Everything a conversation remembers about how to send its next request.
 *
 * Stored as one JSON column. Nothing queries these, and a column per control
 * would mean a migration every time Phase 2 adds a knob.
 */
export interface ConversationConfig {
  params?: Partial<SamplingParams>;
  reasoning?: ReasoningConfig;
  /**
   * Skill names enabled for this conversation. Phase 4.
   *
   * Names, not ids, because the model has to type one back as the `invoke_skill`
   * argument — which is also why `skills.name` is unique.
   */
  skills?: string[];
  /** MCP server names enabled for this conversation. Phase 5. Names, as above. */
  servers?: string[];
  /** Overrides the global context strategy for this conversation. */
  contextStrategy?: 'warn' | 'drop_oldest' | 'summarise';
  /**
   * Rolling summary of turns the `summarise` strategy dropped.
   *
   * `throughSeq` records how far it covers, so a later trim can extend it rather
   * than re-summarising the whole history on every message.
   */
  summary?: { throughSeq: number; text: string };
  /** Remembered expand/collapse choice for the reasoning pane. */
  showThinking?: boolean;
  /**
   * Propose before acting: tools that would change something are refused.
   *
   * Per-conversation rather than global because it is a property of the task, not of
   * the user — the chat where a model is rewriting files wants it on and the one
   * answering questions has nothing to gate. See `@/chat/plan`.
   */
  planMode?: boolean;
  /**
   * Opt this conversation out of long-term memory.
   *
   * Only `false` does anything: absent and `true` both defer to the global setting.
   * See `memoryAppliesTo` in `@/chat/memory` for why it cannot switch memory on.
   */
  memory?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  systemPrompt?: string;
  profileId: string;
  model: string;
  config: ConversationConfig;
  forkedFromId?: string;
  forkedFromMessageId?: string;
  lastMessageAt?: number;
  preview?: string;
  /** The project this conversation belongs to, if any. See `@/chat/project`. */
  projectId?: string;
  tags: string[];
  /** Populated by {@link listConversations}; absent on a single read. */
  messageCount?: number;
}

/** Per-message provenance the transcript shows and the request builder reads. */
export interface MessageMeta {
  /** Params the gateway rejected, surfaced under the message. */
  droppedParams?: string[];
  /** Reasoning settings actually sent, so the transcript reflects history. */
  effort?: ReasoningEffort;
  budgetTokens?: number;
  /** True when this single message overrode the conversation's model. */
  modelOverride?: boolean;
  /** Set when the user edited an existing message rather than writing a new one. */
  editedAt?: number;
  /** Set on a regenerated reply, pointing at the message it replaced. */
  regeneratedFrom?: string;
  /** Skills the model pulled in during this turn. Phase 4. */
  skillsInvoked?: string[];
  /** Number of tool round trips this turn took. Phase 5. */
  toolRounds?: number;
  /** True when the reply was cut short by the stop button. */
  aborted?: boolean;
  /** The base URL used, when it differed from the profile's primary. */
  failedOverTo?: string;
  /**
   * Debug log ids of the HTTP requests this turn opened, for the developer panel.
   *
   * Ids, not payloads: the bodies are large, they are already in `@/lib/log`'s ring
   * buffer with the key redacted, and copying them into every row would put an
   * unredacted-by-accident request one schema change away from being on disk
   * forever. The cost is that the panel has nothing to show after a restart, which
   * is the right trade for a debugging aid.
   */
  requestIds?: string[];
  /**
   * Set when *the user* excluded this message, as opposed to the trim ladder.
   *
   * Both write the same `excluded` column, and the column alone cannot tell them
   * apart — which is why the manual flag used to survive exactly until the next
   * send, when `applyContextStrategy` recomputed exclusions from scratch and reset
   * it. This is the durable half; `excluded` stays the single flag everything
   * downstream reads, so `toUnifiedMessages` and the transcript badge need no
   * knowledge of who set it.
   *
   * In `meta` rather than its own column because `meta` is schema-free JSON: no
   * migration, and nothing to do for rows written before it existed.
   */
  userExcluded?: boolean;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: UnifiedRole;
  createdAt: number;
  content: ContentBlock[];
  text: string;
  model?: string;
  /**
   * Exactly what the gateway reported, with absences preserved.
   *
   * `Partial` rather than `TokenUsage`: a gateway that streams no prompt usage must
   * not be recorded as having billed zero input, because the row then reads as a
   * free turn instead of an unreported one.
   */
  usage?: Partial<TokenUsage>;
  stopReason?: StopReason;
  /** The gateway's own message, verbatim. Never a generic string. */
  error?: string;
  meta?: MessageMeta;
  excluded: boolean;
  /**
   * The generation pass that wrote this row, once the row has been through a
   * regenerate. Absent means "a turn of its own, with no alternatives" — which is
   * every row written before migration 8, and every row of a turn nobody has
   * regenerated.
   */
  turnId?: string;
  /** The user message this row's turn answers. See `@/db/variants`. */
  answersId?: string;
}

export interface NewMessage {
  role: UnifiedRole;
  content: ContentBlock[];
  model?: string;
  usage?: Partial<TokenUsage>;
  stopReason?: StopReason;
  error?: string;
  meta?: MessageMeta;
  /** Overrides the append-at-end default. Used when forking. */
  seq?: number;
  createdAt?: number;
  /** Groups this row with the rest of the generation pass. See `@/db/variants`. */
  turnId?: string;
  /** The user message the pass answers — the slot its variants compete for. */
  answersId?: string;
}

/* -------------------------------------------------------------------------- */
/* Row mapping                                                                 */
/* -------------------------------------------------------------------------- */

interface ConversationRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  pinned: number;
  archived: number;
  system_prompt: string | null;
  profile_id: string;
  model: string;
  config: string;
  forked_from_id: string | null;
  forked_from_message_id: string | null;
  last_message_at: number | null;
  preview: string | null;
  project_id: string | null;
  tags: string | null;
  message_count?: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: string;
  created_at: number;
  content: string;
  text: string;
  model: string | null;
  usage: string | null;
  stop_reason: string | null;
  error: string | null;
  meta: string | null;
  excluded: number;
  turn_id: string | null;
  answers_id: string | null;
  hidden: number;
}

/**
 * Parses a JSON column, falling back rather than throwing.
 *
 * A single unreadable row should cost that row's metadata, not the whole
 * conversation. The rows this guards are ones the app wrote itself, so a failure
 * means corruption or a schema change — both worth a log line.
 */
function parseJson<T>(value: string | null, fallback: T, what: string): T {
  if (value === null || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    log.warn('db', `Unreadable ${what} column; using a default`);
    return fallback;
  }
}

/**
 * Separator used to fold a conversation's tags into one column.
 *
 * U+0001 rather than a comma: tags are free text, and `group_concat`'s default
 * comma would make the single tag `a,b` indistinguishable from the two tags `a`
 * and `b`. A control character cannot be typed into the tag field.
 *
 * Written as an escape rather than a literal control character, which is
 * invisible in a diff and easy for an editor to eat. Must stay in step with the
 * `char(1)` argument passed to `group_concat` in the queries below.
 */
const TAG_SEPARATOR = '\u0001';

function toConversation(row: ConversationRow): Conversation {
  const conversation: Conversation = {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinned: row.pinned !== 0,
    archived: row.archived !== 0,
    profileId: row.profile_id,
    model: row.model,
    config: parseJson<ConversationConfig>(row.config, {}, 'conversation config'),
    tags: row.tags ? row.tags.split(TAG_SEPARATOR).filter(Boolean) : [],
  };
  if (row.system_prompt !== null) conversation.systemPrompt = row.system_prompt;
  if (row.forked_from_id !== null) conversation.forkedFromId = row.forked_from_id;
  if (row.forked_from_message_id !== null) conversation.forkedFromMessageId = row.forked_from_message_id;
  if (row.last_message_at !== null) conversation.lastMessageAt = row.last_message_at;
  if (row.preview !== null) conversation.preview = row.preview;
  if (row.project_id !== null) conversation.projectId = row.project_id;
  if (row.message_count !== undefined) conversation.messageCount = row.message_count;
  return conversation;
}

function toMessage(row: MessageRow): StoredMessage {
  const message: StoredMessage = {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    createdAt: row.created_at,
    content: parseJson<ContentBlock[]>(row.content, [], 'message content'),
    text: row.text,
    excluded: row.excluded !== 0,
  };
  if (row.model !== null) message.model = row.model;
  // `{}` as the fallback, not `{ input: 0, output: 0 }`: a corrupt usage blob is
  // unknown usage, and inventing zeros here would present it as a free turn.
  if (row.usage !== null) message.usage = parseJson<Partial<TokenUsage>>(row.usage, {}, 'usage');
  if (row.stop_reason !== null) message.stopReason = row.stop_reason as StopReason;
  if (row.error !== null) message.error = row.error;
  if (row.meta !== null) message.meta = parseJson<MessageMeta>(row.meta, {}, 'message meta');
  if (row.turn_id !== null) message.turnId = row.turn_id;
  if (row.answers_id !== null) message.answersId = row.answers_id;
  return message;
}

/**
 * The block→text projection, the list preview and the default title all live in
 * `src/db/content.ts` now: this module imports `expo-sqlite`, which makes anything
 * declared in it untestable under Jest's node environment, and those three are
 * pure. Re-exported rather than moved outright, because a dozen call sites import
 * them from here and the contract they implement is a database one.
 */
export { DEFAULT_TITLE, flattenContent, isToolTurn, previewOf } from '@/db/content';

/**
 * A title derived from the first user message.
 *
 * Local and instant, rather than asking a model to name the conversation: that
 * would cost a request and some credits on a free tier for something the user
 * can rename in two taps.
 */
export function deriveTitle(text: string): string {
  const line = previewOf(text);
  if (!line) return 'New conversation';
  const clipped = line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
  return clipped;
}

/* -------------------------------------------------------------------------- */
/* Conversations                                                              */
/* -------------------------------------------------------------------------- */

export interface NewConversation {
  title?: string;
  profileId: string;
  model: string;
  systemPrompt?: string;
  config?: ConversationConfig;
  tags?: string[];
  projectId?: string;
  forkedFromId?: string;
  forkedFromMessageId?: string;
}

export async function createConversation(input: NewConversation): Promise<Conversation> {
  const { db } = await database();
  const now = Date.now();
  const id = newId('conv_');

  await db.runAsync(
    `INSERT INTO conversations
       (id, title, created_at, updated_at, pinned, archived, system_prompt, profile_id, model,
        config, forked_from_id, forked_from_message_id, last_message_at, preview, project_id)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [
      id,
      input.title ?? DEFAULT_TITLE,
      now,
      now,
      input.systemPrompt ?? null,
      input.profileId,
      input.model,
      JSON.stringify(input.config ?? {}),
      input.forkedFromId ?? null,
      input.forkedFromMessageId ?? null,
      input.projectId ?? null,
    ],
  );

  if (input.tags?.length) await setTags(id, input.tags);

  const created = await getConversation(id);
  if (!created) throw new Error('Conversation vanished immediately after insert');
  return created;
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const { db } = await database();
  const row = await db.getFirstAsync<ConversationRow>(
    `SELECT c.*, (SELECT group_concat(tag, char(1)) FROM conversation_tags WHERE conversation_id = c.id) AS tags
       FROM conversations c WHERE c.id = ?`,
    [id],
  );
  return row ? toConversation(row) : null;
}

export interface ListOptions {
  archived?: boolean;
  tag?: string;
  profileId?: string;
  /** Only this project's conversations. `null` means only the ones in no project. */
  projectId?: string | null;
  limit?: number;
  /** The cursor returned by the previous page. Omit for the first page. */
  after?: ListCursor | null;
}

/** A page of conversations plus the cursor for the next one, `null` at the end. */
export interface ConversationPage {
  conversations: Conversation[];
  cursor: ListCursor | null;
}

/**
 * The conversation list, pinned first then newest, one page at a time.
 *
 * The SQL lives in `./list-query` because a test asserts on the plan SQLite
 * picks for it; see the note there on why paging is keyset rather than `OFFSET`.
 */
export async function listConversations(options: ListOptions = {}): Promise<Conversation[]> {
  return (await listConversationPage(options)).conversations;
}

/** As {@link listConversations}, but keeping the cursor the caller needs to page on. */
export async function listConversationPage(options: ListOptions = {}): Promise<ConversationPage> {
  const { db } = await database();
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE_SIZE));
  const { sql, params } = buildListQuery({ ...options, limit });
  const rows = await db.getAllAsync<ConversationRow>(sql, params);
  const conversations = rows.map(toConversation);
  return { conversations, cursor: nextCursor(conversations, limit) };
}

export interface ConversationPatch {
  title?: string;
  systemPrompt?: string | null;
  model?: string;
  profileId?: string;
  pinned?: boolean;
  archived?: boolean;
  config?: ConversationConfig;
  /** `null` takes the conversation out of its project without deleting anything. */
  projectId?: string | null;
}

/**
 * Updates a conversation, touching `updated_at` only when something changed.
 *
 * That condition is load-bearing: the list is ordered by `updated_at`, so
 * bumping it on a no-op write would reshuffle the list every time a screen
 * mounted and re-saved identical config.
 */
export async function updateConversation(id: string, patch: ConversationPatch): Promise<void> {
  const { db } = await database();
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.systemPrompt !== undefined) {
    sets.push('system_prompt = ?');
    params.push(patch.systemPrompt);
  }
  if (patch.model !== undefined) {
    sets.push('model = ?');
    params.push(patch.model);
  }
  if (patch.profileId !== undefined) {
    sets.push('profile_id = ?');
    params.push(patch.profileId);
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?');
    params.push(patch.pinned ? 1 : 0);
  }
  if (patch.archived !== undefined) {
    sets.push('archived = ?');
    params.push(patch.archived ? 1 : 0);
  }
  if (patch.config !== undefined) {
    sets.push('config = ?');
    params.push(JSON.stringify(patch.config));
  }
  if (patch.projectId !== undefined) {
    sets.push('project_id = ?');
    params.push(patch.projectId);
  }

  if (!sets.length) return;

  sets.push('updated_at = ?');
  params.push(Date.now(), id);
  await db.runAsync(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`, params);
}

export async function deleteConversation(id: string): Promise<void> {
  const { db } = await database();
  // Messages and tags cascade; `PRAGMA foreign_keys = ON` is set at open time.
  await db.runAsync('DELETE FROM conversations WHERE id = ?', [id]);
}

/**
 * How many conversations still point at a provider profile.
 *
 * Asked before a profile is deleted. `profile_id` is a plain column, not a foreign
 * key — conversations have to survive a profile being edited or re-created — so
 * nothing at the database level stops a delete from orphaning them, and the count is
 * the only way the UI can say what the delete will actually cost.
 */
export async function countConversationsForProfile(profileId: string): Promise<number> {
  const { db } = await database();
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT count(*) AS count FROM conversations WHERE profile_id = ?',
    [profileId],
  );
  return row?.count ?? 0;
}

/** Moves every conversation from one profile to another. Returns how many moved. */
export async function reassignProfile(fromProfileId: string, toProfileId: string): Promise<number> {
  const { db } = await database();
  const result = await db.runAsync('UPDATE conversations SET profile_id = ? WHERE profile_id = ?', [
    toProfileId,
    fromProfileId,
  ]);
  return result.changes;
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {  const { db } = await database();
  // Pinning deliberately does not touch `updated_at`: it changes where the row
  // sorts, and also bumping the timestamp would reorder the pinned group too.
  await db.runAsync('UPDATE conversations SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id]);
}

export async function setTags(id: string, tags: readonly string[]): Promise<void> {
  const { db } = await database();
  const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM conversation_tags WHERE conversation_id = ?', [id]);
    for (const tag of cleaned) {
      await db.runAsync('INSERT INTO conversation_tags (conversation_id, tag) VALUES (?, ?)', [id, tag]);
    }
  });
}

/** Every tag in use, with how many conversations carry it. */
export async function allTags(): Promise<{ tag: string; count: number }[]> {
  const { db } = await database();
  return db.getAllAsync<{ tag: string; count: number }>(
    `SELECT tag, count(*) AS count FROM conversation_tags GROUP BY tag ORDER BY count DESC, tag ASC`,
  );
}

/* -------------------------------------------------------------------------- */
/* Bulk operations                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Deletes many conversations in **one** transaction.
 *
 * One transaction is the whole point, and it is a correctness requirement rather
 * than a performance one. Fifty separate deletes can be interrupted — the app
 * backgrounded, the process killed, a `Pressable` fired twice — leaving a
 * selection half destroyed, and there is no undo to reach for and no way for the
 * user to tell which half went. All or nothing is the only outcome that can be
 * described honestly afterwards.
 *
 * `usage_events` survive by design: `conversation_id` there is a plain column,
 * not a foreign key, because spend history is an accounting record of money
 * already spent (see [docs/05_Data_Model.md](../../docs/05_Data_Model.md) §5.2).
 * Deleting the thread does not refund the tokens, so the dashboard must not
 * start disagreeing with the invoice because someone tidied up their list.
 *
 * Returns how many conversation rows were removed, which is not necessarily
 * `ids.length` — an id that no longer exists is not an error here, because the
 * list the selection was made from can be a few seconds stale.
 */
export async function deleteConversations(ids: readonly string[]): Promise<number> {
  const wanted = normaliseIds(ids);
  if (!wanted.length) return 0;
  const { db } = await database();
  let removed = 0;
  await db.withTransactionAsync(async () => {
    for (const batch of chunk(wanted)) {
      const result = await db.runAsync(deleteConversationsSql(batch.length), [...batch]);
      removed += result.changes;
    }
  });
  log.info('db', 'Deleted conversations in bulk', { requested: wanted.length, removed });
  return removed;
}

/**
 * Archives or restores many conversations in one transaction.
 *
 * Returns how many rows actually *moved*, which the SQL enforces with an
 * `archived <> ?` guard. A selection that spans both states is normal — you can
 * multi-select in the archive too — and "8 archived" is a true statement where
 * "12 archived" would not be.
 */
export async function setArchivedBulk(ids: readonly string[], archived: boolean): Promise<number> {
  const wanted = normaliseIds(ids);
  if (!wanted.length) return 0;
  const { db } = await database();
  const flag = archived ? 1 : 0;
  let changed = 0;
  await db.withTransactionAsync(async () => {
    for (const batch of chunk(wanted)) {
      const result = await db.runAsync(setArchivedSql(batch.length), [flag, flag, ...batch]);
      changed += result.changes;
    }
  });
  return changed;
}

/**
 * How a bulk retag combines with the tags a conversation already has.
 *
 * Three modes rather than one, because they are three different intentions and
 * collapsing them loses information the user cannot get back. `replace` is the
 * destructive one: it discards tags the selection already carried, including
 * tags on conversations the user never looked at before selecting them.
 */
export type TagMode = 'add' | 'remove' | 'replace';

/**
 * Applies tags to many conversations in one transaction.
 *
 * Returns how many conversations were addressed rather than how many tag rows
 * changed. Row counts are the wrong unit for the confirmation: adding two tags
 * to ten conversations where six already had one of them is a meaningless "14",
 * and the user selected conversations, not rows.
 */
export async function tagConversations(
  ids: readonly string[],
  tags: readonly string[],
  mode: TagMode,
): Promise<number> {
  const wanted = normaliseIds(ids);
  const cleaned = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  if (!wanted.length) return 0;
  // `replace` with no tags means "clear them all", which is a legitimate wish;
  // `add` or `remove` with no tags is a no-op, and doing nothing is better than
  // opening a transaction to prove it.
  if (!cleaned.length && mode !== 'replace') return 0;

  const { db } = await database();
  await db.withTransactionAsync(async () => {
    for (const batch of chunk(wanted)) {
      if (mode === 'replace') await db.runAsync(clearTagsSql(batch.length), [...batch]);
      for (const tag of cleaned) {
        const sql = mode === 'remove' ? removeTagSql(batch.length) : addTagSql(batch.length);
        await db.runAsync(sql, [tag, ...batch]);
      }
    }
  });
  return wanted.length;
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The conversation as it reads: one linear path.
 *
 * `hidden = 0` is what makes regenerate non-destructive. An unselected variant of
 * the newest reply is still a row, but it is not part of the transcript, so nothing
 * above this — the request builder, the exporters, the token estimate — has to know
 * variants exist. See `@/db/variants`.
 */
export async function listMessages(conversationId: string): Promise<StoredMessage[]> {
  const { db } = await database();
  const rows = await db.getAllAsync<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? AND hidden = 0 ORDER BY seq ASC',
    [conversationId],
  );
  return rows.map(toMessage);
}

export async function getMessage(id: string): Promise<StoredMessage | null> {
  const { db } = await database();
  const row = await db.getFirstAsync<MessageRow>('SELECT * FROM messages WHERE id = ?', [id]);
  return row ? toMessage(row) : null;
}

async function nextSeq(conversationId: string): Promise<number> {
  const { db } = await database();
  const row = await db.getFirstAsync<{ max: number | null }>(
    'SELECT max(seq) AS max FROM messages WHERE conversation_id = ?',
    [conversationId],
  );
  return (row?.max ?? 0) + 1;
}

export async function appendMessage(conversationId: string, input: NewMessage): Promise<StoredMessage> {
  const { db } = await database();
  const id = newId('msg_');
  const seq = input.seq ?? (await nextSeq(conversationId));
  const createdAt = input.createdAt ?? Date.now();
  const text = flattenContent(input.content);

  await db.runAsync(
    `INSERT INTO messages
       (id, conversation_id, seq, role, created_at, content, text, model, usage, stop_reason, error, meta, excluded,
        turn_id, answers_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      id,
      conversationId,
      seq,
      input.role,
      createdAt,
      JSON.stringify(input.content),
      text,
      input.model ?? null,
      input.usage ? JSON.stringify(input.usage) : null,
      input.stopReason ?? null,
      input.error ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
      input.turnId ?? null,
      input.answersId ?? null,
    ],
  );

  // `''` for a tool-only turn: `touchConversation` leaves the preview column alone
  // when there is no line to put in it, so a skill body does not become the
  // conversation's list preview. It still lands in `messages.text` above, so search
  // finds it.
  await touchConversation(conversationId, createdAt, isToolTurn(input.content) ? '' : text);

  return {
    id,
    conversationId,
    seq,
    role: input.role,
    createdAt,
    content: input.content,
    text,
    excluded: false,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    ...(input.answersId !== undefined ? { answersId: input.answersId } : {}),
  };
}

export interface MessagePatch {
  content?: ContentBlock[];
  usage?: Partial<TokenUsage>;
  stopReason?: StopReason;
  error?: string | null;
  meta?: MessageMeta;
  model?: string;
  excluded?: boolean;
}

/**
 * Updates a message in place.
 *
 * `content` and `text` are always written together — a `content` update that
 * skipped `text` would leave the search index pointing at the old wording, which
 * is exactly the kind of bug that only shows up weeks later in a search result.
 */
export async function updateMessage(id: string, patch: MessagePatch): Promise<void> {
  const { db } = await database();
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (patch.content !== undefined) {
    sets.push('content = ?', 'text = ?');
    params.push(JSON.stringify(patch.content), flattenContent(patch.content));
  }
  if (patch.usage !== undefined) {
    sets.push('usage = ?');
    params.push(JSON.stringify(patch.usage));
  }
  if (patch.stopReason !== undefined) {
    sets.push('stop_reason = ?');
    params.push(patch.stopReason);
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    params.push(patch.error);
  }
  if (patch.meta !== undefined) {
    sets.push('meta = ?');
    params.push(JSON.stringify(patch.meta));
  }
  if (patch.model !== undefined) {
    sets.push('model = ?');
    params.push(patch.model);
  }
  if (patch.excluded !== undefined) {
    sets.push('excluded = ?');
    params.push(patch.excluded ? 1 : 0);
  }

  if (!sets.length) return;
  params.push(id);
  await db.runAsync(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, params);
}

export async function deleteMessage(id: string): Promise<void> {
  const { db } = await database();
  const message = await getMessage(id);
  await db.runAsync('DELETE FROM messages WHERE id = ?', [id]);
  if (message) await refreshPreview(message.conversationId);
}

/**
 * Deletes a message and everything after it.
 *
 * The primitive behind edit-and-resend and regenerate: both mean "rewind to
 * here and go again". Deleting rather than hiding is deliberate — a hidden tail
 * would keep showing up in search results for a conversation that no longer
 * contains it.
 */
export async function deleteMessagesFrom(conversationId: string, seq: number, inclusive = true): Promise<number> {
  const { db } = await database();
  const result = await db.runAsync(
    `DELETE FROM messages WHERE conversation_id = ? AND seq ${inclusive ? '>=' : '>'} ?`,
    [conversationId, seq],
  );
  await refreshPreview(conversationId);
  return result.changes;
}

/**
 * Copies a conversation up to and including one message.
 *
 * Used by "fork from here". The copy carries the same model, system prompt and
 * config, because forking to explore a different answer with different settings
 * means changing them *after* the fork, not losing them at it.
 */
export async function forkConversation(
  conversationId: string,
  throughMessageId: string,
  titleSuffix = ' (fork)',
): Promise<Conversation> {
  const source = await getConversation(conversationId);
  if (!source) throw new Error('Cannot fork a conversation that does not exist');
  const through = await getMessage(throughMessageId);
  if (!through) throw new Error('Cannot fork from a message that does not exist');

  const messages = (await listMessages(conversationId)).filter((m) => m.seq <= through.seq);

  const fork = await createConversation({
    title: `${source.title}${titleSuffix}`,
    profileId: source.profileId,
    model: source.model,
    ...(source.systemPrompt !== undefined ? { systemPrompt: source.systemPrompt } : {}),
    config: source.config,
    tags: source.tags,
    // Same project as the original: a fork is another attempt at the same work.
    ...(source.projectId !== undefined ? { projectId: source.projectId } : {}),
    forkedFromId: source.id,
    forkedFromMessageId: throughMessageId,
  });

  for (const message of messages) {
    await appendMessage(fork.id, {
      role: message.role,
      content: message.content,
      seq: message.seq,
      createdAt: message.createdAt,
      ...(message.model !== undefined ? { model: message.model } : {}),
      ...(message.usage !== undefined ? { usage: message.usage } : {}),
      ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}),
      ...(message.meta !== undefined ? { meta: message.meta } : {}),
    });
  }

  const refreshed = await getConversation(fork.id);
  return refreshed ?? fork;
}

/* -------------------------------------------------------------------------- */
/* Variants                                                                   */
/* -------------------------------------------------------------------------- */

/** One alternative reply to the same user message. */
export interface TurnVariant {
  turnId: string;
  /** True for the one currently in the transcript. */
  selected: boolean;
}

/**
 * Sets the reply being regenerated aside instead of deleting it.
 *
 * Returns the `turn_id` the old rows now share, so the caller can put the new pass
 * in the same slot. Stamping happens here rather than at write time because only a
 * regenerate creates a slot: a turn nobody has re-rolled needs no group, and rows
 * written before migration 8 have none — both are handled by labelling the range on
 * the way past.
 */
export async function setTurnAside(
  conversationId: string,
  seq: number,
  inclusive: boolean,
  answersId: string,
): Promise<string> {
  const { db } = await database();
  const turnId = newId('turn_');
  await db.withTransactionAsync(async () => {
    await db.runAsync(stampTurnSql(inclusive), [turnId, answersId, conversationId, seq]);
    await db.runAsync(HIDE_TURN_SQL, [conversationId, turnId]);
    await db.runAsync(ANCHOR_SLOT_SQL, [answersId, conversationId, answersId]);
  });
  await refreshPreview(conversationId);
  return turnId;
}

/** Puts one variant back in the transcript and takes the others out. */
export async function selectTurn(conversationId: string, answersId: string, turnId: string): Promise<void> {
  const { db } = await database();
  await db.runAsync(SELECT_TURN_SQL, [turnId, conversationId, answersId]);
  await refreshPreview(conversationId);
}

/**
 * The variants of the reply at the end of the conversation, oldest first.
 *
 * Empty unless that reply has actually been regenerated. Only the newest slot is
 * offered: selecting an older variant would change history that later turns were
 * written against, and the alternatives are dropped by the next send for exactly
 * that reason.
 */
export async function newestTurnVariants(
  conversationId: string,
): Promise<{ answersId: string; variants: TurnVariant[] }> {
  const { db } = await database();
  const slot = await db.getFirstAsync<{ answersId: string }>(NEWEST_SLOT_SQL, [conversationId]);
  if (!slot) return { answersId: '', variants: [] };
  const rows = await db.getAllAsync<{ turnId: string; hidden: number }>(LIST_TURNS_SQL, [
    conversationId,
    slot.answersId,
  ]);
  return {
    answersId: slot.answersId,
    variants: rows.map((row) => ({ turnId: row.turnId, selected: row.hidden === 0 })),
  };
}

/**
 * Drops the alternatives to the newest reply.
 *
 * Called on the way into a send. The conversation is about to move past that turn,
 * and a variant that is no longer reachable is a row that would otherwise sit in
 * the database forever — and, worse, could be resurrected by a later regenerate
 * into a history it was never written for.
 */
export async function dropHiddenMessages(conversationId: string): Promise<number> {
  const { db } = await database();
  const result = await db.runAsync(DROP_HIDDEN_SQL, [conversationId]);
  return result.changes;
}

/** The messages a request should carry, in wire form. */
export function toUnifiedMessages(messages: readonly StoredMessage[]): UnifiedMessage[] {
  return messages
    .filter((message) => !message.excluded && message.content.length > 0)
    .map((message) => ({ role: message.role, content: message.content }));
}

async function touchConversation(conversationId: string, at: number, text: string): Promise<void> {
  const { db } = await database();
  const preview = previewOf(text);
  // A message with no text — images only, a tool call, a failed turn — must not
  // blank the preview. `COALESCE` would not do: the point is to keep the *old*
  // value, so the column is simply left out of the statement.
  if (!preview) {
    await db.runAsync('UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?', [
      at,
      at,
      conversationId,
    ]);
    return;
  }
  await db.runAsync(
    `UPDATE conversations SET updated_at = ?, last_message_at = ?, preview = ? WHERE id = ?`,
    [at, at, preview, conversationId],
  );
}

/**
 * Recomputes the denormalised preview from the newest surviving message.
 *
 * "Newest with something to show", not "newest": an attachment-only turn at the end
 * of a conversation is not a reason to render the row as empty.
 */
async function refreshPreview(conversationId: string): Promise<void> {
  const { db } = await database();
  const newest = await db.getFirstAsync<{ created_at: number }>(
    'SELECT created_at FROM messages WHERE conversation_id = ? AND hidden = 0 ORDER BY seq DESC LIMIT 1',
    [conversationId],
  );
  const withText = await db.getFirstAsync<{ text: string }>(
    "SELECT text FROM messages WHERE conversation_id = ? AND hidden = 0 AND text <> '' ORDER BY seq DESC LIMIT 1",
    [conversationId],
  );
  await db.runAsync('UPDATE conversations SET preview = ?, last_message_at = ? WHERE id = ?', [
    withText ? previewOf(withText.text) || null : null,
    newest ? newest.created_at : null,
    conversationId,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Search                                                                     */
/* -------------------------------------------------------------------------- */

export interface SearchHit {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  role: UnifiedRole;
  createdAt: number;
  /** A one-line window centred on the match. */
  snippet: string;
  /** Which pass found it, shown in the UI so a slow search is explicable. */
  via: 'fts' | 'like';
}

interface SearchRow {
  id: string;
  conversation_id: string;
  title: string;
  role: string;
  created_at: number;
  text: string;
}

export interface SearchOptions {
  /**
   * Restrict hits to conversations carrying this tag.
   *
   * Mirrors {@link ListOptions.tag}: the conversation list and the message search
   * are two halves of one filter, and a query that ignores the active tag reads as
   * a broken filter rather than a broader search.
   */
  tag?: string;
  /** Restrict hits to this project's conversations. Mirrors {@link ListOptions.projectId}. */
  projectId?: string;
  limit?: number;
}

/**
 * Full-text search over message content.
 *
 * Runs the FTS index first, then falls back to a `LIKE` scan when FTS returns
 * nothing. The fallback is not redundancy — FTS5's `unicode61` tokenizer makes a
 * run of Chinese into a single token, so a substring query like 分析 genuinely
 * cannot match 数据分析报告 through the index. The gateway accepts Chinese, so
 * that case is real. It also covers a build without FTS5 at all.
 */
export async function searchMessages(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  const { db, ftsAvailable } = await database();
  const trimmed = query.trim();
  if (!trimmed) return [];
  const limit = options.limit ?? 100;

  const select = `SELECT m.id, m.conversation_id, c.title, m.role, m.created_at, m.text
                    FROM messages m JOIN conversations c ON c.id = m.conversation_id`;
  // A variant the user paged away from is still an indexed row, and a hit on one
  // would open a conversation that does not contain the text that was highlighted.
  const visible = ' AND m.hidden = 0';
  // Both passes already join `conversations`, so the tag filter is one predicate
  // against the row that is there anyway. Without it, picking a tag and then
  // typing narrows the list above the results but not the results themselves.
  // The project filter is there for the same reason.
  const tagFilter =
    (options.tag ? ' AND EXISTS (SELECT 1 FROM conversation_tags t WHERE t.conversation_id = c.id AND t.tag = ?)' : '') +
    (options.projectId ? ' AND c.project_id = ?' : '');
  const tagParams = [...(options.tag ? [options.tag] : []), ...(options.projectId ? [options.projectId] : [])];

  if (ftsAvailable) {
    const match = buildFtsQuery(trimmed);
    if (match) {
      try {
        const rows = await db.getAllAsync<SearchRow>(
          `${select}
             JOIN messages_fts f ON f.rowid = m.rowid
            WHERE messages_fts MATCH ?${visible}${tagFilter}
            ORDER BY f.rank, m.created_at DESC
            LIMIT ?`,
          [match, ...tagParams, limit],
        );
        if (rows.length) return rows.map((row) => toHit(row, trimmed, 'fts'));
      } catch (error) {
        // A MATCH syntax error should degrade to the slow path, not blank the
        // screen. `buildFtsQuery` is quoted precisely to make this unreachable.
        log.warn('db', 'FTS query failed; falling back to a LIKE scan', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const pattern = buildLikePattern(trimmed);
  if (!pattern) return [];
  const rows = await db.getAllAsync<SearchRow>(
    `${select}
      WHERE m.text LIKE ? ESCAPE '${LIKE_ESCAPE}'${visible}${tagFilter}
      ORDER BY m.created_at DESC
      LIMIT ?`,
    [pattern, ...tagParams, limit],
  );
  return rows.map((row) => toHit(row, trimmed, 'like'));
}

function toHit(row: SearchRow, query: string, via: 'fts' | 'like'): SearchHit {
  return {
    messageId: row.id,
    conversationId: row.conversation_id,
    conversationTitle: row.title,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    createdAt: row.created_at,
    snippet: excerpt(row.text, query),
    via,
  };
}

/* -------------------------------------------------------------------------- */
/* Usage                                                                      */
/* -------------------------------------------------------------------------- */

export interface UsageInput {
  profileId: string;
  model: string;
  /**
   * The gateway's own counts. Unreported fields are stored as 0 in the aggregate
   * columns — a running total has to be a number — which is why the per-message
   * row keeps the absence and the dashboard is the place that says "estimated".
   */
  usage: Partial<TokenUsage>;
  conversationId?: string;
  pricing?: ModelPricing;
  at?: number;
}

/**
 * Records one completed turn's usage.
 *
 * Written from the API's own `usage`, never from an estimate, and the cost is
 * frozen at the pricing in force when the request ran — editing a model's price
 * later should not silently rewrite last month's spend.
 */
export async function recordUsage(input: UsageInput): Promise<void> {
  const { db } = await database();
  const at = input.at ?? Date.now();
  const cost = estimateCost(input.usage, input.pricing);
  await db.runAsync(
    `INSERT INTO usage_events
       (at, day, profile_id, model, input, output, thinking, cache_read, cache_write, cost, conversation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      at,
      localDay(at),
      input.profileId,
      input.model,
      input.usage.input ?? 0,
      input.usage.output ?? 0,
      input.usage.thinking ?? null,
      input.usage.cacheRead ?? null,
      input.usage.cacheWrite ?? null,
      cost ? cost.total : null,
      input.conversationId ?? null,
    ],
  );
}

export interface UsageBucket {
  key: string;
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheWrite: number;
  /** Null when no event in the bucket had pricing. */
  cost: number | null;
  /** True when some events in the bucket had no pricing, so cost is partial. */
  partialCost: boolean;
  requests: number;
}

interface UsageRow {
  key: string;
  input: number;
  output: number;
  thinking: number;
  cache_read: number;
  cache_write: number;
  cost: number | null;
  priced: number;
  requests: number;
}

function toBucket(row: UsageRow): UsageBucket {
  return {
    key: row.key,
    input: row.input,
    output: row.output,
    thinking: row.thinking,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    cost: row.priced > 0 ? (row.cost ?? 0) : null,
    partialCost: row.priced > 0 && row.priced < row.requests,
    requests: row.requests,
  };
}

const USAGE_AGGREGATE = `
  sum(input) AS input,
  sum(output) AS output,
  coalesce(sum(thinking), 0) AS thinking,
  coalesce(sum(cache_read), 0) AS cache_read,
  coalesce(sum(cache_write), 0) AS cache_write,
  sum(cost) AS cost,
  sum(CASE WHEN cost IS NULL THEN 0 ELSE 1 END) AS priced,
  count(*) AS requests`;

export async function usageByDay(days = 30): Promise<UsageBucket[]> {
  const { db } = await database();
  const rows = await db.getAllAsync<UsageRow>(
    `SELECT day AS key, ${USAGE_AGGREGATE}
       FROM usage_events GROUP BY day ORDER BY day DESC LIMIT ?`,
    [days],
  );
  return rows.map(toBucket);
}

export async function usageByModel(): Promise<UsageBucket[]> {
  const { db } = await database();
  const rows = await db.getAllAsync<UsageRow>(
    `SELECT model AS key, ${USAGE_AGGREGATE}
       FROM usage_events GROUP BY model ORDER BY sum(input) + sum(output) DESC`,
  );
  return rows.map(toBucket);
}

export async function usageTotals(): Promise<UsageBucket> {
  const { db } = await database();
  const row = await db.getFirstAsync<UsageRow>(
    `SELECT 'all' AS key, ${USAGE_AGGREGATE} FROM usage_events`,
  );
  return row && row.requests > 0
    ? toBucket(row)
    : {
        key: 'all',
        input: 0,
        output: 0,
        thinking: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: null,
        partialCost: false,
        requests: 0,
      };
}
