# 05 — Data Model

**SuperAgent / AgentRouter Mobile · Persistence, State and Secrets**

| | |
|---|---|
| **Version** | 1.0 |
| **Status** | Current — describes schema `user_version = 1` as shipped in Phase 1 |
| **Audience** | Mid-level engineers and architects joining the persistence, chat-store or search work |
| **Companion docs** | [PRD.md](../PRD.md) · [TRD.md](../TRD.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [progress.md](../progress.md) · [06_Eng_Plan.md](06_Eng_Plan.md) · [07_Deployment.md](07_Deployment.md) |

---

## Executive summary

This document is the single authoritative description of **where every byte of user data lives, who owns it, and what invariants hold across the three storage tiers** of SuperAgent Mobile. It exists because the app is offline-first and privacy-first: there is no server to reconcile against, no cloud copy to re-download, and no telemetry pipeline to reconstruct history from. If a write is wrong on device, it is wrong forever. That raises the cost of a schema mistake far above the norm for a chat client, so the schema is documented at the level of *why each column exists* rather than merely *what type it is*.

Three tiers hold state, and the split is a security boundary, not an optimisation:

- **SQLite** (`expo-sqlite`, WAL) holds conversations, messages, tags and usage events — everything large, queryable, or historical.
- **AsyncStorage**, via `zustand/middleware/persist`, holds provider profiles, model metadata and settings — small, whole-object, read-at-boot state.
- **SecureStore** (Android Keystore) holds API keys and nothing else. **Keys are deliberately absent from every Zustand slice**, because persisted slices land in AsyncStorage, which is plaintext on a rooted device.

Read this document before you add a column, add a JSON field, write a query, or touch the FTS index. Sections 3–6 are the normative schema. Section 7 explains the floating-point `seq` key, which is the one design decision most likely to look like a bug on first contact. Section 12 records hazards — including a `VACUUM`-versus-FTS5 desynchronisation that the current startup drift check cannot detect — that are properties of the schema rather than of any one call site, and therefore belong here rather than in a code comment.

Where this document disagrees with `progress.md`, this document is correct: it was written against the source in this worktree, and three details in `progress.md` have drifted (Appendix D).

---

## 1. Scope, non-goals, and how to read the diagrams

**In scope:** the SQLite schema at `user_version = 1`, the JSON documents stored inside its `TEXT` columns, the persisted Zustand shapes, the SecureStore key namespace, the synchronisation rules between them, index rationale, query patterns, and the migration mechanism.

**Out of scope:** the wire protocols themselves (see [TRD.md](../TRD.md) and `src/transports/`), the retry and failover policy ([06_Eng_Plan.md](06_Eng_Plan.md) §critical path), and UI rendering of any of this.

Diagram notation used throughout:

```
──1──<   one-to-many (crow's foot on the many side)
──1──1─   one-to-one
[FK]      enforced foreign key with ON DELETE CASCADE
[soft]    reference stored but NOT enforced — deliberate, see §5.2
(idx)     covered by an index
```

---

## 2. The three storage tiers

```
┌─────────────────────────────────────────────────────────────────────┐
│                          PRESENTATION                               │
│                app/  ·  src/components/                             │
└────────────────────────────┬────────────────────────────────────────┘
                             │  hooks only, never raw SQL
┌────────────────────────────▼────────────────────────────────────────┐
│                    APPLICATION STATE  (Zustand 5)                   │
│  useChat          (ephemeral — NOT persisted, rebuilt from SQLite)  │
│  useProviders     (persisted → AsyncStorage)                        │
│  useModels        (persisted → AsyncStorage)                        │
│  useSettings      (persisted → AsyncStorage)                        │
└───────┬──────────────────────────────┬──────────────────────┬───────┘
        │                              │                      │
┌───────▼─────────────┐   ┌────────────▼──────────┐  ┌────────▼───────┐
│  SQLite (WAL)       │   │  AsyncStorage         │  │  SecureStore   │
│  expo-sqlite        │   │  plaintext on disk    │  │  Android       │
│                     │   │                       │  │  Keystore      │
│  conversations      │   │  agentrouter.providers│  │                │
│  messages           │   │  agentrouter.models   │  │  apiKey:<pid>  │
│  messages_fts       │   │  agentrouter.settings │  │                │
│  tags               │   │                       │  │  + module-     │
│  usage_events       │   │  small, whole-object, │  │    scoped RAM  │
│                     │   │  rewritten on change  │  │    cache       │
│  large, queried,    │   │                       │  │                │
│  incrementally      │   │  NEVER secrets        │  │  ONLY secrets  │
│  mutated            │   │                       │  │                │
└─────────────────────┘   └───────────────────────┘  └────────────────┘
```

**The allocation rule.** Data goes in SQLite if it is unbounded in size, needs to be queried by predicate, or must survive partial writes. It goes in AsyncStorage if it is a bounded configuration object read once at boot and rewritten wholesale on change. It goes in SecureStore if disclosing it would let someone else spend the user's money.

That last tier is absolute. `src/lib/secureKey.ts` is the only module that reads a key; it caches the value in a module-scoped variable for the process lifetime and registers it with `src/lib/redact.ts` on every load, so the redactor can scrub it out of any log line, export or crash message before it is written. No key is ever passed into a Zustand `set()`.

---

## 3. Entity–relationship diagram

```
                        ┌──────────────────────────────────────┐
                        │            conversations             │
                        ├──────────────────────────────────────┤
                        │ PK  id                  TEXT         │
                        │     title               TEXT         │
                        │     created_at          INTEGER      │
                        │     updated_at          INTEGER (idx)│
                        │     last_message_at     INTEGER  ▲den│
                        │     preview             TEXT     ▲den│
                        │     model               TEXT         │
                        │     profile_id          TEXT         │
                        │     config              TEXT  (JSON) │
                        │     pinned              INTEGER (idx)│
                        │     archived            INTEGER      │
                        │     forked_from_id      TEXT  [soft] │
                        │     forked_from_msg_id  TEXT  [soft] │
                        └───┬──────────────┬────────────────┬──┘
                            │              │                │
              1             │            1 │              1 │
              │             │              │                │
              │        [FK] ▼ CASCADE [FK] ▼ CASCADE        │ [soft]
              │      ┌──────┴───────┐  ┌───┴──────────┐     │  no FK
              │      │   messages   │  │     tags     │     │
              │      ├──────────────┤  ├──────────────┤     │
              │      │ PK id   TEXT │  │ PK(conv,tag) │     │
              │      │ FK conv_id   │  │ FK conv_id   │     │
              │      │    seq  REAL │  │    tag  TEXT │     │
              │      │    role      │  │        (idx) │     │
              │      │    created_at│  └──────────────┘     │
              │      │    content   │◄──── JSON            │
              │      │      ContentBlock[]                  │
              │      │    text  ▲den│ ── flattened          │
              │      │    model     │                       │
              │      │    usage     │◄──── JSON TokenUsage  │
              │      │    stop_reason                       │
              │      │    error     │                       │
              │      │    meta      │◄──── JSON MessageMeta │
              │      │    excluded  │                       │
              │      └──┬───────────┘                       │
              │         │ 1                                 │
              │         │ external-content FTS5              │
              │         │ keyed on messages.rowid            │
              │    ┌────▼──────────────┐                    │
              │    │   messages_fts    │                    │
              │    ├───────────────────┤                    │
              │    │  text  (indexed)  │                    │
              │    │  content='messages'                    │
              │    │  content_rowid='rowid'                 │
              │    └───────────────────┘                    │
              │                                             │
              │ [soft] no FK — spend history outlives its    │
              ▼        conversation (§5.2)                   ▼
       ┌─────────────────────────────┐            ┌──────────────────┐
       │        usage_events         │            │ conversations    │
       ├─────────────────────────────┤            │ (self-reference: │
       │ PK  id              TEXT    │            │  a fork points   │
       │     at              INTEGER │            │  at its parent   │
       │     day             TEXT ▲den│           │  conversation    │
       │     conversation_id TEXT[soft]           │  and message)    │
       │     profile_id      TEXT    │            └──────────────────┘
       │     model           TEXT    │
       │     input/output/cache_*    │
       │     cost            REAL ▲den (NULL = unknown, ≠ 0.00)
       └─────────────────────────────┘

▲den = deliberately denormalised, justified in §6.4
```

### 3.1 Cardinalities, stated precisely

| Relationship | Cardinality | Enforced by | On parent delete |
|---|---|---|---|
| `conversations` → `messages` | 1 : 0..N | FK on `messages.conversation_id` | CASCADE |
| `conversations` → `tags` | 1 : 0..N | FK on `tags.conversation_id`, PK `(conversation_id, tag)` | CASCADE |
| `messages` → `messages_fts` | 1 : 1 | FTS5 external-content triggers | trigger DELETE |
| `conversations` → `usage_events` | 1 : 0..N | **nothing** — soft reference | rows survive (§5.2) |
| `conversations` → `conversations` (fork) | 0..1 : 0..N | **nothing** — soft reference | rows survive |
| provider profile → `conversations` | 1 : 0..N | **nothing** — `profile_id` is a string, profiles live in AsyncStorage | rows survive with a dangling id |
| provider profile → SecureStore key | 1 : 0..1 | naming convention `apiKey:<profileId>` | key deleted explicitly by the store action |

The last two rows are the interesting ones, and they are the price of the tier split. A conversation's `profile_id` points into a *different storage engine*, so SQLite cannot enforce it. Every read path therefore treats `profile_id` as a hint: `resolveTransport()` falls back to `activeProfile()` when the id no longer resolves, rather than throwing. Deleting a provider profile does not orphan conversations; it makes them re-home to whatever is active, which is the behaviour a user expects when they delete a gateway and keep chatting.

---

## 4. Table reference (DDL as shipped)

The full DDL lives in `src/db/schema.ts`. It is reproduced here in the order the migration creates it, with the commentary that matters for consumers.

### 4.1 `conversations`

```sql
CREATE TABLE conversations (
  id                     TEXT    PRIMARY KEY NOT NULL,
  title                  TEXT    NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  last_message_at        INTEGER,
  preview                TEXT,
  model                  TEXT    NOT NULL,
  profile_id             TEXT    NOT NULL,
  config                 TEXT,            -- JSON ConversationConfig
  pinned                 INTEGER NOT NULL DEFAULT 0,
  archived               INTEGER NOT NULL DEFAULT 0,
  forked_from_id         TEXT,
  forked_from_message_id TEXT
);
CREATE INDEX conversations_order ON conversations (pinned DESC, updated_at DESC);
```

`updated_at` versus `last_message_at` is a real distinction, not redundancy. `updated_at` is *any* touch — rename, retag, config change, message. `last_message_at` is conversation activity. The list screen sorts and groups by `updated_at` (`rowTime()` in [src/chat/list.ts](../src/chat/list.ts:34)) because the question the user is asking that screen is "when did I last *touch* this", and because sorting by a different column than the headings group by would put yesterday's heading above today's row.

### 4.2 `messages`

```sql
CREATE TABLE messages (
  id              TEXT    PRIMARY KEY NOT NULL,
  conversation_id TEXT    NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  -- REAL rather than INTEGER so a message can be inserted between two others
  -- by averaging their keys, without rewriting every following row.
  seq             REAL    NOT NULL,
  role            TEXT    NOT NULL,          -- 'user' | 'assistant' | 'system'
  created_at      INTEGER NOT NULL,
  content         TEXT    NOT NULL,          -- JSON ContentBlock[]
  text            TEXT    NOT NULL DEFAULT '', -- flattened, FTS-indexed
  model           TEXT,
  usage           TEXT,                      -- JSON TokenUsage, never estimated
  stop_reason     TEXT,
  error           TEXT,                      -- gateway's own text, verbatim
  meta            TEXT,                      -- JSON MessageMeta
  excluded        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_conversation ON messages (conversation_id, seq);
```

Four columns deserve comment:

- **`content`** is the truth. Every block the model produced or the user attached, in order, as JSON. Rendering, replay-to-the-API and forking all read this.
- **`text`** is a projection of `content` for search and previews (§6.4). It is written by `flattenContent()` at insert time and must never be edited independently.
- **`usage`** holds `TokenUsage` **only when the gateway reported it**. The heuristic estimator in `src/lib/tokens.ts` feeds the UI's context gauge and nothing else; an estimate is never persisted here, because a persisted estimate becomes an authoritative-looking number in a cost report.
- **`error`** stores the gateway's own message verbatim. We do not rewrite it into friendly prose at rest — a user pasting a real gateway string into a support thread is worth more than a polished one.

### 4.3 `tags`

```sql
CREATE TABLE tags (
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  tag             TEXT NOT NULL,
  PRIMARY KEY (conversation_id, tag)
);
CREATE INDEX tags_tag ON tags (tag);
```

A pure join table with no surrogate key: the natural key *is* the pair, and a composite PK gets idempotent tagging (`INSERT OR IGNORE`) for free. Tags are stored as typed but compared case-insensitively; `parseTags()` deduplicates on `toLowerCase()` while keeping the first spelling the user typed, so `Work` and `work` are one tag and the user's own capitalisation survives.

Reads aggregate tags into the conversation row with `group_concat(tag, char(1))` and split on `TAG_SEPARATOR = ''`. A control character, not a comma — a comma is a legal character inside a tag, and the separator must be one that cannot appear in the data. (`TAG_SEPARATOR` is `U+0001`, ASCII SOH — it appears empty when rendered.)

### 4.4 `usage_events`

```sql
CREATE TABLE usage_events (
  id              TEXT    PRIMARY KEY NOT NULL,
  at              INTEGER NOT NULL,
  day             TEXT    NOT NULL,   -- 'YYYY-MM-DD', local calendar day
  conversation_id TEXT,               -- soft reference, no FK
  profile_id      TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write     INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL DEFAULT 0,
  cost            REAL                -- NULL when pricing is unknown
);
CREATE INDEX usage_day   ON usage_events (day);
CREATE INDEX usage_model ON usage_events (model);
```

Two write-time freezes, both deliberate:

**`day` is computed on write, in the device's local timezone.** Deriving it at read time from `at` would mean a user who flies from Berlin to Los Angeles sees yesterday's spend move into the day before. Cost reporting must be stable once observed, so the calendar day is decided once, by the device that was there.

**`cost` is frozen at the pricing in effect when the row was written**, and is `NULL` — not `0` — when we had no price for that model. `NULL` and `0.00` are different facts: "we don't know what this cost" versus "this was free". The aggregation in `src/db/conversations.ts` keeps them apart with `priced`/`partialCost` flags, so the UI can say "$1.42 (+ 3 events unpriced)" instead of quietly understating spend. Recomputing historical cost from today's price list would rewrite history, so we don't.

### 4.5 `messages_fts` — external-content FTS5

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content = 'messages', content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2"
);
```

External-content mode stores only the inverted index; the column data stays in `messages`. That halves the storage cost of every message body and removes any possibility of the index holding a *different* string than the row. Sync triggers on `INSERT`/`UPDATE`/`DELETE` of `messages` keep it current.

This table is created **outside the numbered migrations**, guarded by `IF NOT EXISTS` and a probe, because FTS5 is a compile-time option and not every Android/JSC/Hermes SQLite build in the wild has it. A missing FTS5 must degrade search, not brick the app on first launch — so the probe result is remembered and `searchMessages()` falls back to `LIKE`. The same fallback carries CJK queries, which `unicode61` tokenises poorly.

At startup a **drift check** compares `count(*)` in `messages_fts` against `count(*)` in `messages` and issues `INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')` on mismatch. See §12.1 for the case this check cannot see.

---

## 5. Data integrity

### 5.1 Enforced constraints

```
PRAGMA journal_mode = WAL;    -- concurrent read during write; survives crash
PRAGMA foreign_keys = ON;     -- MUST be set per connection, not per database
```

`PRAGMA foreign_keys = ON` is per-connection and defaults to *off* in SQLite. Every connection opened by the app therefore sets it in `openDatabase()`. If a future code path opens its own connection and forgets, cascades silently stop working and orphan rows accumulate with no error. That is the single most likely way to break integrity in this schema, which is why the pragma sits next to the schema version check rather than in a config file.

| Invariant | Mechanism | Failure mode if violated |
|---|---|---|
| No message without a conversation | FK + CASCADE | orphan rows returned by search with no row to open |
| No duplicate tag on a conversation | composite PK | duplicate chips, wrong tag counts |
| `seq` unique within a conversation | *convention only* — no unique index | two messages at one position; order becomes insertion-order dependent |
| `text` equals `flattenContent(content)` | *convention only* — written together in one statement | search finds text the message does not contain |
| FTS row per message | FTS5 triggers | silent search misses |
| `role` in {user, assistant, system} | TypeScript at the boundary; no CHECK constraint | render fallback, replay rejected by the gateway |

The three "convention only" rows are honest gaps. `seq` has no `UNIQUE (conversation_id, seq)` index because forking deliberately reuses source `seq` values in a *different* conversation (which the composite index would allow) and because a unique constraint would turn a benign collision into a lost message. The `text`/`content` pairing is enforced by there being exactly one insert path — `insertMessage()` — and by tests, not by the database. If a second write path ever appears, add a generated column or a trigger; do not rely on two call sites remembering.

### 5.2 Deliberately *un*enforced references

Three references are stored without a foreign key. Each is a decision, not an omission.

**`usage_events.conversation_id`** — deleting a conversation must not erase what it cost. Spend history is an accounting record; the user deleting a chat is deleting content, not asking to be told they spent less money this month. Consumers must tolerate a dangling `conversation_id` and render "(deleted conversation)".

**`conversations.forked_from_id` / `forked_from_message_id`** — a fork is an independent conversation that happens to remember its origin. A CASCADE here would delete a user's *new* work because they tidied up the old thread, which is indefensible. Reads must handle "parent no longer exists" by dropping the provenance affordance.

**`conversations.profile_id`** — cross-tier (§3.1), so SQLite cannot enforce it even if we wanted it to.

---

## 6. Normalisation, then deliberate denormalisation

The schema was designed by normalising properly and then breaking normal form in four named places for reasons that were measured, not assumed. Both halves matter: an un-normalised schema rots, and a purely normalised one makes the conversation list stutter.

### 6.1 First normal form

1NF requires atomic column values — no repeating groups, no lists in a cell.

`tags` is the test case. The tempting shape is `conversations.tags TEXT` holding `"work,ai,draft"`. That fails 1NF and immediately costs you: filtering by tag becomes `LIKE '%work%'` (which matches `homework`), tag counts require parsing every row in JS, and renaming a tag becomes a string rewrite across the table. The normalised `tags(conversation_id, tag)` join table gives an indexed equality predicate and `GROUP BY tag` counts.

**`messages.content` looks like a 1NF violation and is not.** It is a JSON array of content blocks. The distinction is whether the app ever queries *inside* it. It does not: blocks are read, rendered and replayed as an ordered whole, never selected or filtered by SQL. A `message_blocks` table would add a join to every read, force block ordering into another `seq` column, and buy nothing — nothing asks "find me all `tool_use` blocks named X". `content` is therefore a single atomic value at the granularity the application actually uses. See §8 for the schema that governs it.

### 6.2 Second normal form

2NF requires non-key attributes to depend on the *whole* key. Only `tags` has a composite key, and it has no non-key attributes at all, so 2NF holds trivially. This is a consequence of using surrogate `TEXT` ids everywhere else — `newId()` values, generated locally with no coordination — rather than natural composite keys. On a device with no server, locally generated ids are the only option that survives an offline write, so 2NF comes free.

### 6.3 Third normal form

3NF requires no transitive dependency: no non-key column determined by another non-key column.

The clean parts:
- `messages.model` is *not* redundant with `conversations.model`. The conversation's model is the current selection; a message's model is what actually answered it. Switch models mid-thread and both facts are needed — one for the next request, one for the "answered by Claude Sonnet 4.5" label on an old turn. No dependency, no violation.
- `usage_events.model` is likewise the model of that event, not a copy of a conversation-level field.

The violations, all four intentional:

| Column | Determined by | Normal form broken |
|---|---|---|
| `messages.text` | `messages.content` | 3NF (transitive on a non-key column) |
| `conversations.preview` | latest `messages.text` | 3NF (across tables) |
| `conversations.last_message_at` | `max(messages.created_at)` | 3NF (derivable aggregate) |
| `usage_events.day` | `usage_events.at` + device timezone | 3NF (functionally determined) |
| `usage_events.cost` | tokens × price list | 3NF (derivable — *if* prices were immutable, which they are not) |

### 6.4 Why `messages.text` exists — the central tradeoff

`text` is the flattened, human-readable projection of `content`, produced by `flattenContent()` and stored alongside it. It duplicates data. It is the right call for two reasons.

**Search.** FTS5 indexes a column, not an expression. To full-text search message bodies you need a plain text column. Indexing `content` directly would index JSON syntax — a search for `"type"` would hit every message ever sent, and a search for `image` would hit every attachment's block tag. Worse, base64 image payloads live in `content`; indexing them would inflate the FTS index by megabytes per photo for zero retrieval value. `flattenContent()` drops non-textual blocks entirely, so the index contains prose and nothing else.

**List previews.** The conversation list renders a one-line preview per row. Without `text`/`preview`, each row requires `json_extract` over the latest message — SQLite's JSON1 functions parse the whole document per row, on the UI thread's database, for a string that will be truncated to 160 characters. With 500 conversations that is 500 JSON parses of documents that may each be tens of kilobytes. With `preview` it is a column read.

The costs, stated plainly:

| Cost | Mitigation |
|---|---|
| Storage: prose stored twice | Prose is cheap; the expensive part (base64) is stored once, in `content` only |
| Two columns can disagree | Single insert path writes both in one statement; `flattenContent()` is pure and unit-tested |
| Editing `content` requires re-flattening | `deleteMessagesFrom` + re-insert is the only edit path — messages are immutable once written |

**The rule that follows:** `text` is derived state that happens to be stored. Never write it by hand, never let a UI edit reach it, and if you add a block type, extend `flattenContent()` in the same commit (§8.3).

### 6.5 The denormalisation ledger

Every denormalised column, its writer, and what goes wrong if the writer is skipped:

| Column | Written by | Skew if missed |
|---|---|---|
| `messages.text` | `insertMessage()` | message unfindable in search |
| `conversations.preview` | `touchConversation()` | list shows a stale line |
| `conversations.last_message_at` | `touchConversation()` | "last active" wrong; ordering unaffected (uses `updated_at`) |
| `conversations.updated_at` | `touchConversation()` + every mutating action | conversation sinks in the list despite activity |
| `usage_events.day` | `recordUsage()` | row invisible to the daily report |
| `usage_events.cost` | `recordUsage()` | spend understated, or `NULL` = "unknown" (correct) |

---

## 7. Floating-point sequence keys

`messages.seq` is `REAL`, not `INTEGER`. This is the design decision most likely to be mistaken for sloppiness, so it is documented in full.

### 7.1 The problem with integer positions

A chat transcript is an ordered list that gets edited in the middle: regenerate an assistant reply, insert a system note, fork at a point, drop a summarised prefix. With dense integer positions, inserting between positions 4 and 5 requires renumbering every row from 5 to N — an `UPDATE messages SET seq = seq + 1 WHERE conversation_id = ? AND seq >= 5`. On a 2,000-message conversation that is 1,996 row rewrites, a WAL frame per page touched, and every cached React key invalidated at once. Doing it on a mid-range Android device while a stream is publishing at 60 ms intervals is exactly the kind of write storm that produces a dropped frame the user reads as "the app is slow".

### 7.2 The rule

```
append:            seq = max(seq) + 1        -- integers in practice: 1, 2, 3, …
insert between a,b: seq = (a + b) / 2        -- 4, 5 → 4.5
fork:              seq copied from source    -- provenance preserved
```

No renumbering, ever. Ordering is `ORDER BY seq`, which the `(conversation_id, seq)` index satisfies without a sort.

```
before          insert between 2 and 3        after
──────          ──────────────────────        ─────
seq 1  user     seq = (2 + 3) / 2 = 2.5       1     user
seq 2  asst     ──────────────────────►       2     asst
seq 3  user     one INSERT, zero UPDATEs      2.5   system  ◄── new
seq 4  asst                                   3     user
                                              4     asst
```

### 7.3 Precision — the real limit, quantified

An IEEE-754 double has a 52-bit mantissa. Repeatedly halving the gap between two adjacent integers exhausts it after ~52 bisections: `1.5, 1.25, 1.125, …` and at the 52nd step the midpoint equals one of its endpoints and ordering collapses.

Fifty-two nested insertions *at the same position* is not a workload this app has. Appends use `max(seq) + 1` and never bisect. Forks copy rather than bisect. Bisection occurs only when a user inserts between two specific adjacent messages, and each insertion widens the available gaps for the next one everywhere except at that exact point. If a future feature can bisect programmatically in a loop, add the guard then: detect `(a + b) / 2 === a || === b` and renumber that conversation once. Do not pre-build it; the check itself is the documentation.

### 7.4 The `Number.EPSILON` in `regenerate()`

`src/stores/chat.ts` rewinds a transcript before regenerating:

```ts
const from = target.role === 'assistant' ? target.seq : target.seq + Number.EPSILON;
await deleteMessagesFrom(conversationId, from, target.role === 'assistant');
```

The intent is "delete strictly after this user message". The float cannot express it: `Number.EPSILON` is 2⁻⁵², while the representable gap between doubles near 2 is 2⁻⁵¹, so `2 + Number.EPSILON === 2` exactly. For any `seq >= 2` the addition is a no-op.

**The behaviour is still correct**, because `deleteMessagesFrom(id, from, inclusive)` with `inclusive = false` already emits `seq > ?`. The epsilon is redundant intent that the type cannot carry. It is documented here rather than deleted so that the next person to read it does not "fix" the exclusivity by making the comparison `>=` and taking the user's own message with it. If you touch this line, delete the epsilon and keep the `inclusive` flag — the flag is the mechanism.

### 7.5 `seq` versus `created_at`

Both exist and they are not interchangeable. `created_at` is wall-clock and can move backwards (device clock change, NTP correction) or tie (two rows in the same millisecond). `seq` is a position and is authoritative for order. Never `ORDER BY created_at` for transcript rendering; never use `seq` for a timestamp label.

---

## 8. JSON schemas for the `TEXT` columns

Five columns hold JSON. Each has a TypeScript type that is the normative definition; the JSON Schema fragments below are for validators and for readers who do not want to open the source.

### 8.1 `messages.content` — `ContentBlock[]`

```ts
export type ContentBlock =
  | TextBlock | ImageBlock | DocumentBlock
  | ThinkingBlock | ToolUseBlock | ToolResultBlock;
```

```ts
interface TextBlock      { type: 'text';    text: string }
interface ImageBlock     { type: 'image';   mediaType: string; data: string /* base64 */ }
interface DocumentBlock  { type: 'document'; mediaType: string; name?: string;
                           data?: string /* base64 */; text?: string /* extracted */ }
interface ThinkingBlock  { type: 'thinking'; text: string;
                           signature?: string;   // MUST be echoed verbatim on replay
                           redacted?: string }   // opaque redacted_thinking payload
interface ToolUseBlock   { type: 'tool_use'; id: string; name: string; input?: unknown }
interface ToolResultBlock{ type: 'tool_result'; toolUseId: string;
                           content: ContentBlock[]; isError?: boolean }
```

As JSON Schema (draft 2020-12), suitable for validating a stored row:

```json
{
  "$id": "https://superagent.local/schemas/content-blocks.json",
  "type": "array",
  "items": {
    "oneOf": [
      { "type": "object", "required": ["type", "text"],
        "properties": { "type": { "const": "text" }, "text": { "type": "string" } },
        "additionalProperties": false },
      { "type": "object", "required": ["type", "mediaType", "data"],
        "properties": { "type": { "const": "image" },
                        "mediaType": { "type": "string", "pattern": "^image/" },
                        "data": { "type": "string", "contentEncoding": "base64" } },
        "additionalProperties": false },
      { "type": "object", "required": ["type", "mediaType"],
        "properties": { "type": { "const": "document" }, "mediaType": { "type": "string" },
                        "name": { "type": "string" },
                        "data": { "type": "string", "contentEncoding": "base64" },
                        "text": { "type": "string" } },
        "anyOf": [ { "required": ["data"] }, { "required": ["text"] } ],
        "additionalProperties": false },
      { "type": "object", "required": ["type", "text"],
        "properties": { "type": { "const": "thinking" }, "text": { "type": "string" },
                        "signature": { "type": "string" }, "redacted": { "type": "string" } },
        "additionalProperties": false },
      { "type": "object", "required": ["type", "id", "name"],
        "properties": { "type": { "const": "tool_use" }, "id": { "type": "string" },
                        "name": { "type": "string" }, "input": true },
        "additionalProperties": false },
      { "type": "object", "required": ["type", "toolUseId", "content"],
        "properties": { "type": { "const": "tool_result" },
                        "toolUseId": { "type": "string" },
                        "content": { "$ref": "#" }, "isError": { "type": "boolean" } },
        "additionalProperties": false }
    ]
  }
}
```

Note `tool_result.content` recursing to the root schema: a tool result carries blocks, which may themselves be text or images. The recursion is one of the reasons `content` is stored as a document rather than shredded into rows — a self-referential structure in SQL needs an adjacency table and a recursive CTE to reassemble something the app only ever wants whole.

### 8.2 Storage-level validation in SQLite

SQLite can check the JSON without understanding it. These are *not* in the shipped schema (they would fire on legacy rows written before a block type existed), but they are the right thing to add at the next migration if silent corruption ever appears:

```sql
-- Candidate for v2, not currently applied:
ALTER TABLE messages ADD CONSTRAINT content_is_json
  CHECK (json_valid(content) AND json_type(content) = 'array');
```

The tradeoff: a `CHECK` turns a corrupt write into a thrown error at insert time (good — fails near the bug) but also turns a *forward-compatible* read of a newer block type into a hard failure if a future version writes something this one rejects. Given the app is single-writer and single-version on a device, the risk is low and the diagnostic value is high.

### 8.3 `flattenContent()` — the projection contract

```ts
// Conceptual shape; source of truth is src/db/conversations.ts
function flattenContent(blocks: ContentBlock[]): string {
  // text        → the text
  // document    → extracted text if present, else the file name
  // thinking    → EXCLUDED: reasoning is not the answer, and indexing it makes
  //               every search hit the model's musings instead of its reply
  // tool_use    → EXCLUDED: JSON arguments are noise in a prose index
  // tool_result → recurse into its blocks
  // image       → EXCLUDED: no text, and base64 would bloat the index
}
```

**If you add a seventh block type, you must decide its flattening in the same commit.** The default of "not included" is a search bug that will not surface until a user cannot find something they can see on screen.

### 8.4 `conversations.config` — `ConversationConfig`

```ts
interface ConversationConfig {
  systemPrompt?: string;
  sampling?: SamplingParams;
  reasoning?: ReasoningConfig;
  contextStrategy?: 'warn' | 'drop_oldest' | 'summarise';
  summary?: { text: string; throughSeq: number };
  maxOutputTokens?: number;
}

interface SamplingParams {
  temperature?: number;   // omitted entirely when reasoning is enabled
  topP?: number;          // (Anthropic pins temperature to 1 with thinking on)
  topK?: number;
  stopSequences?: string[];
}

interface ReasoningConfig {
  enabled: boolean;
  effort?: 'low' | 'medium' | 'high';  // OpenAI-shaped
  budgetTokens?: number;               // Anthropic-shaped; MIN_THINKING_BUDGET = 1024
}
```

Every field is optional and every reader supplies its own default. That is what makes §10.2 possible.

`summary.throughSeq` is the load-bearing field of the `summarise` context strategy: it records the `seq` up to which the rolling summary already covers the transcript, so the next request replaces exactly that prefix and nothing is either double-counted or silently dropped. It is a `seq`, not a message id, precisely because §7.2 guarantees `seq` is comparable with `<=` while ids are not.

### 8.5 `messages.usage` and `messages.meta`

```ts
interface TokenUsage {
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
  thinking?: number;   // stays undefined on Anthropic: thinking tokens are folded
                       // into output_tokens and not broken out — we don't guess
}

interface MessageMeta {
  transport?: 'anthropic' | 'openai' | 'custom';
  baseUrl?: string;            // which origin answered (primary or fallback)
  gatewayRequestId?: string;   // for support threads
  failedOver?: boolean;
  droppedParam?: string;       // set when a param was removed and the call retried
  retryCount?: number;
  latencyMs?: number;
  firstTokenMs?: number;
  estimated?: never;           // reserved: an estimate must never land here
}
```

`meta` is the correct home for anything diagnostic. It has no schema migration cost (§10.2), it is per-message so it survives model and profile changes, and it is excluded from `flattenContent()` so it never pollutes search.

---

## 9. Content-block encoding across the boundary

The same `ContentBlock[]` must round-trip through two dissimilar wire formats and one SQLite column. This table is the normative mapping; it was verified against `src/transports/anthropic.ts` and `src/transports/openai.ts`.

| Block | SQLite (`content` JSON) | Anthropic `/v1/messages` | OpenAI `/chat/completions` |
|---|---|---|---|
| `text` | `{"type":"text","text":"…"}` | `{type:'text', text}` | `{type:'text', text}` (or bare string) |
| `image` | `{"type":"image","mediaType":"image/png","data":"<b64>"}` | `{type:'image', source:{type:'base64', media_type, data}}` | `{type:'image_url', image_url:{url:'data:<mime>;base64,<data>'}}` |
| `document` (PDF) | `{"type":"document","mediaType":"application/pdf","data":"<b64>"}` | `{type:'document', source:{type:'base64', media_type:'application/pdf', data}}` | no native form → extracted text, else placeholder |
| `document` (text) | `…,"text":"…"` | `{type:'document', source:{type:'text', media_type:'text/plain', data:text}}` | inlined as a text block |
| `document` (other) | as stored | `[…no native document support for this type and no text was extracted.]` | same placeholder |
| `thinking` (signed) | `{"type":"thinking","text":"…","signature":"…"}` | `{type:'thinking', thinking:text, signature}` | dropped — no replay form |
| `thinking` (unsigned) | `{"type":"thinking","text":"…"}` | **dropped** — replay without a signature is a hard rejection | dropped |
| `thinking` (redacted) | `{"type":"thinking","text":"","redacted":"<opaque>"}` | `{type:'redacted_thinking', data:redacted}` | dropped |
| `tool_use` | `{"type":"tool_use","id":"…","name":"…","input":{…}}` | `{type:'tool_use', id, name, input}` | assistant `tool_calls:[{id, type:'function', function:{name, arguments:"<JSON string>"}}]` |
| `tool_result` | `{"type":"tool_result","toolUseId":"…","content":[…],"isError":true}` | `{type:'tool_result', tool_use_id, content, is_error}` | a separate message: `{role:'tool', tool_call_id, content}` |

Three consequences for the data model:

1. **The stored form is neither wire form.** It is a superset chosen so that either adapter can be generated from it, and so that a conversation started on an OpenAI-compatible profile can be continued on an Anthropic one. Storing the wire JSON directly would make the profile a property of the *history* rather than of the request.
2. **`signature` is data, not metadata.** It must be stored verbatim on the block, because dropping it turns a replayable thinking block into one that gets silently discarded on the next turn (and a visibly worse answer). Any transform over `content` must preserve unknown string fields.
3. **`tool_result` shape difference is an adapter concern.** The OpenAI adapter has to *split* one stored message into several wire messages. The store never models the wire split, so nothing in SQLite changes when a gateway changes that convention.

Request-shaping details that also derive from stored config rather than from the wire:

```ts
// Anthropic
body.thinking = reasoning.enabled
  ? { type: 'enabled', budget_tokens: budget }   // budget >= MIN_THINKING_BUDGET (1024)
  : { type: 'disabled' };
if (!thinkingOn) { body.temperature = …; body.top_p = …; body.top_k = …; }
//  ^ extended thinking pins temperature to 1; sending it is an error, not an override

// OpenAI
if (reasoning?.enabled && reasoning.effort) body.reasoning_effort = reasoning.effort;
const MAX_TOKENS_ALIAS = 'max_completion_tokens';  // retried once under the old name
```

---

## 10. Migration strategy

### 10.1 Numbered migrations — `PRAGMA user_version`

```
┌──────────────────────────────────────────────────────────────────┐
│  openDatabase()                                                  │
│    1. PRAGMA journal_mode = WAL                                  │
│    2. PRAGMA foreign_keys = ON        ← per connection, always    │
│    3. read PRAGMA user_version → v                               │
│    4. for each migration m where m.version > v:                  │
│         BEGIN;  m.up(db);  PRAGMA user_version = m.version; COMMIT│
│    5. ensureFts()   ← outside the numbered chain, idempotent      │
│    6. FTS drift check → rebuild if counts disagree               │
└──────────────────────────────────────────────────────────────────┘
```

Rules for adding a migration:

- **Append only.** Never edit a shipped migration; a device that already ran it will not run it again, so an edit produces two different schemas both claiming the same `user_version`.
- **One transaction per migration**, with the version bump inside it. A migration that half-applies and then bumps the version is unrecoverable on a device with no backup.
- **Additive first.** `ALTER TABLE … ADD COLUMN` with a `DEFAULT` is cheap and safe. SQLite cannot drop or retype a column in place; that needs the 12-step table rebuild (`CREATE new; INSERT … SELECT; DROP old; RENAME`), which on a large `messages` table means copying every base64 attachment. Budget for it or avoid needing it.
- **Never migrate the FTS table in the numbered chain.** It may not exist (§4.5). `ensureFts()` owns it.
- **Rebuild FTS after any migration that rewrites `messages`.** A table rebuild changes rowids; see §12.1.

A worked example — adding per-conversation pinned-model locking in a hypothetical v2:

```ts
const MIGRATIONS = [
  { version: 1, up: (db) => { /* … shipped schema … */ } },
  {
    version: 2,
    up: (db) => {
      // Additive, defaulted, no table rewrite, no FTS impact.
      db.execSync(`ALTER TABLE conversations ADD COLUMN model_locked INTEGER NOT NULL DEFAULT 0`);
      // Better index for the archived filter (see §11.3).
      db.execSync(`CREATE INDEX IF NOT EXISTS conversations_list
                     ON conversations (archived, pinned DESC, updated_at DESC)`);
      db.execSync(`DROP INDEX IF EXISTS conversations_order`);
    },
  },
];
```

### 10.2 How `config` evolves *without* a migration

`conversations.config` is a JSON document with every field optional. Adding a setting is therefore not a schema change:

```
Version A writes:  {"systemPrompt":"Be terse"}
Version B adds `contextStrategy` and reads:
    config.contextStrategy ?? DEFAULT_STRATEGY    → 'warn'
Version B writes:  {"systemPrompt":"Be terse","contextStrategy":"summarise"}
Version A reads it back: parses fine, ignores the unknown key, still works.
```

Two invariants make this safe, and both are requirements on *code*, not on the database:

1. **Every reader supplies a default.** No code path may assume a field is present. `config` may legitimately be `NULL`, `'{}'`, or a document written by any past version.
2. **Every writer merges, never replaces.** Updating one setting must be `{...parsed, contextStrategy: next}`. A writer that constructs a fresh object silently deletes fields it does not know about — which is how a downgrade-then-upgrade loses a user's system prompt.

**When JSON is the wrong answer.** Promote a field out of `config` into a real column when any of these becomes true:

| Signal | Why JSON fails | Example |
|---|---|---|
| You need to filter or sort by it | `json_extract` in a `WHERE` cannot use a normal index | "show conversations using extended thinking" |
| It must be `NOT NULL` | JSON cannot express required-ness | nothing today |
| It is written on a hot path | rewriting the whole document per keystroke | streaming state (which is why it is in Zustand, not here) |
| Two writers race on different fields | last-write-wins clobbers the other field | not currently possible — single writer |

The first row has an escape hatch worth knowing: SQLite supports indexes on expressions, so `CREATE INDEX ON conversations (json_extract(config, '$.contextStrategy'))` is legal and would make one such filter fast without a migration of the data. Reach for it before reshaping a table.

### 10.3 Migrating the AsyncStorage tier

Zustand's `persist` middleware has its own version counter, entirely separate from `PRAGMA user_version`:

```ts
persist(creator, {
  name: 'agentrouter.settings',
  version: 3,
  migrate: (state, from) => (from < 3 ? { ...DEFAULTS, ...state } : state),
  partialize: (s) => ({ /* only the durable fields — never a key, never a stream buffer */ }),
})
```

The `partialize` function is a security control as much as a size control: anything it returns is written to plaintext AsyncStorage. Review every addition to it with that framing.

**Two version numbers is the right design**, even though it is two things to remember. The tiers fail independently — a corrupt AsyncStorage blob should not prevent conversations from loading, and a failed SQL migration should not lose the user's provider profiles. Coupling them into one number would make either failure fatal to both.

---

## 11. Index strategy

### 11.1 The indexes, and the query each one exists for

| Index | Definition | Serves | Access path |
|---|---|---|---|
| implicit PK | `conversations(id)` | open a conversation | rowid lookup |
| `conversations_order` | `(pinned DESC, updated_at DESC)` | conversation list ordering | index scan, no sort |
| implicit PK | `messages(id)` | update/delete one message | rowid lookup |
| `messages_conversation` | `(conversation_id, seq)` | load a transcript in order | range scan, no sort |
| `tags` PK | `(conversation_id, tag)` | tags for one conversation; idempotent insert | range scan |
| `tags_tag` | `(tag)` | filter conversations by a tag chip | index scan → PK join |
| `usage_day` | `(day)` | daily/period spend report | range scan |
| `usage_model` | `(model)` | per-model breakdown | index scan |
| `messages_fts` | FTS5 inverted index | full-text search of message bodies | `MATCH` |

### 11.2 The reasoning, not just the list

`messages_conversation (conversation_id, seq)` is the most important index in the schema and it is a **covering-order** index: the leading column is the equality predicate, the second is the sort key. That combination lets SQLite satisfy `WHERE conversation_id = ? ORDER BY seq` by walking the index in order, with no temporary B-tree and no sort step. Reverse it to `(seq, conversation_id)` and every transcript load becomes a full scan plus a sort. The column order *is* the optimisation.

`tags_tag` exists because the tag filter arrives from a chip the user tapped, so it is an exact-equality lookup over a low-cardinality column — precisely the case where a secondary index pays for itself, since without it filtering by tag scans the whole join table.

No index on `messages.created_at`. Nothing queries by it (§7.5), and an unused index is pure write amplification: every insert maintains it, no read benefits.

### 11.3 A known index gap

`listConversations()` filters on `archived`:

```sql
SELECT … FROM conversations c WHERE c.archived = ?
ORDER BY c.pinned DESC, c.updated_at DESC
```

`conversations_order` is `(pinned DESC, updated_at DESC)` — it can serve the ordering but not the predicate, so SQLite either scans the index and filters every row, or scans the table. Either way the work is proportional to *all* conversations rather than to the unarchived ones. `(archived, pinned DESC, updated_at DESC)` would serve both: equality on the leading column, then ordering.

This is not urgent — the constant is small at realistic conversation counts, and archiving is rare, so most users have `archived = 0` on nearly every row and the filter discards almost nothing. It is logged in [06_Eng_Plan.md](06_Eng_Plan.md) as technical debt with the migration already drafted in §10.1, to be applied on the next migration for any reason rather than shipping a migration solely for it.

### 11.4 Verifying an index actually gets used

Assume nothing; ask the planner:

```sql
EXPLAIN QUERY PLAN
SELECT * FROM messages WHERE conversation_id = 'conv_x' ORDER BY seq;
-- want: SEARCH messages USING INDEX messages_conversation (conversation_id=?)
-- red flag: SCAN messages  /  USE TEMP B-TREE FOR ORDER BY
```

`USE TEMP B-TREE FOR ORDER BY` on a transcript load means the index is not being used for ordering and the query will degrade linearly with conversation length. It is the one planner output worth asserting on in a test.

---

## 12. Hazards inherent to the schema

These are properties of the design rather than bugs in a call site, which is why they are documented here.

### 12.1 `VACUUM` will silently desynchronise the FTS index

`messages` has a `TEXT PRIMARY KEY`, so it is **not** `WITHOUT ROWID` and its rowid is implicit and unstable. `messages_fts` is external-content FTS5 keyed on exactly that implicit rowid. `VACUUM` rebuilds the database file and may renumber implicit rowids. When it does, every FTS entry points at the wrong row: searches return the wrong messages, or nothing.

The startup drift check compares **row counts**, which are unchanged by renumbering, so it will report everything healthy.

**Rules:**
1. Never issue `VACUUM` (or `PRAGMA auto_vacuum` compaction, or any 12-step table rebuild of `messages`) without immediately running `INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')` in the same transaction.
2. If a stronger integrity check is ever needed, compare a checksum of `(rowid, text)` samples rather than counts — or make the check `INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')`, which FTS5 provides for exactly this purpose.
3. Consider `AS ROWID`-stable storage at the next major migration: an `INTEGER PRIMARY KEY` surrogate on `messages` would make the FTS key explicit and stable, at the cost of a second key to maintain.

### 12.2 In-memory preview drifts from the stored preview

`appendToTranscript()` sets the in-memory conversation's `preview` to the message's **full flattened text**, while `touchConversation()` writes `previewOf(text)` to the row — the first non-empty line, truncated to 160 characters. Until the next reload, the store and the database disagree.

The visible symptom is subtle: a conversation whose reply begins with a fenced code block or a heading shows a different preview immediately after the turn than it does after a restart. The fix is one line — call `previewOf()` on the store side too — and it belongs in the Phase 2 list-polish work rather than as a hotfix, since nothing is lost either way.

### 12.3 A mid-stream process death loses the partial reply

A message row is written only on a terminal path (`message_stop`, error, or abort). If Android kills the process while a stream is in flight — background eviction, OOM, force-stop — the accumulated blocks were only ever in the `useChat` store and are gone. The conversation reloads with the user's message and no reply.

This is a deliberate simplification: incrementally persisting a streaming message means an `UPDATE` per 60 ms publish tick, which multiplies write volume by roughly the number of chunks and drags the FTS triggers along for each one. The alternative, if the loss ever proves unacceptable, is a single-row scratch table (`streaming_partial`) written on the same throttle and promoted or discarded on the terminal event — one row rewritten in place, no FTS involvement. Costed in [06_Eng_Plan.md](06_Eng_Plan.md).

### 12.4 Hydration can race a write

`useHydrated()` waits for the persisted stores with a 3-second timeout, after which the app renders with defaults. If a store writes during that window, defaults can be persisted over stored values. The only mitigation in place is the convention that stores persist on explicit user changes rather than on mount. Any new store action that writes automatically at startup must first check hydration.

---

## 13. Synchronisation map: Zustand ↔ SQLite ↔ SecureStore

### 13.1 Ownership matrix

| State | Owner of truth | Cached in | Persisted where | Lifetime |
|---|---|---|---|---|
| Conversation list | SQLite | `useChat.conversations` | SQLite | until deleted |
| Transcript | SQLite | `useChat.messages[convId]` | SQLite | until deleted |
| Streaming partial | `useChat` | — | **nowhere** (§12.3) | until terminal event |
| Context pressure / gauge | derived | recomputed | never | render |
| Provider profiles | `useProviders` | — | AsyncStorage | until removed |
| Active profile id | `useProviders` | — | AsyncStorage | until changed |
| API key | SecureStore | module-scoped var in `secureKey.ts` | **SecureStore only** | until changed |
| Model catalogue | `useModels` | — | AsyncStorage | until refreshed |
| Per-model overrides | `useModels` | — | AsyncStorage | user-owned, never overwritten by discovery |
| Settings | `useSettings` | — | AsyncStorage | until changed |
| Usage events | SQLite | — | SQLite | forever (survives conversation delete) |
| Debug log | `src/lib/log.ts` ring buffer | — | **never persisted** | process |

### 13.2 Write flow for one chat turn (swim lanes)

```
UI            useChat (Zustand)      SQLite                SecureStore   Gateway
│                    │                  │                       │           │
├─ send(text) ──────►│                  │                       │           │
│                    ├─ insertMessage(user) ──►│                │           │
│                    │                  ├ INSERT messages       │           │
│                    │                  ├ FTS trigger           │           │
│                    │                  ├ touchConversation     │           │
│                    │◄─ ok ────────────┤  (preview, updated_at)│           │
│◄─ user bubble ─────┤                  │                       │           │
│                    ├─ resolveTransport() ────────────────────►│           │
│                    │                  │        loadApiKey ◄───┤           │
│                    │                  │        registerSecret │           │
│                    ├─ stream ────────────────────────────────────────────►│
│                    │◄── message_start ─────────────────────────────────────┤
│                    │◄── content_block_delta … (many) ──────────────────────┤
│◄ throttled 60ms ───┤   accumulate in memory ONLY                          │
│   publish          │   (no SQL — see §12.3)                               │
│                    │◄── message_stop + usage ──────────────────────────────┤
│                    ├─ insertMessage(assistant) ─►│                        │
│                    │                  ├ INSERT messages (content+text)    │
│                    │                  ├ FTS trigger                       │
│                    │                  ├ touchConversation                 │
│                    │                  ├ recordUsage  ← day + cost frozen  │
│                    │◄─ ok ────────────┤                                   │
│◄─ final bubble ────┤                  │                                   │
```

The ordering is deliberate: the **user's message is durable before the request goes out**. If the app dies during the call, the user's prompt is not lost — only the reply is, and the reply can be regenerated. Inverting this (write both at the end) would make a failed turn look like the user never typed anything.

### 13.3 Reconciliation rules

- **SQLite wins on reload.** `useChat` is a cache; any disagreement is resolved by re-reading. There is no merge, because there is no second writer.
- **Discovery refreshes only gateway-owned fields.** `useModels` distinguishes fields the gateway reports (context window, id, display name) from fields the user set (an override of the context window, a pinned max-output). A refresh overwrites the former and never the latter, keyed by `entryKey(profileId, modelId)` = `` `${profileId}::${modelId}` ``.
- **Key changes invalidate transports.** `keyFingerprint()` is part of the transport cache key in `src/lib/gateway.ts`, so pasting a new key in Settings drops the cached transport instead of quietly sending the old Bearer.
- **`clear all data` must clear all three tiers**, plus `clearRegisteredSecrets()`. Any one of them left behind is a privacy bug in a privacy-first app.

---

## 14. Query cookbook

Real statements, in the shape the app issues them. Parameters are always bound — never interpolated — both for injection safety and so SQLite can reuse the prepared statement.

### 14.1 Conversation list with tags and latest-message preview

```sql
SELECT
  c.id, c.title, c.updated_at, c.last_message_at, c.preview,
  c.model, c.profile_id, c.pinned, c.archived, c.config,
  group_concat(t.tag, char(1)) AS tags
FROM conversations c
LEFT JOIN tags t ON t.conversation_id = c.id
WHERE c.archived = ?
GROUP BY c.id
ORDER BY c.pinned DESC, c.updated_at DESC
LIMIT ? OFFSET ?;
```

`preview` is read from the column, not joined from `messages` — that is the denormalisation of §6.4 paying for itself. The `LEFT JOIN` matters: an untagged conversation must still appear, with `tags` as `NULL`.

The normalised alternative, for comparison, is what we are avoiding:

```sql
-- What we do NOT do: correlated subquery per row, JSON parse per row.
SELECT c.*, (
  SELECT substr(json_extract(m.content, '$[0].text'), 1, 160)
  FROM messages m WHERE m.conversation_id = c.id ORDER BY m.seq DESC LIMIT 1
) AS preview
FROM conversations c ORDER BY c.updated_at DESC;
```

That is one index seek plus one JSON parse per visible row, on the main database connection, during a scroll — and it is wrong for a message whose first block is an image.

### 14.2 Load a transcript

```sql
SELECT id, seq, role, created_at, content, text, model, usage,
       stop_reason, error, meta, excluded
FROM messages
WHERE conversation_id = ?
ORDER BY seq;
```

One range scan on `messages_conversation`, no sort (§11.2). Paging for very long conversations uses `seq` as the cursor rather than `OFFSET`, since `OFFSET` re-walks the skipped rows:

```sql
SELECT … FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT 50;
```

### 14.3 Full-text search with snippets, and its fallback

```sql
-- Preferred path: FTS5 available.
SELECT m.id, m.conversation_id, m.seq, m.role, m.created_at,
       c.title,
       snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet,
       bm25(messages_fts) AS rank
FROM messages_fts
JOIN messages      m ON m.rowid = messages_fts.rowid
JOIN conversations c ON c.id = m.conversation_id
WHERE messages_fts MATCH ?
ORDER BY rank
LIMIT ?;
```

```sql
-- Fallback: no FTS5 in this build, or a CJK query unicode61 cannot tokenise.
SELECT m.id, m.conversation_id, m.seq, m.role, m.created_at, c.title,
       substr(m.text, 1, 200) AS snippet
FROM messages m
JOIN conversations c ON c.id = m.conversation_id
WHERE m.text LIKE ? ESCAPE '\'   -- '%' || escaped(term) || '%', ANDed per term
ORDER BY m.created_at DESC
LIMIT ?;
```

`bm25()` returns a *negative* score where more relevant is more negative, so `ORDER BY rank` ascending is correct and `ORDER BY rank DESC` silently returns the worst matches first. The `ESCAPE` clause on the fallback is required: a user searching for `100%` or `snake_case` would otherwise get wildcard behaviour.

Note the two searches in the list screen are different features and stay that way. `filterConversations()` in [src/chat/list.ts](../src/chat/list.ts:70) filters rows already in memory over the fields the row *displays* (title, preview, model, tags), on every keystroke; `searchMessages()` hits SQLite for hits *inside* message bodies, debounced, rendered as a separate section. Both use `highlightTerms()` so one query string means one thing, but a row appearing under the first is always visibly justified by its own text.

### 14.4 Delete, and what cascades

```sql
PRAGMA foreign_keys = ON;            -- without this, nothing below cascades
DELETE FROM conversations WHERE id = ?;
-- ⇒ messages     : deleted by FK CASCADE
-- ⇒ messages_fts : deleted by the FTS delete trigger
-- ⇒ tags         : deleted by FK CASCADE
-- ⇒ usage_events : RETAINED (no FK, §5.2) — spend history survives
```

Rewinding a transcript for regenerate or edit:

```sql
-- inclusive = false (regenerating after a user message)
DELETE FROM messages WHERE conversation_id = ? AND seq >  ?;
-- inclusive = true  (replacing an assistant message)
DELETE FROM messages WHERE conversation_id = ? AND seq >= ?;
```

### 14.5 Fork a conversation at a message

```sql
BEGIN;
INSERT INTO conversations (id, title, created_at, updated_at, last_message_at,
                           preview, model, profile_id, config, pinned, archived,
                           forked_from_id, forked_from_message_id)
SELECT ?, title || ' (fork)', ?, ?, last_message_at, preview, model, profile_id,
       config, 0, 0, id, ?
FROM conversations WHERE id = ?;

-- seq values are COPIED, not renumbered: provenance is preserved and the
-- transcripts stay comparable position-by-position (§7.2).
INSERT INTO messages (id, conversation_id, seq, role, created_at, content, text,
                      model, usage, stop_reason, error, meta, excluded)
SELECT ?, ?, seq, role, created_at, content, text, model, usage, stop_reason,
       error, meta, excluded
FROM messages WHERE conversation_id = ? AND seq <= ?
ORDER BY seq;

INSERT OR IGNORE INTO tags (conversation_id, tag)
SELECT ?, tag FROM tags WHERE conversation_id = ?;
COMMIT;
```

In the real implementation each message gets a fresh `newId()` in JS rather than in SQL, because ids must be generated by the app's generator, not by a SQL expression. The transaction boundary is the point: a fork is atomic or it does not happen. A half-copied fork is a conversation that looks complete and is not.

### 14.6 Usage report for a period

```sql
SELECT day, model,
       sum(input_tokens)  AS input,
       sum(output_tokens) AS output,
       sum(cache_read)    AS cache_read,
       sum(cache_write)   AS cache_write,
       sum(coalesce(cost, 0))              AS known_cost,
       sum(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unpriced_events
FROM usage_events
WHERE day BETWEEN ? AND ?
GROUP BY day, model
ORDER BY day DESC, output DESC;
```

`unpriced_events` is the column that keeps the report honest. `sum(coalesce(cost, 0))` alone would render "$1.42" for a period containing forty unpriced calls; carrying the count lets the UI render "$1.42 + 40 unpriced" and never mislead the user about their spend.

### 14.7 Statements to never write

| Anti-pattern | Why |
|---|---|
| `SELECT * FROM messages` without a `conversation_id` | reads every base64 attachment on the device into JS |
| `ORDER BY created_at` for a transcript | clock skew reorders history (§7.5) |
| `UPDATE messages SET text = ?` alone | breaks the `text`/`content` invariant (§6.4) |
| `VACUUM` | desynchronises FTS silently (§12.1) |
| String-interpolated predicates | injection, and defeats statement reuse |
| `json_extract` in a `WHERE` on a hot list query | per-row parse, no index (§10.2) |
| `DELETE FROM usage_events` on conversation delete | erases accounting history (§5.2) |

---

## Appendix A — Column reference

**`conversations`**

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | TEXT | no | — | PK, `newId('conv_')` |
| `title` | TEXT | no | — | `deriveTitle()` from the first user message |
| `created_at` | INTEGER | no | — | epoch ms |
| `updated_at` | INTEGER | no | — | any touch; list sort key |
| `last_message_at` | INTEGER | yes | — | denormalised activity time |
| `preview` | TEXT | yes | — | `previewOf(text)`, ≤160 chars, first non-empty line |
| `model` | TEXT | no | — | current selection, not history |
| `profile_id` | TEXT | no | — | cross-tier soft reference |
| `config` | TEXT | yes | — | JSON `ConversationConfig` |
| `pinned` | INTEGER | no | 0 | 0/1 |
| `archived` | INTEGER | no | 0 | 0/1 |
| `forked_from_id` | TEXT | yes | — | soft self-reference |
| `forked_from_message_id` | TEXT | yes | — | soft reference |

**`messages`**

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | TEXT | no | — | PK, `newId('msg_')` |
| `conversation_id` | TEXT | no | — | FK CASCADE |
| `seq` | REAL | no | — | position; see §7 |
| `role` | TEXT | no | — | user / assistant / system |
| `created_at` | INTEGER | no | — | epoch ms, display only |
| `content` | TEXT | no | — | JSON `ContentBlock[]`, the truth |
| `text` | TEXT | no | `''` | flattened projection, FTS source |
| `model` | TEXT | yes | — | what answered *this* turn |
| `usage` | TEXT | yes | — | JSON `TokenUsage`, gateway-reported only |
| `stop_reason` | TEXT | yes | — | incl. Anthropic-only `pause_turn` |
| `error` | TEXT | yes | — | gateway text, verbatim |
| `meta` | TEXT | yes | — | JSON `MessageMeta`, diagnostics |
| `excluded` | INTEGER | no | 0 | user excluded this turn from context |

**`usage_events`** — see §4.4 for the two write-time freezes. **`tags`** — composite PK only.

## Appendix B — Checklists

### B.1 Adding a column

- [ ] Could this be a `config` / `meta` JSON field instead? (§10.2 — prefer JSON unless you must filter, sort, or constrain on it)
- [ ] New migration **appended** with the next version number; no shipped migration edited
- [ ] `ALTER TABLE … ADD COLUMN … DEFAULT …` — additive, no table rebuild
- [ ] Version bump inside the same transaction as the DDL
- [ ] Row-mapper in `src/db/conversations.ts` updated; TypeScript type updated
- [ ] Old rows read correctly with the default (test with a pre-migration fixture)
- [ ] If the column is derived, added to the denormalisation ledger (§6.5) with its writer
- [ ] `EXPLAIN QUERY PLAN` re-checked for any query whose predicate changed

### B.2 Adding a `ContentBlock` type

- [ ] Added to the `ContentBlock` union and the JSON Schema (§8.1)
- [ ] `flattenContent()` extended — indexed, or explicitly excluded with a reason (§8.3)
- [ ] Anthropic adapter encoding decided, including the "no native support" fallback
- [ ] OpenAI adapter encoding decided, including whether it splits into a separate message
- [ ] Renderer handles it, and handles it being *unknown* (forward compatibility)
- [ ] Round-trip test: store → Anthropic wire → parse → store is identity
- [ ] Round-trip test: store → OpenAI wire → parse → store is identity
- [ ] Any opaque field (a `signature` analogue) preserved verbatim through every transform

### B.3 Touching search or the FTS index

- [ ] Works with FTS5 **and** on the `LIKE` fallback path
- [ ] CJK query tested (falls back, does not silently return nothing)
- [ ] `bm25()` ordering ascending, not descending
- [ ] `LIKE` parameters escaped with `ESCAPE`
- [ ] No `VACUUM`; if the table was rebuilt, FTS rebuilt in the same transaction (§12.1)
- [ ] Drift check still meaningful for the change made

### B.4 Reviewing anything that persists

- [ ] No API key, token, or `Authorization` value reachable from a Zustand slice
- [ ] `partialize` reviewed — everything it returns lands in plaintext AsyncStorage
- [ ] Anything logged passes through `redact()` at the **write** boundary
- [ ] New secret-bearing field name added to `SECRET_KEY_RE` in `src/lib/redact.ts`
- [ ] `clear all data` clears the new state too, including `clearRegisteredSecrets()`

## Appendix C — Glossary

| Term | Meaning here |
|---|---|
| **Block** | One element of `ContentBlock[]`; the atom of message content |
| **bm25** | FTS5 relevance function; more negative = more relevant |
| **Denormalisation ledger** | §6.5 — the list of stored-derived columns and their writers |
| **Drift check** | Startup comparison of `messages_fts` and `messages` row counts |
| **External-content FTS** | FTS5 mode storing only the index, reading column data from a real table |
| **Flatten** | `flattenContent()`: `ContentBlock[]` → searchable prose |
| **Fork** | A new conversation copying a prefix of another, remembering its origin |
| **Fingerprint** | `keyFingerprint()`: `abcd…wxyz (51 chars)` — identifies a key without revealing it |
| **Hydration** | Zustand `persist` restoring AsyncStorage into a store at boot |
| **Partialize** | The `persist` option selecting which fields are written to disk |
| **Preview** | `previewOf(text)`: first non-empty line, ≤160 chars, for list rows |
| **Rowid** | SQLite's implicit integer row key; unstable across `VACUUM` (§12.1) |
| **seq** | `REAL` position of a message within a conversation (§7) |
| **Signature** | Opaque Anthropic thinking-block token; must be echoed verbatim on replay |
| **Soft reference** | A stored id with no foreign key, by design (§5.2) |
| **throughSeq** | The `seq` the rolling summary already covers |
| **Tier** | One of the three storage engines: SQLite / AsyncStorage / SecureStore |
| **user_version** | SQLite pragma holding the applied migration number |
| **WAL** | Write-ahead logging journal mode; concurrent read during write |

## Appendix D — Corrections to `progress.md`

Three details in `progress.md` (last updated 2026-08-21) have drifted from the source in this worktree. This document reflects the source.

| `progress.md` says | The source says | Where |
|---|---|---|
| 8 `GatewayError` kinds: `network / auth / client_rejected / rate_limit / server / validation / content_blocked / param_dropped` | **15 kinds**, differently named: `client_rejected · key_rejected · forbidden · content_blocked · unsupported_param · not_found · insufficient_credits · rate_limited · server · bad_request · validation · network · aborted · parse · unknown` | `src/transports/errors.ts` |
| Known gap: "`ModelCapabilities` has no `documents` flag" | `documents: boolean` **is** present | `src/transports/support.ts` |
| 22,309 lines of source | 22,591 lines as measured in this worktree | tree measurement |

Also worth recording: **the quality gates were not re-run while writing this document.** `node_modules` is absent from this worktree, so `tsc --noEmit`, `eslint .` and `jest` could not execute here. The figures cited elsewhere in the doc set (658 tests across 16 suites in ~3.4 s) are `progress.md`'s recorded run, not a fresh one. A static count of top-level `it(` / `test(` declarations in this tree gives 564 across 16 suites; the difference is table-driven cases generated inside loops.

---

## Ownership and maintenance

| | |
|---|---|
| **Owner** | Whoever owns `src/db/` — currently the sole maintainer (`Suke2004`) |
| **Reviewers required** | Any change to §4 (DDL), §5 (integrity), §10 (migrations) or §12 (hazards) |
| **Update when** | A migration is added · a column or index changes · a `ContentBlock` type is added · a JSON field is added to `config`/`meta` · a tier boundary moves · a hazard in §12 is fixed |
| **Do not update for** | Query tuning that changes no schema · UI changes · transport changes that do not alter the stored form |
| **Verification before merge** | Appendix B checklist for the relevant change type; `pnpm typecheck && pnpm lint && pnpm test` |
| **Staleness signal** | If `PRAGMA user_version` in `src/db/schema.ts` exceeds the version in this document's header table, this document is out of date |

Cross-references: sprint sequencing and the debt items raised here are tracked in [06_Eng_Plan.md](06_Eng_Plan.md); build and release mechanics in [07_Deployment.md](07_Deployment.md); product rationale in [PRD.md](../PRD.md); wire protocols and transport contracts in [TRD.md](../TRD.md); layer boundaries in [ARCHITECTURE.md](../ARCHITECTURE.md); phase status in [progress.md](../progress.md).

## Document history

| Version | Date | Author | Change summary |
|---|---|---|---|
| 1.0 | 2026-08-29 | Architecture review | Initial issue. Documents schema `user_version = 1` as shipped in Phase 1: full ER diagram and cardinalities, DDL reference, enforced and deliberately unenforced constraints, 1NF→3NF walkthrough with the four intentional violations, floating-point `seq` rationale including the precision limit and the redundant `Number.EPSILON`, JSON schemas for all five JSON columns, the cross-wire content-block encoding matrix, migration strategy for both SQL and JSON evolution, index rationale plus one identified gap, the three-tier synchronisation map, a query cookbook with anti-patterns, and four schema-level hazards (FTS/`VACUUM` desynchronisation, preview drift, mid-stream loss, hydration race). Appendix D corrects three stale entries in `progress.md`. |

