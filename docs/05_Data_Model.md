# 05 — Data Model

**SuperAgent · Persistence, State and Secrets**

| | |
|---|---|
| **Version** | 1.5 |
| **Status** | Current — describes schema `user_version = 8`: the Phase 1 baseline, the Phase 2 list index, `memories` (+ its `approved` review gate), `skills`, `mcp_servers`, `prompts`, `projects`, and the `turn_id`/`answers_id`/`hidden` columns that keep a regenerated reply's predecessor. Also covers the read paths added in Sprint 6 (bulk operations §5.3, the export projection §9.1) and every content block a v1.1 reply can carry (§8.1, §8.3) |
| **Audience** | Mid-level engineers and architects joining the persistence, chat-store or search work |
| **Companion docs** | [PRD.md](PRD.md) · [TRD.md](TRD.md) · [GUIDELINES.md](GUIDELINES.md) · [ARCHITECTURE.md](../ARCHITECTURE.md) · [progress.md](../progress.md) · [06_Eng_Plan.md](06_Eng_Plan.md) · [07_Deployment.md](07_Deployment.md) |

---

## Executive summary

This document is the single authoritative description of **where every byte of user data lives, who owns it, and what invariants hold across the storage tiers** of SuperAgent. It exists because the app is offline-first and privacy-first: there is no server to reconcile against, no cloud copy to re-download, and no telemetry pipeline to reconstruct history from. If a write is wrong on device, it is wrong forever. That raises the cost of a schema mistake far above the norm for a chat client, so the schema is documented at the level of *why each column exists* rather than merely *what type it is*.

Three engines hold state, and the split is a security boundary, not an optimisation:

- **SQLite** (`expo-sqlite`, WAL, **encrypted with SQLCipher**) holds conversations, messages, tags, usage events, memories, skills, MCP server rows, prompts and projects — everything large, queryable, historical, or user-authored.
- **AsyncStorage**, via `zustand/middleware/persist`, holds provider profiles, model metadata, settings and estimator calibration — small, whole-object, read-at-boot state.
- **SecureStore** (Android Keystore) holds API keys, MCP credentials and the database key, and nothing else. **Secrets are deliberately absent from every Zustand slice**, because persisted slices land in AsyncStorage, which is plaintext on a rooted device.

A fourth tier exists in the sense that matters for a data-model document: **the app's own document directory**, which holds the files a model writes. Those are not in the database (§4.11) — a `.docx` or a PDF is bytes with a filename, and a row that duplicated them would double the storage and give two answers to "what is the file". It is also the one tier nothing cascades to, which is a hazard in its own right (§12.5).

Read this document before you add a column, add a JSON field, write a query, or touch the FTS index. Sections 3–6 are the normative schema. Section 7 explains the floating-point `seq` key, which is the one design decision most likely to look like a bug on first contact. Section 12 records seven hazards — including a `VACUUM`-versus-FTS5 desynchronisation that the current startup drift check cannot detect, and the fact that encrypting the database converts a recoverable-data problem into an unrecoverable one — that are properties of the schema rather than of any one call site, and therefore belong here rather than in a code comment.

Where this document disagrees with `progress.md`, this document is correct: it was written against the source in this worktree.

---

## 1. Scope, non-goals, and how to read the diagrams

**In scope:** the SQLite schema at `user_version = 8`, the JSON documents stored inside its `TEXT` columns, the persisted Zustand shapes, the SecureStore key namespace, the document directory, the synchronisation rules between them, index rationale, query patterns, and the migration mechanism.

**Out of scope:** the wire protocols themselves (see [TRD.md](TRD.md) and `src/transports/`), the retry and failover policy ([06_Eng_Plan.md](06_Eng_Plan.md) §critical path), and UI rendering of any of this.

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
│  PERSISTED → AsyncStorage      IN-MEMORY, BACKED BY SQLITE          │
│    useProviders                  useChat      (rebuilt from rows)   │
│    useModels                     useSkills    useMcp                │
│    useSettings                   usePrompts   useProjects           │
│    useCalibration                useMemory                          │
│                                EPHEMERAL: useQueue, useReachability │
└───────┬──────────────────────────────┬──────────────────────┬───────┘
        │                              │                      │
┌───────▼─────────────┐   ┌────────────▼──────────┐  ┌────────▼───────┐
│  SQLite (WAL)       │   │  AsyncStorage         │  │  SecureStore   │
│  expo-sqlite        │   │  plaintext on disk    │  │  Android       │
│  + SQLCipher        │   │                       │  │  Keystore      │
│  conversations      │   │  agentrouter.providers│  │                │
│  conversation_tags  │   │  agentrouter.models   │  │  apiKey:<pid>  │
│  messages           │   │  agentrouter.settings │  │  mcp.<id>      │
│  messages_fts (+3   │   │  agentrouter.calib…   │  │  db key (32 B) │
│    triggers)        │   │                       │  │                │
│  usage_events       │   │  small, whole-object,  │  │  + module-     │
│  memories  skills   │   │  rewritten on change  │  │    scoped RAM  │
│  mcp_servers        │   │                       │  │    cache,      │
│  prompts  projects  │   │  NEVER secrets        │  │    dropped on  │
│                     │   │                       │  │    background  │
│  large, queried,    │   │                       │  │                │
│  incrementally      │   │                       │  │  ONLY secrets  │
│  mutated            │   │                       │  │                │
└─────────────────────┘   └───────────────────────┘  └────────────────┘
        │
┌───────▼──────────────────────────────────────────────────────────────┐
│  DOCUMENT DIRECTORY — files a model wrote (§4.11)                     │
│  not in the database; referenced from a message block by name          │
└──────────────────────────────────────────────────────────────────────┘
```

**The allocation rule.** Data goes in SQLite if it is unbounded in size, needs to be queried by predicate, or must survive partial writes. It goes in AsyncStorage if it is a bounded configuration object read once at boot and rewritten wholesale on change. It goes in SecureStore if disclosing it would let someone else spend the user's money or read the database. It goes in the document directory if it is a file — something the user will open, share, or hand to another app.

That third tier is absolute. `src/lib/secureKey.ts` is the only module that reads an API key; it caches the value in a module-scoped variable and registers it with `src/lib/redact.ts` on every load, so the redactor can scrub it out of any log line, export or crash message before it is written. The cache — and the cached transports holding it — are dropped when the app is backgrounded and the redactor re-primed on the way back. No secret is ever passed into a Zustand `set()`.

**The database itself is encrypted.** `src/db/cipher.ts` holds a 32-byte key in the Keystore and opens the file through SQLCipher; an existing plaintext database is converted once via `sqlcipher_export`. That key is deliberately *not* gated behind the app lock, because the offline send queue needs database access while the device is locked (§13.3).

---

## 3. Entity–relationship diagram

```
                     ┌──────────────────────────────────────┐
                     │              projects                │
                     ├──────────────────────────────────────┤
                     │ PK  id                  TEXT         │
                     │     created_at/updated_at  INTEGER   │
                     │     name                TEXT         │
                     │     instructions        TEXT         │
                     │     knowledge           TEXT  (JSON) │
                     └───────────────┬──────────────────────┘
                                     │ 1
                          [FK] SET NULL, and cleared in app code
                                     │
                        ┌────────────▼─────────────────────────┐
                        │            conversations             │
                        ├──────────────────────────────────────┤
                        │ PK  id                  TEXT         │
                        │     title               TEXT         │
                        │     created_at          INTEGER      │
                        │     updated_at          INTEGER (idx)│
                        │     last_message_at     INTEGER  ▲den│
                        │     preview             TEXT     ▲den│
                        │     model               TEXT         │
                        │     profile_id          TEXT    (idx)│
                        │     config              TEXT  (JSON) │
                        │     pinned              INTEGER (idx)│
                        │     archived            INTEGER      │
                        │     forked_from_id      TEXT  [soft] │
                        │     forked_from_msg_id  TEXT  [soft] │
                        │     project_id          TEXT  (idx)  │
                        └───┬──────────────┬────────────────┬──┘
                            │              │                │
              1             │            1 │              1 │
              │             │              │                │
              │        [FK] ▼ CASCADE [FK] ▼ CASCADE        │ [soft]
              │      ┌──────┴───────┐  ┌───┴───────────────┐│  no FK
              │      │   messages   │  │ conversation_tags ││
              │      ├──────────────┤  ├───────────────────┤│
              │      │ PK id   TEXT │  │ PK(conv, tag)     ││
              │      │ FK conv_id   │  │ FK conv_id        ││
              │      │    seq  REAL │  │    tag  TEXT (idx)││
              │      │    role      │  └───────────────────┘│
              │      │    created_at│                       │
              │      │    content   │◄──── JSON            │
              │      │      ContentBlock[]                  │
              │      │    text  ▲den│ ── flattened          │
              │      │    model     │                       │
              │      │    usage     │◄──── JSON TokenUsage  │
              │      │    stop_reason                       │
              │      │    error     │                       │
              │      │    meta      │◄──── JSON MessageMeta │
              │      │    excluded  │                       │
              │      │    turn_id   │ ─┐ regeneration       │
              │      │    answers_id│  │ variants (§4.2,    │
              │      │    hidden    │ ─┘ idx messages_      │
              │      └──┬───────────┘    variants)          │
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

       ┌─────────────────────────────────────┐
       │              memories               │  no edge to conversations that
       ├─────────────────────────────────────┤  the database enforces: the
       │ PK  id                     TEXT     │  reference is soft on purpose,
       │     kind                   TEXT     │  because a memory is *meant* to
       │     text                   TEXT     │  outlive the conversation it
       │ UQ  (kind, text)                    │  was learned from (§4.6, §5.2)
       │     source_conversation_id TEXT[soft]
       │     hits                   INTEGER  │  approved = 0 → stored but
       │     last_used_at           INTEGER  │  never sent (§4.6, migration 5→6)
       │     pinned                 INTEGER  │
       │     approved               INTEGER  │
       └─────────────────────────────────────┘

  ── User-authored tables. No foreign key to a conversation in either direction:
     a conversation's `config` names them by *name*, not by id (§5.2). ──────────

  ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
  │       skills       │ │    mcp_servers     │ │      prompts       │
  ├────────────────────┤ ├────────────────────┤ ├────────────────────┤
  │ PK id        TEXT  │ │ PK id        TEXT  │ │ PK id        TEXT  │
  │ UQ name      TEXT  │ │ UQ name      TEXT  │ │    title     TEXT  │
  │    description     │ │    url             │ │    body      TEXT  │
  │    body            │ │    transport       │ │    uses      (idx) │
  └────────────────────┘ │    auth_kind       │ │    last_used_at    │
    only name +          │    headers  (JSON) │ └────────────────────┘
    description reach    │    oauth    (JSON) │
    a prompt; `body` is  │    tools    (JSON) │   NO TOKEN COLUMN in
    fetched by the       │    catalogue(JSON) │   mcp_servers — bearer
    invoke_skill tool    │    enabled  (JSON) │   and OAuth tokens live
                         │    approvals(JSON) │   in SecureStore under
                         │    last_error      │   `mcp.<id>`, because a
                         │    last_seen_at    │   database file gets
                         └────────────────────┘   backed up and copied

▲den = deliberately denormalised, justified in §6.4
```

### 3.1 Cardinalities, stated precisely

| Relationship | Cardinality | Enforced by | On parent delete |
|---|---|---|---|
| `conversations` → `messages` | 1 : 0..N | FK on `messages.conversation_id` | CASCADE |
| `conversations` → `conversation_tags` | 1 : 0..N | FK, PK `(conversation_id, tag)` | CASCADE |
| `messages` → `messages_fts` | 1 : 1 | FTS5 external-content triggers | trigger DELETE |
| `messages` → sibling variants | 1 : 0..N | `(conversation_id, answers_id, turn_id)`, index only | — |
| `projects` → `conversations` | 0..1 : 0..N | FK `ON DELETE SET NULL`, **and** cleared in app code | `project_id` set to NULL |
| `conversations` → `usage_events` | 1 : 0..N | **nothing** — soft reference | rows survive (§5.2) |
| `conversations` → `memories` | 1 : 0..N | **nothing** — soft reference | rows survive (§4.6) |
| `conversations` → `conversations` (fork) | 0..1 : 0..N | **nothing** — soft reference | rows survive |
| `conversations.config` → `skills` / `mcp_servers` | N : M | **nothing** — config stores *names* | an enabled name stops resolving |
| provider profile → `conversations` | 1 : 0..N | **nothing** — `profile_id` is a string, profiles live in AsyncStorage | rows survive with a dangling id |
| provider profile → SecureStore key | 1 : 0..1 | naming convention `apiKey:<profileId>` | key deleted explicitly by the store action |
| `mcp_servers` row → SecureStore credential | 1 : 0..1 | naming convention `mcp.<id>` | key deleted explicitly by the store action |

The soft rows are the interesting ones, and they are the price of the tier split. A conversation's `profile_id` points into a *different storage engine*, so SQLite cannot enforce it. Every read path therefore treats `profile_id` as a hint: `resolveTransport()` falls back to `activeProfile()` when the id no longer resolves, rather than throwing. Deleting a provider profile does not orphan conversations; it makes them re-home to whatever is active, which is the behaviour a user expects when they delete a gateway and keep chatting.

**`project_id` is enforced twice on purpose.** The column carries `REFERENCES projects (id) ON DELETE SET NULL`, and the app clears it in code as well. `PRAGMA foreign_keys` is a *per-connection* setting, so a schema that relied on the SQL alone would leave dangling ids behind any connection that forgot to switch it on — including a future maintenance script.

---

## 4. Table reference (DDL as shipped)

The full DDL lives in `src/db/ddl.ts` — a module with no `expo-sqlite` import, so tests can build the real schema under `node:sqlite`; `src/db/schema.ts` re-exports it and owns the connection. It is reproduced here in the order the migration creates it, with the commentary that matters for consumers.

### 4.1 `conversations`

```sql
CREATE TABLE conversations (
  id                     TEXT    PRIMARY KEY NOT NULL,
  title                  TEXT    NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  pinned                 INTEGER NOT NULL DEFAULT 0,
  archived               INTEGER NOT NULL DEFAULT 0,
  system_prompt          TEXT,
  profile_id             TEXT    NOT NULL,
  model                  TEXT    NOT NULL,
  config                 TEXT    NOT NULL DEFAULT '{}',  -- JSON ConversationConfig
  forked_from_id         TEXT,
  forked_from_message_id TEXT,
  last_message_at        INTEGER,
  preview                TEXT,
  project_id             TEXT REFERENCES projects (id) ON DELETE SET NULL  -- migration 6 → 7
);
CREATE INDEX conversations_profile ON conversations (profile_id);
-- conversations_order was dropped in migration 1 → 2 and replaced by:
CREATE INDEX conversations_list ON conversations (archived, pinned DESC, updated_at DESC, id DESC);
CREATE INDEX conversations_project ON conversations (project_id, updated_at DESC, id DESC);
```

`updated_at` versus `last_message_at` is a real distinction, not redundancy. `updated_at` is *any* touch — rename, retag, config change, message. `last_message_at` is conversation activity. The list screen sorts and groups by `updated_at` (`rowTime()` in [src/chat/list.ts](../src/chat/list.ts:34)) because the question the user is asking that screen is "when did I last *touch* this", and because sorting by a different column than the headings group by would put yesterday's heading above today's row.

`system_prompt` is a column of its own while every other generation control lives inside `config`, and the split is historical rather than principled: the prompt predates the config blob. It is also the one the project feature has to compose with — `src/chat/project.ts` prepends the project's instructions *above* this value at send time rather than merging them into it, so a user editing a conversation's prompt never has to reason about text they did not write (§8.4).

`config` is `NOT NULL DEFAULT '{}'`, not nullable. Every read can therefore `JSON.parse` unconditionally; §10.2 covers how new keys arrive without a migration.

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
  excluded        INTEGER NOT NULL DEFAULT 0,
  -- migration 7 → 8: regeneration keeps the previous reply
  turn_id         TEXT,
  answers_id      TEXT,
  hidden          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_conversation ON messages (conversation_id, seq);
CREATE INDEX messages_variants ON messages (conversation_id, answers_id, turn_id);
```

Four columns deserve comment:

- **`content`** is the truth. Every block the model produced or the user attached, in order, as JSON. Rendering, replay-to-the-API and forking all read this.
- **`text`** is a projection of `content` for search and previews (§6.4). It is written by `flattenContent()` at insert time and must never be edited independently.
- **`usage`** holds `TokenUsage` **only when the gateway reported it**. The heuristic estimator in `src/lib/tokens.ts` feeds the UI's context gauge and nothing else; an estimate is never persisted here, because a persisted estimate becomes an authoritative-looking number in a cost report.
- **`error`** stores the gateway's own message verbatim. We do not rewrite it into friendly prose at rest — a user pasting a real gateway string into a support thread is worth more than a polished one.

**The three regeneration columns are the alternative to branching the transcript**, and the choice is worth understanding before touching any read path. Regenerating a reply hides the old one instead of deleting it:

- **`turn_id`** groups every row one generation pass wrote. A turn that called tools writes an assistant row *and* a `tool_result` row per round, and paging away from that reply has to take all of them — so the group is keyed by the pass, not by a message id.
- **`answers_id`** is the user message this turn answers: the slot the variants compete for.
- **`hidden`** marks an unselected variant. Hidden rows are filtered out of the transcript, the preview, search and every request, and are dropped outright by the next send.

The invariant that keeps this cheap: **hidden rows only ever exist for the turn at the end of the conversation.** The transcript therefore stays one linear path, and the request builder, the trim ladder and the exporters all keep reading a flat list — which is exactly where a subtle bug would cost money. Every pre-migration row keeps `NULL`/`NULL`/`0`, which reads as "a turn of its own, with no siblings", so nothing had to be rewritten to migrate.

### 4.3 `conversation_tags`

```sql
CREATE TABLE conversation_tags (
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  tag             TEXT NOT NULL,
  PRIMARY KEY (conversation_id, tag)
);
CREATE INDEX conversation_tags_tag ON conversation_tags (tag);
```

A pure join table with no surrogate key: the natural key *is* the pair, and a composite PK gets idempotent tagging (`INSERT OR IGNORE`) for free. Tags are stored as typed but compared case-insensitively; `parseTags()` deduplicates on `toLowerCase()` while keeping the first spelling the user typed, so `Work` and `work` are one tag and the user's own capitalisation survives.

Reads aggregate tags into the conversation row with `group_concat(tag, char(1))` and split on `TAG_SEPARATOR = ''`. A control character, not a comma — a comma is a legal character inside a tag, and the separator must be one that cannot appear in the data. (`TAG_SEPARATOR` is `U+0001`, ASCII SOH — it appears empty when rendered.)

### 4.4 `usage_events`

```sql
CREATE TABLE usage_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              INTEGER NOT NULL,
  day             TEXT    NOT NULL,   -- 'YYYY-MM-DD', local calendar day
  profile_id      TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  input           INTEGER NOT NULL DEFAULT 0,
  output          INTEGER NOT NULL DEFAULT 0,
  thinking        INTEGER,
  cache_read      INTEGER,
  cache_write     INTEGER,
  cost            REAL,               -- NULL when pricing is unknown
  conversation_id TEXT                -- soft reference, no FK
);
CREATE INDEX usage_events_day   ON usage_events (day);
CREATE INDEX usage_events_model ON usage_events (model);
```

This is the one table with an integer surrogate key rather than a generated `TEXT` id. Nothing references a usage event, so there is no need for an id that can be minted before the insert — and `AUTOINCREMENT` gives insertion order for free, which is the only order a spend log is ever read in.

`thinking`, `cache_read` and `cache_write` are nullable while `input` and `output` default to `0`, and the distinction is the same one `cost` makes below: a gateway that does not report cache figures leaves `NULL`, which the dashboard renders as absent rather than as zero.

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

At startup a **drift check** asks FTS5 to verify itself with `INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)`, and issues `'rebuild'` when that raises. The `rank = 1` argument is the whole point: without it, FTS5 checks only that its own inverted index is internally well-formed, which stays true when the index and the `messages` rows have drifted apart. With it, FTS5 re-derives the index from the content table and compares — so an edited message body whose trigger never fired is caught. `src/db/__tests__/fts-integrity.test.ts` reproduces exactly that damage and asserts both halves. See §12.1 for the case even this check cannot see.

The earlier check compared `count(*)` across the two tables, which is a strictly weaker claim: an `UPDATE` that changes a body leaves the counts identical and the index wrong, so search kept matching words the message no longer contained. That was debt D-03, now closed.

---

### 4.6 `memories`

```sql
CREATE TABLE IF NOT EXISTS memories (
  id             TEXT    PRIMARY KEY NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  kind           TEXT    NOT NULL,   -- 'preference' | 'fact' | 'project' | 'style'
  text           TEXT    NOT NULL,   -- one sentence, third person, about the user
  source_conversation_id TEXT,       -- soft reference, no FK
  hits           INTEGER NOT NULL DEFAULT 1,
  last_used_at   INTEGER,
  pinned         INTEGER NOT NULL DEFAULT 0,
  -- migration 5 → 6: a review gate. 0 = stored but never sent.
  approved       INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS memories_unique ON memories (kind, text);
CREATE INDEX IF NOT EXISTS memories_rank ON memories (pinned DESC, hits DESC, updated_at DESC);
```

The durable things the app has learned about the user, carried into the system prompt of every later conversation. A distillation pass every few assistant turns asks the model what it learned that would still be true in a different conversation; `src/chat/memory.ts` parses, screens and folds the answer, and this table stores what survives.

**This is the only table whose rows are written by the model rather than by the user.** Every column below exists to contain a consequence of that.

**`(kind, text)` is unique, and writes are an UPSERT.** Re-learning something bumps `hits` and `updated_at` instead of inserting a second row:

```sql
INSERT INTO memories (…) VALUES (…)
ON CONFLICT (kind, text) DO UPDATE SET hits = hits + 1, updated_at = excluded.updated_at
```

Two conversations distilling in the same minute can independently produce the identical sentence, so this has to be a constraint rather than a check-then-insert. Note what the clause deliberately does *not* touch: `pinned` and `created_at` survive a restatement, because a user's pin is not something a later extraction gets to undo.

Uniqueness is on the pair, not on `text` alone. The same sentence under two kinds is two memories, and the distinction carries weight: "writes terse commit messages" as a `style` is an instruction to follow, as a `fact` it is merely true.

Exact-match uniqueness is only half of deduplication. It cannot see that "prefers TypeScript over JavaScript" and "the user prefers TypeScript over JavaScript" are one memory, so `sameMemory()` folds near-duplicates by Jaccard overlap *before* the write. The index is the backstop, not the mechanism.

**`hits` is a ranking signal, not a truth claim.** The prompt block is budgeted in characters (§`MEMORY_BUDGET_CHARS`, 1,600), and when everything does not fit, something has to be dropped. Ranking is `pinned DESC, hits DESC, updated_at DESC` — restatement above recency, because one stray extraction from last night should not outrank a preference the user has confirmed for a month. `memories_rank` spells that ORDER BY out exactly, so the read is an index scan with no TEMP B-TREE.

**`last_used_at` is written after a send, not during ranking.** It is provenance for the settings screen — "last used 12 August" is how a user judges whether a memory is still earning its place in every request — and it deliberately does not feed the ranking, which would make the ordering self-reinforcing.

**No column here may hold a secret.** The distillation prompt sees the conversation, so a user who pasted a token into a message could have it reflected back as a "fact worth remembering" and then written to the database and replayed into every subsequent request. Candidates are screened with `isSafeToRemember()`, which is `redactString(text) === text` — the same redaction the debug log uses. A candidate that changes under redaction is **dropped, not stored redacted**: a memory reading "the user's key is [REDACTED]" is worth nothing and looks like a bug.

**The user can see, edit, and destroy all of it.** `app/settings/memory.tsx` lists every row verbatim with its provenance, allows per-row edit/pin/delete, and has a one-confirmation "Forget everything". `settings.memoryEnabled` is a separate control that stops both halves of the feature — no block is sent and no distillation request is made — while keeping what is already stored, because "stop learning" and "forget everything" are different intentions.

**`approved` is a review gate, and it is the security column on this table** (migration 5 → 6). Model-authored text was going straight into the system prompt of every later conversation, which makes anything the distiller picks up — including a line from an attached document that reads like a preference — **persistent cross-conversation prompt injection that outlives the chat it entered through**. An unapproved memory is stored and visible in Settings → Memory, and never sent. `isSafeToRemember()` (above) stops a *secret* from being stored; `approved` stops an *instruction* from being obeyed. They are different attacks and need different controls.

The default is `1`, not `0`, and that is a deliberate one-time exception rather than a weak default: rows that already existed were learned under the old contract, are already visible and editable, and re-reviewing them buys nothing. Only new distillations insert a `0`.

---

### 4.7 `skills`

```sql
CREATE TABLE IF NOT EXISTS skills (
  id          TEXT    PRIMARY KEY NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL,
  body        TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS skills_name ON skills (name);
```

Instruction bundles the user writes or imports (`SKILL.md` shape), switched on per conversation. **Only `name` and `description` ever reach a prompt**; `body` is fetched by the `invoke_skill` tool when the model decides it needs it. That progressive disclosure is the whole reason a phone can afford several skills at once — ten full bodies in every request would be thousands of tokens the user pays for on every turn, whether or not any of them was relevant.

`name` is a slug because it is the tool argument's enum value: the model has to type it back verbatim, so a name with spaces or mixed case is a name it will get wrong. It is unique because `ConversationConfig.skills` stores *names*, not ids — two skills answering to one name would make an enabled toggle ambiguous.

### 4.8 `mcp_servers`

```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
  id           TEXT    PRIMARY KEY NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  url          TEXT    NOT NULL,
  transport    TEXT    NOT NULL DEFAULT 'http',   -- 'http' | 'sse', never stdio
  auth_kind    TEXT    NOT NULL DEFAULT 'none',   -- 'none' | 'bearer' | 'oauth'
  headers      TEXT    NOT NULL DEFAULT '{}',     -- JSON, user-configured statics
  oauth        TEXT,                              -- JSON client id/endpoints/expiry
  tools        TEXT    NOT NULL DEFAULT '[]',     -- JSON McpTool[] from discovery
  catalogue    TEXT    NOT NULL DEFAULT '{}',     -- JSON resources + prompts
  enabled      TEXT    NOT NULL DEFAULT '[]',     -- JSON string[] of tool names
  approvals    TEXT    NOT NULL DEFAULT '{}',     -- JSON 'ask'|'always'|'deny' per tool
  last_error   TEXT,
  last_seen_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_servers_name ON mcp_servers (name);
```

**There is no token column, and that absence is the design.** A bearer token and an OAuth access token are credentials, so they live in `expo-secure-store` under `mcp.<id>` beside the API key. A database file gets backed up, copied to a computer, and read by anything that has the file — and the app's own backup/restore would carry a token column straight out of the Keystore's protection. What this table stores is the non-secret half: where the server is, what it said it can do, and what the user decided about it. `headers` carries user-configured statics such as an `X-Api-Key`; a bearer token must never be written there, because that column *is* in the backup.

`transport` is `'http'` (Streamable HTTP) or `'sse'` (the 2024-11-05 transport). **Never stdio** — Android has no child process to speak it to ([PRD.md](PRD.md) §3).

`enabled` exists for a token-budget reason, not a preference one: a server advertising forty tools would otherwise put 8–15k tokens of JSON schema into every request. `approvals` is the standing per-tool decision from the approval sheet, so a user who has said "always" once is not asked again.

`tools` and `catalogue` are caches of the last discovery, held so a send does not need a round trip on the turn's hot path. `last_error` and `last_seen_at` let the settings row be honest about a server that has stopped answering, instead of looking configured and silently failing at send time.

### 4.9 `prompts`

```sql
CREATE TABLE IF NOT EXISTS prompts (
  id           TEXT    PRIMARY KEY NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  title        TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  uses         INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS prompts_rank ON prompts (uses DESC, updated_at DESC);
```

Reusable message templates with `{{variables}}`. `uses` is bumped on use so the list puts what the user actually reaches for at the top, and `prompts_rank` spells that ORDER BY out exactly, so the read is an index scan rather than a scan-and-sort — the same reasoning as `memories_rank` (§4.6).

Note what this table does *not* have: a unique index on `title`. Nothing stores a prompt by name, so two prompts may share a title; the id is the only identity that matters.

### 4.10 `projects`

```sql
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT    PRIMARY KEY NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  instructions TEXT    NOT NULL DEFAULT '',
  knowledge    TEXT    NOT NULL DEFAULT '[]'   -- JSON [{name, text}]
);
ALTER TABLE conversations
  ADD COLUMN project_id TEXT REFERENCES projects (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS conversations_project
  ON conversations (project_id, updated_at DESC, id DESC);
```

A group of conversations that share instructions and documents. It is a table rather than a reuse of `conversation_tags` because a project carries content of its own: a tag is a label with nothing behind it, and this has a prompt every chat in the group inherits plus a document set they all read. Hanging those off a string in a join table would mean a second table anyway.

**`knowledge` stores already-extracted text, not the original bytes.** `[{name, text}]` — what a model can read, under the filename it came from. The uploaded file itself is not kept, which is the same rule attachments follow (§9): the app persists what goes into a request, not the artefact that produced it. The consequence to state plainly is that a project document cannot be re-downloaded from the app later; the user's copy is the only copy.

`instructions` is prepended to the system prompt of every conversation in the project, above the conversation's own prompt, fenced and labelled as source material (§8.4). It is composed at send time by `src/chat/project.ts` rather than merged into `conversations.system_prompt`, so a user editing a conversation prompt never sees text they did not write, and changing the project's instructions immediately affects every conversation in it rather than only the ones created afterwards.

### 4.11 Files the model writes — the tier with no table

A file a tool produced (`write_file`, `write_pdf`, `write_document`) is **not in the database**. It goes to the app's own document directory under a sanitised name, and a message block references it by that name. `src/chat/files.ts` is the only module that writes there, and the only place a copy leaves the sandbox — through the system folder picker, with the share sheet as the fallback.

Three reasons this is not a table:

- A `.docx` or a PDF is bytes with a filename. A row holding the same bytes would double the storage and give two answers to "what is the file".
- The database is encrypted and the document directory is not, which is the right way round: an exported PDF the user wants to open in another app cannot be inside SQLCipher.
- Nothing queries them. The only lookup is "the file this block names", which the filesystem already answers.

The cost is that these files have **no cascade**: deleting the conversation that produced a file leaves the file on disk. That is deliberate — the same reasoning as `usage_events` (§5.2) — but it means the document directory grows monotonically until the user clears app storage, and there is no in-app "delete generated files" affordance. Recorded in [flaws.md](flaws.md) rather than hidden.

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
| One row per remembered statement | `UNIQUE (kind, text)` + UPSERT | the same sentence twice in every prompt, forever |
| No memory contains a secret | `isSafeToRemember()` at the write boundary; no DB constraint | a pasted token written to the database and replayed into every request |
| No unreviewed memory reaches a prompt | `approved` column, checked in the prompt builder | model-authored text becomes persistent cross-conversation prompt injection |
| Hidden variants exist only for the last turn | *convention only* — enforced by `regenerate()` and dropped by the next send | a mid-transcript hidden row would be invisible and unreachable, and would still be paid for on replay if any path forgot the filter |
| One `mcp_servers` / `skills` row per name | `UNIQUE` index on `name` | an enabled toggle in `config` becomes ambiguous |
| `role` in {user, assistant, system} | TypeScript at the boundary; no CHECK constraint | render fallback, replay rejected by the gateway |

The four "convention only" rows are honest gaps. `seq` has no `UNIQUE (conversation_id, seq)` index because forking deliberately reuses source `seq` values in a *different* conversation (which the composite index would allow) and because a unique constraint would turn a benign collision into a lost message. The `text`/`content` pairing is enforced by there being exactly one insert path — `insertMessage()` — and by tests, not by the database. If a second write path ever appears, add a generated column or a trigger; do not rely on two call sites remembering.

### 5.2 Deliberately *un*enforced references

Six references are stored without a foreign key. Each is a decision, not an omission.

**`usage_events.conversation_id`** — deleting a conversation must not erase what it cost. Spend history is an accounting record; the user deleting a chat is deleting content, not asking to be told they spent less money this month. Consumers must tolerate a dangling `conversation_id` and render "(deleted conversation)".

**`conversations.forked_from_id` / `forked_from_message_id`** — a fork is an independent conversation that happens to remember its origin. A CASCADE here would delete a user's *new* work because they tidied up the old thread, which is indefensible. Reads must handle "parent no longer exists" by dropping the provenance affordance.

**`conversations.profile_id`** — cross-tier (§3.1), so SQLite cannot enforce it even if we wanted it to.

**`memories.source_conversation_id`** — a memory outliving the conversation that revealed it is the entire point of the feature. `ON DELETE CASCADE` here would mean that clearing history silently rewrites what the app knows about the user, which is both surprising and unauditable: the memory screen would lose rows the user never asked it to lose. Consumers must tolerate a dangling id.

**`config.skills` / `config.servers` → `skills.name` / `mcp_servers.name`** — a conversation names the skills and servers it has switched on, and it names them by *name* rather than by id (§4.7). A foreign key would need a join table per conversation and would still be wrong: deleting a skill should not silently rewrite the settings of every conversation that used it. An enabled name that stops resolving is simply skipped when the request is built, and the settings screen shows it as unavailable.

**A message block's filename → the document directory** — a generated file has no row (§4.11), so nothing can cascade to it. Deleting the conversation leaves the file.

`project_id` is the one reference here that *is* enforced, and it is enforced twice — see §3.1.

### 5.3 The blast radius of a bulk delete

Selecting fifty conversations and confirming is the most destructive thing this app can do, and what it destroys is decided by the schema rather than by the statement. `DELETE FROM conversations WHERE id IN (…)` is three sentences long; what follows from it is:

| Row type | Fate | Mechanism |
|---|---|---|
| `messages` (including `hidden` variants) | deleted | FK `ON DELETE CASCADE` |
| `conversation_tags` | deleted | FK `ON DELETE CASCADE` |
| `messages_fts` entries | deleted | `AFTER DELETE` trigger on `messages`, firing on the *cascaded* rows |
| `usage_events` | **kept** | no FK — deliberately (§5.2) |
| `memories` | **kept** | no FK — deliberately (§5.2) |
| forks of a deleted conversation | kept, provenance dangles | no FK — deliberately (§5.2) |
| the `projects` row a conversation belonged to | **kept** | the reference points the other way; a project is not deleted by emptying it |
| files the model wrote in those conversations | **kept on disk** | no row to cascade from (§4.11) |

Three properties follow, all of them asserted in `src/db/__tests__/bulk.test.ts` against a real SQLite database built from the shipped DDL:

1. **The pragma is load-bearing.** With `PRAGMA foreign_keys = OFF` — SQLite's default, per connection — the `ON DELETE CASCADE` clauses parse and are then ignored, leaving orphan messages and an FTS index full of hits pointing at conversations that no longer exist. The test sets the pragma explicitly for exactly this reason: without it, every assertion about cascading would pass for the wrong reason.
2. **It is one transaction or nothing.** `deleteConversations()` wraps the whole selection in a single `withTransactionAsync`, chunked at `BULK_CHUNK = 400` ids per statement to stay under `SQLITE_MAX_VARIABLE_NUMBER` (999 on older builds, and callers bind parameters of their own alongside the id list). This is a correctness requirement, not a performance one: a partial delete has no undo and no way for the user to say which half went. The test proves the rollback, not just the commit.
3. **Counts are what happened.** Every bulk statement returns SQLite's own `changes`, and every confirmation reports that rather than the size of the selection — `setArchivedSql` carries `WHERE archived <> ?` so the number means "rows that moved", and `addTagSql` inserts `SELECT … FROM conversations`, so an id that has since been deleted elsewhere contributes no row instead of tripping the foreign key and taking the transaction with it.

The SQL itself lives in `src/db/bulk.ts` as pure builders with no `expo-sqlite` import, for the same reason `ddl.ts` does: the test exercises the statements that ship, not a copy of them.

---

## 6. Normalisation, then deliberate denormalisation

The schema was designed by normalising properly and then breaking normal form in four named places for reasons that were measured, not assumed. Both halves matter: an un-normalised schema rots, and a purely normalised one makes the conversation list stutter.

### 6.1 First normal form

1NF requires atomic column values — no repeating groups, no lists in a cell.

`conversation_tags` is the test case. The tempting shape is `conversations.tags TEXT` holding `"work,ai,draft"`. That fails 1NF and immediately costs you: filtering by tag becomes `LIKE '%work%'` (which matches `homework`), tag counts require parsing every row in JS, and renaming a tag becomes a string rewrite across the table. The normalised `conversation_tags(conversation_id, tag)` join table gives an indexed equality predicate and `GROUP BY tag` counts.

**`messages.content` looks like a 1NF violation and is not.** It is a JSON array of content blocks. The distinction is whether the app ever queries *inside* it. It does not: blocks are read, rendered and replayed as an ordered whole, never selected or filtered by SQL. A `message_blocks` table would add a join to every read, force block ordering into another `seq` column, and buy nothing — nothing asks "find me all `tool_use` blocks named X". `content` is therefore a single atomic value at the granularity the application actually uses. See §8 for the schema that governs it.

The same argument covers the seven JSON columns on `mcp_servers` and `projects.knowledge`: they are configuration and caches read whole, never filtered by SQL.

### 6.2 Second normal form

2NF requires non-key attributes to depend on the *whole* key. Only `conversation_tags` has a composite key, and it has no non-key attributes at all, so 2NF holds trivially. This is a consequence of using surrogate `TEXT` ids everywhere else — `newId()` values, generated locally with no coordination — rather than natural composite keys. On a device with no server, locally generated ids are the only option that survives an offline write, so 2NF comes free.

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

**Search.** FTS5 indexes a column, not an expression. To full-text search message bodies you need a plain text column. Indexing `content` directly would index JSON syntax — a search for `"type"` would hit every message ever sent, and a search for `image` would hit every attachment's block tag. Worse, base64 image payloads live in `content`; indexing them would inflate the FTS index by megabytes per photo for zero retrieval value. `flattenContent()` never emits base64 — an image contributes the four-character marker `[image]` and nothing else — so the index contains prose plus a handful of short tags and no payloads.

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

Thirteen columns hold JSON: `messages.content`, `messages.usage`, `messages.meta`, `conversations.config`, `projects.knowledge`, and seven on `mcp_servers` (§4.8). Each has a TypeScript type that is the normative definition; the JSON Schema fragments below are for validators and for readers who do not want to open the source. The five documented in detail here are the ones a feature is likely to extend; the `mcp_servers` columns are discovery caches and per-tool decisions, described where they are declared.

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
interface ToolUseBlock   { type: 'tool_use'; id: string; name: string; input: unknown }
interface ToolResultBlock{ type: 'tool_result'; toolUseId: string;
                           content: string;     // rendered text; structured results
                                                // are JSON-stringified by the caller
                           images?: { mediaType: string; data: string }[];
                           isError?: boolean }
```

**`tool_result.content` is a string, not a block list.** That is worth stating because the obvious design is recursion — a result carries blocks, which carry blocks. It does not, and the flatter shape is why `flattenContent()` (§8.3) is a single `switch` with no recursive call and why the exporters never have to guard against depth. A tool returning structured data is JSON-stringified by its caller before it becomes a block.

Images a tool returned ride in `images`, separately from the text, and are **set only when the model can actually see them**: a transport that cannot carry an image inside a tool result drops the array and sends the text, which already says an image was returned. A screenshot tool whose picture is silently thrown away is a tool the model will keep calling and keep learning nothing from.

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
      { "type": "object", "required": ["type", "id", "name", "input"],
        "properties": { "type": { "const": "tool_use" }, "id": { "type": "string" },
                        "name": { "type": "string" }, "input": true },
        "additionalProperties": false },
      { "type": "object", "required": ["type", "toolUseId", "content"],
        "properties": { "type": { "const": "tool_result" },
                        "toolUseId": { "type": "string" },
                        "content": { "type": "string" },
                        "images": { "type": "array", "items": {
                          "type": "object", "required": ["mediaType", "data"],
                          "properties": { "mediaType": { "type": "string" },
                                          "data": { "type": "string",
                                                    "contentEncoding": "base64" } },
                          "additionalProperties": false } },
                        "isError": { "type": "boolean" } },
        "additionalProperties": false }
    ]
  }
}
```

**What is *not* a block type, and where it lives instead.** A v1.1 reply can render a chart, a LaTeX formula, terminal output, a table, an artifact preview and a generated file, and none of those added a seventh block type. They are all Markdown inside a `TextBlock` — a fenced ```chart` block, `$$…$$`, a fenced language — parsed by `src/components/markdown/` at render time. A file the model wrote is named in the tool result that wrote it and lives on disk (§4.11). This is deliberate: a new renderer must never require a migration, because a migration is the one part of this schema that cannot be rolled back (§10.1, [07_Deployment.md](07_Deployment.md) §10.4). If a rendering feature seems to need a block type, it almost certainly needs a fence instead.

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
// Conceptual shape; source of truth is src/db/content.ts
function flattenContent(blocks: ContentBlock[]): string {
  // text        → the text
  // document    → the file name, then the extracted text if there is any. Name
  //               first and name always, so a search for `invoice-2026.pdf`
  //               finds the message even when the bytes could not be read
  // thinking    → EXCLUDED: reasoning is not the answer, and indexing it makes
  //               every search hit the model's musings instead of its reply
  // tool_use    → `[tool <name>]`: the name is findable, the JSON arguments
  //               would be noise in a prose index
  // tool_result → its content text (a string, so no recursion)
  // image       → `[image]`: a marker, never the base64, so a conversation can
  //               be found by the fact that it had one without bloating the index
}
```

**If you add a seventh block type, you must decide its flattening in the same commit.** The default of "not included" is a search bug that will not surface until a user cannot find something they can see on screen. Note that `flattenContent()`'s `switch` is exhaustive over the union with no `default` — TypeScript's `strict` mode plus `noFallthroughCasesInSwitch` therefore makes adding a block type a *compile* error here, which is the intent.

**One projection has a second, narrower reader.** `isToolTurn()` in the same module is true for the synthetic `user` message that carries nothing but tool results. A skill body comes back as a `tool_result`, and flattening a result into `messages.text` is right for search and wrong for the conversation list, where it would replace the preview with the first line of an instruction file the user never wrote. Three call sites need the same answer — the insert (which passes `''` to skip the preview update), the store's optimistic patch, and the transcript, which renders these turns as tool output rather than as something the user said — so it is one predicate, not three conditions.

**Where it lives.** The three projection functions — `flattenContent()`, `previewOf()` and `DEFAULT_TITLE` — moved to `src/db/content.ts` in Phase 3. `conversations.ts` re-exports all three, so no caller changed. The reason for the split is testability: `conversations.ts` imports `expo-sqlite` at module scope, which makes everything in it unreachable from Jest's node environment, and this contract has four independent readers (FTS index, list preview, derived title, memory extractor), so a block kind flattened wrongly is wrong in four places silently. It is now covered by `src/db/content.test.ts`, including an assertion that base64 never reaches the index.

### 8.4 `conversations.config` — `ConversationConfig`

```ts
interface ConversationConfig {
  params?: Partial<SamplingParams>;
  reasoning?: ReasoningConfig;
  /** Skill NAMES, not ids — the model types one back as a tool argument. */
  skills?: string[];
  /** MCP server NAMES, same reasoning. */
  servers?: string[];
  contextStrategy?: 'warn' | 'drop_oldest' | 'summarise';
  summary?: { throughSeq: number; text: string };
  /** Remembered expand/collapse choice for the reasoning pane. */
  showThinking?: boolean;
  /** Propose before acting: tools that would change something are refused. */
  planMode?: boolean;
  /** Opt this conversation out of long-term memory. Only `false` does anything. */
  memory?: boolean;
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

**There is no `systemPrompt` here** — that is a column on `conversations` (§4.1). The two are composed at send time, not merged at rest: `src/chat/project.ts` prepends the project's `instructions` and knowledge documents above the conversation's own prompt, fenced and labelled as source material. Keeping the composition in the send path means a user editing their prompt never sees text they did not write, and editing a project's instructions takes effect on every conversation in it immediately.

`summary.throughSeq` is the load-bearing field of the `summarise` context strategy: it records the `seq` up to which the rolling summary already covers the transcript, so the next request replaces exactly that prefix and nothing is either double-counted or silently dropped. It is a `seq`, not a message id, precisely because §7.2 guarantees `seq` is comparable with `<=` while ids are not.

Three fields are worth reading twice because they mean less than they look like they mean:

- **`skills` and `servers` hold names**, so they are soft references into two other tables (§5.2). A renamed skill silently drops out of the conversations that had it enabled; that is the accepted cost of a value the model has to be able to type.
- **`planMode` is per-conversation, not global**, because it is a property of the task rather than of the user: the chat where a model is rewriting files wants it on, and the one answering questions has nothing to gate. It is enforced in the tool router, not in the system prompt — a writing built-in must be listed in `WRITING_BUILTINS` or plan mode will let it through ([TRD.md](TRD.md) §4).
- **`memory: false` is the only value that does anything.** Absent and `true` both defer to the global `settings.memoryEnabled`, so a conversation can opt *out* of long-term memory but cannot switch it on when the user has switched it off globally. See `memoryAppliesTo` in `src/chat/memory.ts`.

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
| `tool_result` | `{"type":"tool_result","toolUseId":"…","content":"…","isError":true}` | `{type:'tool_result', tool_use_id, content, is_error}` | a separate message: `{role:'tool', tool_call_id, content}` |
| `tool_result` images | `…,"images":[{"mediaType":"image/png","data":"<b64>"}]` | appended as image blocks inside `content` | **dropped** — the text already says an image was returned |

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

### 9.1 The export projection — a third destination, and a lossy one on purpose

`src/chat/export.ts` is the only other consumer of stored `ContentBlock[]`, and unlike the two adapters it is allowed to lose information, because its output leaves the device for a human rather than for a model.

| Block | Markdown | JSON export |
|---|---|---|
| `text` | the text, redacted | `{type, text}` |
| `thinking` | blockquoted under **Thinking**, only with `includeThinking` | omitted entirely unless `includeThinking`; `signature` never written |
| `image` | `[image: image/png, ~340 kB — not included in this export]` | `{type, mediaType, bytes, included: false}` — **no `data`** |
| `document` with `text` | the descriptor, then the extracted text | `{type, mediaType, name, text}` |
| `document` with `data` | descriptor only | `{type, mediaType, name, bytes, included: false}` — **no `data`** |
| `tool_use` | fenced JSON of the arguments | `{type, id, name, input}` with every nested string redacted |
| `tool_result` | fenced text, `(error)` when `isError` | `{type, toolUseId, content, isError?}` |

Three rules the module encodes, all of them properties of the *data* rather than of the presentation:

1. **Base64 never leaves in an export.** `bytes` is derived from the stored base64 length (`length × 3 / 4`) so the record of the attachment survives without its contents. A transcript that silently contains every photo the user ever attached is a different artefact from the one they asked for, and a 3 MB photo becomes 4 MB of unreadable text in the middle of a document.
2. **`signature` is never exported.** It is replay credentials for one provider's thinking block — meaningless outside the conversation, and confusing inside a file a person reads.
3. **Every string is redacted twice.** Once as it is written and once over the finished artefact. The second pass is a net under the first, because the failure mode is a field somebody adds to the exporter later without it — which produces a leak, not a compile error. `src/chat/export.test.ts` greps the finished artefact for a planted key rather than checking a call site, so that omission fails a test. It is safe to run over serialised JSON because `[REDACTED]` contains no character JSON escapes.

Tool-call arguments get a value-only deep walk rather than `redact()` from `@/lib/redact`: that function also blanks secret-*named* keys, which would silently drop a legitimate `token` argument and make the export a misleading record of what was actually sent. Structure is preserved; values are scrubbed.

The JSON envelope carries `schemaVersion` (`EXPORT_SCHEMA_VERSION`, currently 1) so a future importer can refuse a file it does not understand rather than guessing. It is independent of `PRAGMA user_version`: the storage schema can change without changing the export shape, and vice versa.

---

## 10. Migration strategy

### 10.1 Numbered migrations — `PRAGMA user_version`

```
┌──────────────────────────────────────────────────────────────────┐
│  open()                                                          │
│    1. PRAGMA journal_mode = WAL                                  │
│    2. PRAGMA foreign_keys = ON        ← per connection, always    │
│    3. read PRAGMA user_version → v                               │
│    4. for version v .. SCHEMA_VERSION - 1:                        │
│         withTransaction(exec MIGRATIONS[version])                │
│         PRAGMA user_version = version + 1   ← see the note below  │
│    5. ensureFts()   ← outside the numbered chain, idempotent      │
│    6. FTS integrity-check → rebuild if it disagrees               │
└──────────────────────────────────────────────────────────────────┘
```

`MIGRATIONS` is an **array of SQL strings** in `src/db/ddl.ts`, indexed by the version it upgrades *from*: `MIGRATIONS[0]` creates the baseline schema, `MIGRATIONS[1]` is 1 → 2, and so on up to `MIGRATIONS[7]`, which is 7 → 8. `SCHEMA_VERSION` is therefore `MIGRATIONS.length` — **currently 8** — and a test asserts it. The DDL lives in its own module with no `expo-sqlite` import so the real schema can be built under `node:sqlite` in Jest — every migration test in `src/db/__tests__/` runs the SQL that actually ships, not a copy of it.

**The version bump is outside the migration's transaction**, which is a deliberate deviation from the rule below and the reason every statement in a migration is written `IF NOT EXISTS`. The alternative — `PRAGMA user_version` inside `withTransactionAsync` — is not available through the `expo-sqlite` async transaction wrapper. So the recovery story is idempotency instead of atomicity: a process killed between the commit and the bump re-runs a migration that has already applied, and each one is written to survive that. `src/db/__tests__/memories.test.ts` asserts it for the current step; do the same for the next one.

Rules for adding a migration:

- **Append only.** Never edit a shipped migration; a device that already ran it will not run it again, so an edit produces two different schemas both claiming the same `user_version`.
- **Write every statement idempotently** — `IF NOT EXISTS`, `DROP … IF EXISTS` — for the reason above, and add a test that re-running the step does not throw.
- **Additive first.** `ALTER TABLE … ADD COLUMN` with a `DEFAULT` is cheap and safe. SQLite cannot drop or retype a column in place; that needs the 12-step table rebuild (`CREATE new; INSERT … SELECT; DROP old; RENAME`), which on a large `messages` table means copying every base64 attachment. Budget for it or avoid needing it.
- **Never migrate the FTS table in the numbered chain.** It may not exist (§4.5). `ensureFts()` owns it.
- **Rebuild FTS after any migration that rewrites `messages`.** A table rebuild changes rowids; see §12.1.
- **Answer the rollback question in writing.** Can the *previous* app version open the database after this step? An added column with a default: yes, it is ignored. Anything else: say so in the release notes, because there is no `down` path ([07_Deployment.md](07_Deployment.md) §10.4).

The eight migrations shipped so far, and what each is an example of:

```ts
export const MIGRATIONS = [
  /* 0 → 1 */ `/* … the Phase 1 baseline schema: conversations, conversation_tags,
                    messages, usage_events, and their indexes … */`,

  /* 1 → 2 */ `
    -- Replacing an index in place. The list has always been "unarchived,
    -- pinned first, newest first", but the old index started at \`pinned\`, so
    -- every query tested \`archived\` row by row and sorted the survivors in a
    -- TEMP B-TREE. Leading with \`archived\` makes that an equality constraint,
    -- and carrying \`id\` lets the index spell out the whole ORDER BY — which is
    -- what turns keyset paging into a range seek. Debt D-02.
    DROP INDEX IF EXISTS conversations_order;
    CREATE INDEX IF NOT EXISTS conversations_list
      ON conversations (archived, pinned DESC, updated_at DESC, id DESC);
  `,

  /* 2 → 3 */ `
    -- Adding a table (§4.6). No existing table is touched, so there is no FTS
    -- impact and nothing to copy: the cheapest shape a migration can have.
    CREATE TABLE IF NOT EXISTS memories ( /* … */ );
    CREATE UNIQUE INDEX IF NOT EXISTS memories_unique ON memories (kind, text);
    CREATE INDEX IF NOT EXISTS memories_rank ON memories (pinned DESC, hits DESC, updated_at DESC);
  `,

  /* 3 → 4 */ `
    -- A table whose UNIQUE index carries a product decision: \`skills.name\` is
    -- unique because a conversation enables a skill by name (§4.7).
    CREATE TABLE IF NOT EXISTS skills ( /* … */ );
    CREATE UNIQUE INDEX IF NOT EXISTS skills_name ON skills (name);
  `,

  /* 4 → 5 */ `
    -- Two tables in one step, because a migration is a migration and both are
    -- small user-authored tables. Note what mcp_servers does NOT have: a token
    -- column (§4.8).
    CREATE TABLE IF NOT EXISTS mcp_servers ( /* … */ );
    CREATE UNIQUE INDEX IF NOT EXISTS mcp_servers_name ON mcp_servers (name);
    CREATE TABLE IF NOT EXISTS prompts ( /* … */ );
    CREATE INDEX IF NOT EXISTS prompts_rank ON prompts (uses DESC, updated_at DESC);
  `,

  /* 5 → 6 */ `
    -- A security fix shaped as one column, and the clearest example of why a
    -- default is a decision: DEFAULT 1 keeps existing rows in use, because they
    -- were learned under the old contract and are already visible (§4.6).
    ALTER TABLE memories ADD COLUMN approved INTEGER NOT NULL DEFAULT 1;
  `,

  /* 6 → 7 */ `
    -- A table plus a foreign key onto an existing one. SET NULL rather than
    -- CASCADE: deleting a project must not delete the conversations in it.
    CREATE TABLE IF NOT EXISTS projects ( /* … */ );
    ALTER TABLE conversations
      ADD COLUMN project_id TEXT REFERENCES projects (id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS conversations_project
      ON conversations (project_id, updated_at DESC, id DESC);
  `,

  /* 7 → 8 */ `
    -- Three columns instead of the parent-pointer tree this would be if the app
    -- branched everywhere (§4.2). Every existing row keeps NULL/NULL/0, which
    -- reads as "a turn of its own, with no siblings" — nothing to rewrite.
    ALTER TABLE messages ADD COLUMN turn_id TEXT;
    ALTER TABLE messages ADD COLUMN answers_id TEXT;
    ALTER TABLE messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS messages_variants
      ON messages (conversation_id, answers_id, turn_id);
  `,
];
```

**All eight are rollback-safe**, and not by luck: six add tables or indexes, two add defaulted columns, and none rewrites or retypes an existing one. A previous binary opening a `user_version = 8` database sees columns it ignores and works. That property is what keeps [07_Deployment.md](07_Deployment.md)'s Path A1 available, and it is worth preserving deliberately rather than discovering it has been lost during an incident.

An index-only migration like 1 → 2 is worth a planner test rather than a schema test: the point of the change is the query plan, and only `EXPLAIN QUERY PLAN` can tell you whether you got it. `src/db/__tests__/list-query.test.ts` asserts `SEARCH … USING INDEX conversations_list` and the absence of `TEMP B-TREE` over 500 seeded rows, which is the difference between the index existing and the index being used.

### 10.2 How `config` evolves *without* a migration

`conversations.config` is a JSON document with every field optional. Adding a setting is therefore not a schema change:

```
Version A writes:  {"reasoning":"extended"}
Version B adds `contextStrategy` and reads:
    config.contextStrategy ?? DEFAULT_STRATEGY    → 'warn'
Version B writes:  {"reasoning":"extended","contextStrategy":"summarise"}
Version A reads it back: parses fine, ignores the unknown key, still works.
```

That is how `contextStrategy`, `summary`, `skills`, `servers`, `planMode` and `memory` were all added — six settings, no migrations. It is the reason `SCHEMA_VERSION` is 8 rather than 14.

Two invariants make this safe, and both are requirements on *code*, not on the database:

1. **Every reader supplies a default.** No code path may assume a field is present. `config` may legitimately be `NULL`, `'{}'`, or a document written by any past version.
2. **Every writer merges, never replaces.** Updating one setting must be `{...parsed, contextStrategy: next}`. A writer that constructs a fresh object silently deletes fields it does not know about — which is how a downgrade-then-upgrade loses a user's skill selection.

**When JSON is the wrong answer.** Promote a field out of `config` into a real column when any of these becomes true:

| Signal | Why JSON fails | Example |
|---|---|---|
| You need to filter or sort by it | `json_extract` in a `WHERE` cannot use a normal index | "show conversations using extended thinking" |
| It must be `NOT NULL` | JSON cannot express required-ness | nothing today |
| It is written on a hot path | rewriting the whole document per keystroke | streaming state (which is why it is in Zustand, not here) |
| Two writers race on different fields | last-write-wins clobbers the other field | not currently possible — single writer |
| A screen edits it directly and alone | read-modify-write of the whole document to change one string | `system_prompt`, which is a column for exactly this reason (§8.4) |

The first row has an escape hatch worth knowing: SQLite supports indexes on expressions, so `CREATE INDEX ON conversations (json_extract(config, '$.contextStrategy'))` is legal and would make one such filter fast without a migration of the data. Reach for it before reshaping a table.

### 10.3 Migrating the AsyncStorage tier

Zustand's `persist` middleware has its own version counter, entirely separate from `PRAGMA user_version`. All four persisted stores share one factory, `persistConfig()` in `src/lib/storage.ts`:

```ts
// src/lib/storage.ts — the shared defaults
export function persistConfig<T>(name: string, options: Partial<PersistOptions<T, unknown>> = {}) {
  return {
    name,                        // 'providers' | 'models' | 'settings' | 'token-calibration'
    storage: jsonStorage,        // createJSONStorage(() => AsyncStorage)
    version: 1,                  // every store is still on 1 — no shape change has shipped yet
    onRehydrateStorage: () => (_state, error) => { /* log, then markHydrated(name) */ },
    ...options,                  // callers supply partialize, and would supply migrate
  };
}

// src/stores/settings.ts — the caller
persist(creator, persistConfig<SettingsState>('settings', {
  // Only persist data, never the actions.
  partialize: (state) => Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, state[k]])),
}))
```

**No store has needed a `migrate` yet**, which is why none defines one. `version: 1` is set anyway so that the first shape change can add one; without a version, `persist` has no way to tell an old blob from a new one and the only safe reaction is to discard it. The store names are bare (`'settings'`, not `'agentrouter.settings'`) — worth knowing before writing an AsyncStorage key by hand, and the reason `readJson`/`writeJson` callers should stay clear of those four names.

Each store's `partialize` is also what registers it for the startup hydration gate: `expectHydration(STORE_NAME)` runs at module load, `onRehydrateStorage` calls `markHydrated`, and `useHydrated()` blocks the first render until the two sets match or three seconds pass (§12.4).

The `partialize` function is a security control as much as a size control: anything it returns is written to plaintext AsyncStorage. Review every addition to it with that framing. `useMcp` is the store that shows the rule being applied rather than described — it is **not** persisted at all, because a server row's `headers` may carry a bearer token (§4.8).

**Two version numbers is the right design**, even though it is two things to remember. The tiers fail independently — a corrupt AsyncStorage blob should not prevent conversations from loading, and a failed SQL migration should not lose the user's provider profiles. Coupling them into one number would make either failure fatal to both.

---

## 11. Index strategy

### 11.1 The indexes, and the query each one exists for

| Index | Definition | Serves | Access path |
|---|---|---|---|
| implicit PK | `conversations(id)` | open a conversation | rowid lookup |
| `conversations_list` | `(archived, pinned DESC, updated_at DESC, id DESC)` | conversation list: filter, order and keyset page | index range scan, no sort |
| `conversations_profile` | `(profile_id)` | "which conversations used this profile" before deleting one | index scan → PK join |
| `conversations_project` | `(project_id, updated_at DESC, id DESC)` | one project's conversations, newest first (§4.10) | index range scan, no sort |
| implicit PK | `messages(id)` | update/delete one message | rowid lookup |
| `messages_conversation` | `(conversation_id, seq)` | load a transcript in order | range scan, no sort |
| `messages_variants` | `(conversation_id, answers_id, turn_id)` | siblings of a regenerated reply (§4.2) | range scan |
| `conversation_tags` PK | `(conversation_id, tag)` | tags for one conversation; idempotent insert | range scan |
| `conversation_tags_tag` | `(tag)` | filter conversations by a tag chip | index scan → PK join |
| `usage_events_day` | `(day)` | daily/period spend report | range scan |
| `usage_events_model` | `(model)` | per-model breakdown | index scan |
| `memories_unique` | UNIQUE `(kind, text)` | dedupe on write — the constraint *is* the feature (§4.6) | uniqueness check |
| `memories_rank` | `(pinned DESC, hits DESC, updated_at DESC)` | pick the memories to inject into a prompt | index range scan, no sort |
| `skills_name` | UNIQUE `(name)` | resolve `invoke_skill`'s argument; reject a duplicate slug (§4.7) | uniqueness check |
| `mcp_servers_name` | UNIQUE `(name)` | resolve `config.servers` entries (§4.8) | uniqueness check |
| `prompts_rank` | `(uses DESC, updated_at DESC)` | most-used prompts first in the picker (§4.9) | index range scan, no sort |
| `messages_fts` | FTS5 inverted index | full-text search of message bodies | `MATCH` |

Three tables carry no secondary index at all: `projects`, and `skills`/`mcp_servers`/`prompts` beyond their name indexes. All four are user-authored and small — tens of rows, not thousands — so a scan is cheaper than the writes an index would cost. Add one when a user has enough rows for it to matter, not before.

### 11.2 The reasoning, not just the list

`messages_conversation (conversation_id, seq)` is the most important index in the schema and it is a **covering-order** index: the leading column is the equality predicate, the second is the sort key. That combination lets SQLite satisfy `WHERE conversation_id = ? ORDER BY seq` by walking the index in order, with no temporary B-tree and no sort step. Reverse it to `(seq, conversation_id)` and every transcript load becomes a full scan plus a sort. The column order *is* the optimisation.

`conversation_tags_tag` exists because the tag filter arrives from a chip the user tapped, so it is an exact-equality lookup over a low-cardinality column — precisely the case where a secondary index pays for itself, since without it filtering by tag scans the whole join table.

The two UNIQUE indexes on `skills_name` and `mcp_servers_name` are **constraints first and indexes second**. Their job is to make a duplicate name impossible at the storage layer, because a duplicate is not a slow query but a wrong answer: two skills named `research` mean `invoke_skill({name:'research'})` is ambiguous, and two servers named `github` mean `config.servers` resolves to whichever row came back first. `memories_unique` is the same idea used for dedupe rather than for identity.

No index on `messages.created_at`. Nothing queries by it (§7.5), and an unused index is pure write amplification: every insert maintains it, no read benefits. The same argument applies to `messages.hidden`: it is a filter on an already-narrow result set (one conversation's transcript), so it costs a boolean test per row that has already been read.


### 11.3 The index gap, and how it was closed

`listConversationPage()` filters on `archived` and orders by `(pinned, updated_at, id)`:

```sql
SELECT … FROM conversations c WHERE c.archived = ?
ORDER BY c.pinned DESC, c.updated_at DESC, c.id DESC
```

The original `conversations_order (pinned DESC, updated_at DESC)` could serve the ordering but not the predicate, so SQLite scanned and filtered every row — work proportional to *all* conversations rather than to the unarchived ones — and could not spell out the tiebreaker on `id` either.

Migration 1 → 2 drops it and creates `conversations_list (archived, pinned DESC, updated_at DESC, id DESC)`. Leading with `archived` turns the filter into an equality constraint; carrying `id` lets the index express the whole `ORDER BY`, which is what removes the `TEMP B-TREE` and makes the keyset cursor `(pinned, updated_at, id) < (?, ?, ?)` an index range constraint rather than a filter.

Asserted rather than assumed: `src/db/__tests__/list-query.test.ts` runs the shipped SQL against real SQLite over 500 seeded conversations with deliberate `updated_at` ties and requires `SEARCH … USING INDEX conversations_list`, no `TEMP B-TREE`, no `OFFSET`, and that paging visits every row exactly once across the ties.

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

### 12.2 In-memory preview drifts from the stored preview — **fixed**

`appendToTranscript()` used to set the in-memory conversation's `preview` to the message's **full flattened text**, while `touchConversation()` wrote `previewOf(text)` to the row — the first non-empty line, truncated to 160 characters. Until the next reload, the store and the database disagreed.

The visible symptom was subtle: a conversation whose reply begins with a fenced code block or a heading showed a different preview immediately after the turn than it did after a restart. The fix was the one line predicted here — the store now calls `previewOf()` too (`src/stores/chat.ts`) — and it landed in the Phase 2 list work as debt item D-04.

### 12.3 A mid-stream process death loses the partial reply

A message row is written only on a terminal path (`message_stop`, error, or abort). If Android kills the process while a stream is in flight — background eviction, OOM, force-stop — the accumulated blocks were only ever in the `useChat` store and are gone. The conversation reloads with the user's message and no reply.

This is a deliberate simplification: incrementally persisting a streaming message means an `UPDATE` per 60 ms publish tick, which multiplies write volume by roughly the number of chunks and drags the FTS triggers along for each one. The alternative, if the loss ever proves unacceptable, is a single-row scratch table (`streaming_partial`) written on the same throttle and promoted or discarded on the terminal event — one row rewritten in place, no FTS involvement. Costed in [06_Eng_Plan.md](06_Eng_Plan.md).

### 12.4 Hydration can race a write

`useHydrated()` waits for the persisted stores with a 3-second timeout, after which the app renders with defaults. If a store writes during that window, defaults can be persisted over stored values. The only mitigation in place is the convention that stores persist on explicit user changes rather than on mount. Any new store action that writes automatically at startup must first check hydration.

The timeout now logs which stores it gave up on, so "my provider profile is gone" is diagnosable from Settings → Debug rather than indistinguishable from data loss. That is a diagnostic, not a fix: the race is still open by design, because the alternative is an app that never paints.

### 12.5 The document directory has no owner, and nothing cascades to it

Files the model writes are the one tier with no table (§4.11). `ON DELETE CASCADE` reaches every row that references a conversation and no byte on disk. Delete a conversation whose transcript produced three spreadsheets and the three files remain, reachable through Files but no longer through anything that explains where they came from.

This is deliberate — a file the user has already opened, shared or printed should not vanish because they tidied a chat — but it makes two things true that are easy to forget:

1. **Storage growth is unbounded and invisible to every count in this document.** The row-count drift check, the conversation list's `message_count`, `VACUUM`: none of them see the document directory.
2. **A filename in a message is a dangling reference by design** (§5.2). Code that renders one must handle "the file is gone" as an ordinary outcome, because the user can delete it from Files without the app ever knowing.

If a "storage used" screen or a cleanup action is ever added, it needs its own directory walk. There is no query that will answer it.

### 12.6 A project's `knowledge` is extracted text, not the file

`projects.knowledge` stores the text pulled out of an attached document, not its bytes (§4.10). The original is not kept, so a project document cannot be re-downloaded, re-extracted at a higher fidelity, or re-shared — and re-attaching is the only repair.

The hazard is a plausible future feature: "show me the source document for this project fact" cannot be built on this schema without a migration that adds a blob or a path. Say so before promising it.

### 12.7 Encryption trades recoverable data for unrecoverable data, and the mitigation is that nothing is backed up

`unlock()` in `src/db/schema.ts` opens the file with a raw key held in the Android Keystore. A key that cannot be read back is not a degraded state — it is total loss of every conversation. That risk is bounded today by making the file and the key inseparable: `android.allowBackup` is false, and `plugins/with-no-backup.js` excludes the database from cloud backup and device transfer, so there is no path by which the file lands on a device whose Keystore never held its key. Uninstall clears both together.

The hazard is the next feature that breaks that pairing. Anything that copies the database off the device — cloud sync, an export-and-restore, a "move to new phone" flow, re-enabling `allowBackup` — must solve key transport in the same change, or it ships a restore that produces the "could not be decrypted" error and no data. There is no rekey-on-restore path in the current design, because there is no design for a database that travels.

The plaintext-to-encrypted conversion (`sqlcipher_export` into a fresh file, then a two-step file swap) runs once, for databases created before encryption shipped. It is not a general-purpose rekey and does not survive being run twice.

---

## 13. Synchronisation map: Zustand ↔ SQLite ↔ SecureStore

### 13.1 Ownership matrix

Three kinds of store, and the difference matters more than the individual rows: **persisted** stores own their state and write it to AsyncStorage; **SQLite-backed** stores are caches in front of a table and own nothing; **ephemeral** stores are process-lifetime only and are deliberately not persisted.

| State | Store | Kind | Owner of truth | Persisted where | Lifetime |
|---|---|---|---|---|---|
| Conversation list | `useChat.conversations` | SQLite-backed | SQLite | SQLite | until deleted |
| Transcript | `useChat.messages[convId]` | SQLite-backed | SQLite | SQLite | until deleted |
| Streaming partial | `useChat` | ephemeral | `useChat` | **nowhere** (§12.3) | until terminal event |
| Regeneration variants | `useChat` + `messages.hidden` | SQLite-backed | SQLite | SQLite | until the next send drops them (§4.2) |
| Context pressure / gauge | — | derived | recomputed | never | render |
| Memories | `useMemory` | SQLite-backed | SQLite | SQLite | until removed |
| Projects | `useProjects` | SQLite-backed | SQLite | SQLite | until deleted |
| Prompts | `usePrompts` | SQLite-backed | SQLite | SQLite | until deleted |
| Skills | `useSkills` | SQLite-backed | SQLite | SQLite | until deleted |
| MCP servers | `useMcp` | SQLite-backed | SQLite | SQLite (row) + SecureStore (credential) | until deleted |
| The connector directory | — | bundled constant | `src/mcp/catalog.ts` | **nowhere** — a frozen array in the JavaScript bundle, read to prefill a draft and never written to | for the life of the build |
| Provider profiles | `useProviders` | persisted | `useProviders` | AsyncStorage `providers` | until removed |
| Active profile id | `useProviders` | persisted | `useProviders` | AsyncStorage `providers` | until changed |
| API key | — | — | SecureStore | **SecureStore only**, cached in a module-scoped variable in `lib/secureKey.ts` | until changed |
| MCP credentials | — | — | SecureStore | **SecureStore only**, under `mcp.<id>` | until the server is deleted |
| Database key | — | — | SecureStore | **SecureStore only** (§12.7) | for the life of the install |
| Model catalogue | `useModels` | persisted | `useModels` | AsyncStorage `models` | until refreshed |
| Per-model overrides | `useModels` | persisted | `useModels` | AsyncStorage `models` | user-owned, never overwritten by discovery |
| Settings | `useSettings` | persisted | `useSettings` | AsyncStorage `settings` | until changed |
| Token calibration | `useCalibration` | persisted | `useCalibration` | AsyncStorage `token-calibration` | until reset |
| Usage events | — | — | SQLite | SQLite | forever (survives conversation delete) |
| Send queue | `useSendQueue` | ephemeral | `useSendQueue` | **never persisted** | process |
| Reachability | `useReachability` | ephemeral | `useReachability` | **never persisted** | process |
| Files the model wrote | — | — | the filesystem | document directory (§4.11) | until the user deletes them |
| Debug log | `src/lib/log.ts` ring buffer | ephemeral | ring buffer | **never persisted** | process |

Four rows are worth reading twice. `useMcp` is the only SQLite-backed store whose state is split across two tiers, and it is **not** `persist()`-wrapped precisely because a row's `headers` may carry a bearer token (§4.8). `useSendQueue` holds **conversation ids and nothing else** — the failed turn is already a row in `messages`, so the queue decides only when and in what order to retry, which is why losing it on process death costs a retry rather than a message. The database key row is the one whose loss is unrecoverable. And "files the model wrote" is owned by nothing in this table, which is the point of §12.5.


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
- **A `clear all data` action, when one is built, must clear all four tiers** — SQLite, AsyncStorage, SecureStore and the document directory (§2) — plus `clearRegisteredSecrets()`. There is no such action today: Settings offers backup and restore, and per-item deletion, but nothing that wipes. The rule is recorded here because the fourth tier is the one that will be forgotten — no query will show you what is still on disk (§12.5) — and because uninstalling is currently the only complete wipe.

---

## 14. Query cookbook

Real statements, in the shape the app issues them. Parameters are always bound — never interpolated — both for injection safety and so SQLite can reuse the prepared statement.

### 14.1 Conversation list with tags, message count and preview

Built by `buildListQuery()` in [src/db/list-query.ts](../src/db/list-query.ts:72), which exists as a pure string builder so a test can hand the shipped SQL to `EXPLAIN QUERY PLAN` (§11.3):

```sql
SELECT c.*,
       (SELECT group_concat(tag, char(1)) FROM conversation_tags WHERE conversation_id = c.id) AS tags,
       (SELECT count(*) FROM messages WHERE conversation_id = c.id AND hidden = 0) AS message_count
  FROM conversations c
 WHERE c.archived = ?
   AND (c.pinned, c.updated_at, c.id) < (?, ?, ?)   -- the keyset cursor, omitted on page 1
 ORDER BY c.pinned DESC, c.updated_at DESC, c.id DESC
 LIMIT ?;
```

Four decisions are visible in those eight lines:

- **`preview` comes from the column**, inside `c.*`, not from a join on `messages` — the denormalisation of §6.4 paying for itself.
- **Tags and counts are correlated subqueries, not joins.** A `LEFT JOIN conversation_tags` needs a `GROUP BY c.id` and makes a three-tag conversation three rows before grouping; a subquery keeps the outer loop driven by `conversations_list`. Both return `NULL`/`0` for the empty case, so an untagged conversation still appears.
- **`hidden = 0` in the count**, or a regenerated turn inflates the number the list shows (§4.2).
- **Keyset paging, never `OFFSET`.** `LIMIT ? OFFSET ?` makes SQLite walk and discard every skipped row, so page 10 costs ten times page 1 — and a conversation touched while the user is paging shifts the window, showing a row twice or skipping it. The cursor is `(pinned, updated_at, id)`, written as a **row-value comparison** rather than the expanded `a < ? OR (a = ? AND …)` nest, because SQLite turns the row-value form into a range constraint on `conversations_list` and seeks straight to it while the OR nest is opaque to the planner and rescans from the top of the index every page.

`id` is in the sort key for correctness, not for an ordering anyone wants: two conversations can share a millisecond, and a cursor over a non-unique key either loops or drops rows.

Optional predicates append to the same `WHERE`: `c.profile_id = ?`, `EXISTS (SELECT 1 FROM conversation_tags t WHERE t.conversation_id = c.id AND t.tag = ?)`, and the project filter — where **`projectId: null` is a filter, not the absence of one**. The main list wants the conversations in *no* project, so an absent key emits nothing and an explicit `null` emits `c.project_id IS NULL`.

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
SELECT * FROM messages
WHERE conversation_id = ? AND hidden = 0
ORDER BY seq ASC;
```

One range scan on `messages_conversation`, no sort (§11.2). **`hidden = 0` is what makes regenerate non-destructive** (§4.2): the variants the user paged away from are still rows, and a transcript load must not see them. The same predicate appears in the three other places that read "the current state of this conversation" — the message count above, `last_message_at`, and the stored preview — and search adds it too (§14.3).

Paging for very long conversations uses `seq` as the cursor rather than `OFFSET`, since `OFFSET` re-walks the skipped rows:

```sql
SELECT … FROM messages WHERE conversation_id = ? AND hidden = 0 AND seq > ? ORDER BY seq LIMIT 50;
```

The variant navigator is a separate query over the same rows, and it is the one place `hidden = 1` is wanted:

```sql
-- Every regeneration of one turn, and which is on screen. `min(hidden)` per group
-- is 0 for the selected variant and 1 for the rest; `turn_id IS NOT NULL` keeps the
-- user's own message — the anchor — out of its own pager.
SELECT turn_id AS turnId, min(seq) AS seq, min(hidden) AS hidden
FROM messages
WHERE conversation_id = ? AND answers_id = ? AND turn_id IS NOT NULL
GROUP BY turn_id ORDER BY seq ASC;
```

Ordering by `min(seq)` — the first row of each pass — is what keeps the pager's ‹ 2/3 › numbering stable as the user pages back and forth. See §14.4 for the four statements that write these columns.


### 14.3 Full-text search with snippets, and its fallback

```sql
-- Preferred path: FTS5 available.
SELECT m.id, m.conversation_id, c.title, m.role, m.created_at, m.text
  FROM messages m JOIN conversations c ON c.id = m.conversation_id
  JOIN messages_fts f ON f.rowid = m.rowid
 WHERE messages_fts MATCH ?
   AND m.hidden = 0
   AND EXISTS (SELECT 1 FROM conversation_tags t
                WHERE t.conversation_id = c.id AND t.tag = ?)   -- when a tag chip is active
   AND c.project_id = ?                                          -- when inside a project
 ORDER BY f.rank, m.created_at DESC
 LIMIT ?;
```

```sql
-- Fallback: no FTS5 in this build, a CJK query unicode61 cannot tokenise, or a
-- MATCH that threw. Same projection, same filters, different predicate.
SELECT m.id, m.conversation_id, c.title, m.role, m.created_at, m.text
  FROM messages m JOIN conversations c ON c.id = m.conversation_id
 WHERE m.text LIKE ? ESCAPE '\' AND m.hidden = 0
 ORDER BY m.created_at DESC
 LIMIT ?;
```

Five things in there are load-bearing:

- **`f.rank` is `bm25()` under a different name**, and it returns a *negative* score where more relevant is more negative. `ORDER BY f.rank` ascending is correct; `DESC` silently returns the worst matches first.
- **The snippet is built in JS, not by `snippet()`.** Both passes select `m.text` and `excerpt(text, query)` produces the excerpt, so an FTS hit and a `LIKE` hit are highlighted by the same code and look identical to the user. `via: 'fts' | 'like'` records which path found it.
- **`m.hidden = 0`**, or search returns a variant the user paged away from — and opening it lands on a conversation that does not contain the highlighted text.
- **The tag and project filters are on the search too, not just the list.** Both passes already join `conversations`, so each is one predicate against a row that is there anyway. Without them, picking a tag and then typing narrows the list above the results but not the results themselves.
- **`ESCAPE` on the fallback is required**: a user searching for `100%` or `snake_case` would otherwise get wildcard behaviour.

The fallback is not redundancy. FTS5's `unicode61` tokenizer makes a run of Chinese into a single token, so a substring query like 分析 genuinely cannot match 数据分析报告 through the index; the gateway accepts Chinese, so the case is real. A `MATCH` that throws also degrades here rather than blanking the screen.

Note the two searches in the list screen are different features and stay that way. `filterConversations()` in [src/chat/list.ts](../src/chat/list.ts:70) filters rows already in memory over the fields the row *displays* (title, preview, model, tags), on every keystroke; `searchMessages()` hits SQLite for hits *inside* message bodies, debounced, rendered as a separate section. Both use `highlightTerms()` so one query string means one thing, but a row appearing under the first is always visibly justified by its own text.

### 14.4 Delete, and what cascades

```sql
PRAGMA foreign_keys = ON;            -- without this, nothing below cascades
DELETE FROM conversations WHERE id = ?;
-- ⇒ messages           : deleted by FK CASCADE (variants included — hidden rows cascade too)
-- ⇒ messages_fts       : deleted by the FTS delete trigger
-- ⇒ conversation_tags  : deleted by FK CASCADE
-- ⇒ usage_events       : RETAINED (no FK, §5.2) — spend history survives
-- ⇒ documents on disk  : RETAINED (no table, §12.5) — nothing to cascade through
```

Deleting a project is the other direction and deliberately does not cascade:

```sql
DELETE FROM projects WHERE id = ?;
-- ⇒ conversations.project_id : SET NULL. The chats move back to the main list;
--   deleting a folder must not delete what was filed in it (§4.10).
```

Rewinding a transcript for edit-and-resend:

```sql
-- inclusive = false (resending after a user message)
DELETE FROM messages WHERE conversation_id = ? AND seq >  ?;
-- inclusive = true  (replacing an assistant message)
DELETE FROM messages WHERE conversation_id = ? AND seq >= ?;
```

Neither is scoped to `hidden`, and that is the point: `deleteMessagesFrom()` means "rewind to here and go again", so **deleting rather than hiding is deliberate** — a hidden tail would keep turning up in search results for a conversation that no longer contains it.

Regenerate is the other path and deletes nothing. It stamps the visible tail, hides it, and anchors the slot — four statements in [src/db/variants.ts](../src/db/variants.ts):

```sql
-- 1. Label the pass being set aside. `hidden = 0` matters: the hidden rows in
--    range already carry their own turn_id from an earlier regenerate, and
--    re-stamping would merge every variant into one.
UPDATE messages SET turn_id = ?, answers_id = ?
 WHERE conversation_id = ? AND hidden = 0 AND seq > ?;   -- `>=` for an assistant row

-- 2. Page that whole pass out of the transcript.
UPDATE messages SET hidden = 1 WHERE conversation_id = ? AND turn_id = ?;

-- 3. Mark the user's message as the slot the variants answer. Its `turn_id`
--    stays NULL — it is the question, not one of the answers.
UPDATE messages SET answers_id = ? WHERE conversation_id = ? AND id = ?;

-- 4. Later, when the user pages: exactly one variant visible, in one statement.
UPDATE messages SET hidden = CASE WHEN turn_id = ? THEN 0 ELSE 1 END
 WHERE conversation_id = ? AND answers_id = ? AND turn_id IS NOT NULL;
```

Statement 3 is what makes a *failed* regenerate recoverable: without it the slot would be discoverable only through rows that are all hidden between setting the old reply aside and the new one arriving, so a regenerate that errored outright would leave the old answer hidden with nothing on screen able to reach it. Statement 4's `turn_id IS NOT NULL` keeps the user's own message out of the `CASE` — the anchor carries the slot id too, and without the guard, paging to another answer would hide the question it answers.

The next ordinary send is what finally drops the alternatives:

```sql
DELETE FROM messages WHERE conversation_id = ? AND hidden = 1;
```

Kept until then, and no longer: a variant is reachable while the user is still on that turn, and meaningless once they have moved past it (§4.2).

### 14.5 Fork a conversation at a message

The shape, as one atomic statement pair:

```sql
BEGIN;
INSERT INTO conversations (id, title, created_at, updated_at, last_message_at,
                           preview, model, profile_id, config, system_prompt,
                           project_id, pinned, archived,
                           forked_from_id, forked_from_message_id)
SELECT ?, title || ' (fork)', ?, ?, last_message_at, preview, model, profile_id,
       config, system_prompt, project_id, 0, 0, id, ?
FROM conversations WHERE id = ?;

-- seq values are COPIED, not renumbered: provenance is preserved and the
-- transcripts stay comparable position-by-position (§7.2).
INSERT INTO messages (id, conversation_id, seq, role, created_at, content, text,
                      model, usage, stop_reason, error, meta, excluded)
SELECT ?, ?, seq, role, created_at, content, text, model, usage, stop_reason,
       error, meta, excluded
FROM messages WHERE conversation_id = ? AND seq <= ? AND hidden = 0
ORDER BY seq;

INSERT OR IGNORE INTO conversation_tags (conversation_id, tag)
SELECT ?, tag FROM conversation_tags WHERE conversation_id = ?;
COMMIT;
```

The fork carries `system_prompt`, `config`, `tags` and `project_id` — forking to explore a different answer with different settings means changing them *after* the fork, not losing them at it, and a fork of a project conversation belongs to the same project. It copies only **visible** messages, because `listMessages()` filters `hidden = 0`: the regeneration variants of the source are a UI affordance on a turn the fork does not have, not history.

**The implementation is not the SQL above, and the difference is a known gap.** `forkConversation()` in [src/db/conversations.ts:855](../src/db/conversations.ts:855) calls `createConversation()` and then loops `appendMessage()`, because each row needs a fresh `newId()` from the app's generator rather than from a SQL expression — and it is **not** wrapped in `withTransactionAsync`. A process death partway through leaves a fork holding a prefix of the messages it should have, which looks complete and is not. The fix is to wrap the loop; it is small, and it is not done. Recorded in [06_Eng_Plan.md](06_Eng_Plan.md)'s debt register rather than fixed inside a documentation pass.

### 14.6 Usage report for a period

```sql
SELECT day, model,
       sum(input)       AS input,
       sum(output)      AS output,
       sum(cache_read)  AS cache_read,
       sum(cache_write) AS cache_write,
       sum(coalesce(cost, 0))                        AS known_cost,
       sum(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unpriced_events
FROM usage_events
WHERE day BETWEEN ? AND ?
GROUP BY day, model
ORDER BY day DESC, output DESC;
```

The columns are `input` and `output`, not `input_tokens`/`output_tokens` — check §4.4 before writing a report query, because the aggregate names and the `TokenUsage` field names are not the same words.

`unpriced_events` is the column that keeps the report honest. `sum(coalesce(cost, 0))` alone would render "$1.42" for a period containing forty unpriced calls; carrying the count lets the UI render "$1.42 + 40 unpriced" and never mislead the user about their spend.

### 14.7 Statements to never write

| Anti-pattern | Why |
|---|---|
| `SELECT * FROM messages` without a `conversation_id` | reads every base64 attachment on the device into JS |
| A transcript read without `hidden = 0` | shows superseded regeneration variants as if they were history (§4.2) |
| `ORDER BY created_at` for a transcript | clock skew reorders history (§7.5) |
| `UPDATE messages SET text = ?` alone | breaks the `text`/`content` invariant (§6.4) |
| `LIMIT ? OFFSET ?` for the conversation list | O(page) cost and a window that shifts under concurrent writes (§14.1) |
| `VACUUM` | desynchronises FTS silently (§12.1) |
| String-interpolated predicates | injection, and defeats statement reuse |
| `json_extract` in a `WHERE` on a hot list query | per-row parse, no index (§10.2) |
| `DELETE FROM usage_events` on conversation delete | erases accounting history (§5.2) |
| `DELETE FROM conversations` expecting the files to go | there is no FK to a filesystem (§12.5) |
| `INSERT INTO mcp_servers … (token)` | there is no token column, and that absence is the design (§4.8) |

---

## Appendix A — Column reference

Nine tables. `conversations` and `messages` are given in full because they are the two that get read at a keystroke's notice; the rest are in §4 with their DDL and their rationale.

**`conversations`**

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | TEXT | no | — | PK, `newId('conv_')` |
| `title` | TEXT | no | — | `deriveTitle()` from the first user message |
| `created_at` | INTEGER | no | — | epoch ms |
| `updated_at` | INTEGER | no | — | any touch; list sort key |
| `pinned` | INTEGER | no | 0 | 0/1; leading column of the list sort |
| `archived` | INTEGER | no | 0 | 0/1; the list's equality predicate |
| `system_prompt` | TEXT | yes | — | a column, not a `config` field (§8.4) |
| `profile_id` | TEXT | no | — | cross-tier soft reference to AsyncStorage |
| `model` | TEXT | no | — | current selection, not history |
| `config` | TEXT | no | `'{}'` | JSON `ConversationConfig` (§8.4) |
| `forked_from_id` | TEXT | yes | — | soft self-reference |
| `forked_from_message_id` | TEXT | yes | — | soft reference |
| `last_message_at` | INTEGER | yes | — | denormalised activity time |
| `preview` | TEXT | yes | — | `previewOf(text)`, ≤160 chars, first non-empty line |
| `project_id` | TEXT | yes | — | FK → `projects(id)` **ON DELETE SET NULL** (§4.10) |

Column order is the shipped order, which is worth preserving in a reader's head: `project_id` is last because it arrived in migration 6 → 7, and `SELECT c.*` in the list query returns them in exactly this sequence.

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
| `excluded` | INTEGER | no | 0 | the context strategy omitted this turn; still visible |
| `turn_id` | TEXT | yes | — | one generation pass; NULL on the user's message (§4.2) |
| `answers_id` | TEXT | yes | — | the slot the variants answer; set on the anchor too |
| `hidden` | INTEGER | no | 0 | a variant paged away from; **every transcript read filters on this** |

`excluded` and `hidden` are both "not in the conversation right now" and they are not interchangeable. `excluded` is about the *request*: the row stays on screen, marked, and is left out of what gets sent. `hidden` is about the *screen*: the row is not rendered, not searched and not counted, but is still sent nothing because it is not part of the current transcript at all.

**The other seven**

| Table | Key | Reference |
|---|---|---|
| `conversation_tags` | composite PK `(conversation_id, tag)`, no surrogate | §4.3 |
| `usage_events` | `INTEGER PRIMARY KEY AUTOINCREMENT`; `day` and `cost` frozen at write time | §4.4 |
| `messages_fts` | external-content FTS5; no columns of its own beyond the index | §4.5 |
| `memories` | UNIQUE `(kind, text)` is the dedupe; `approved` gates injection | §4.6 |
| `skills` | UNIQUE `(name)` because the name is a tool argument | §4.7 |
| `mcp_servers` | UNIQUE `(name)`; **no token column** | §4.8 |
| `prompts` | ranked by `(uses DESC, updated_at DESC)` | §4.9 |
| `projects` | `knowledge` is extracted text, not bytes | §4.10 |

And one tier with no table at all: the files the model writes (§4.11, §12.5).

## Appendix B — Checklists

### B.1 Adding a column

- [ ] Could this be a `config` / `meta` JSON field instead? (§10.2 — prefer JSON unless you must filter, sort, or constrain on it)
- [ ] New migration **appended** at the next index; no shipped migration edited
- [ ] `ALTER TABLE … ADD COLUMN … DEFAULT …` — additive, no table rebuild
- [ ] Every statement idempotent (`IF NOT EXISTS`), because the version bump is *outside* the transaction (§10.1)
- [ ] `SCHEMA_VERSION` still equals `MIGRATIONS.length`
- [ ] Re-running the migration tested, not assumed
- [ ] Row-mapper in `src/db/conversations.ts` updated; TypeScript type updated
- [ ] Old rows read correctly with the default (test with a pre-migration fixture)
- [ ] The rollback question answered in writing: can the previous binary still open this database? (§10.1)
- [ ] If the column is derived, added to the denormalisation ledger (§6.5) with its writer
- [ ] `EXPLAIN QUERY PLAN` re-checked for any query whose predicate changed

### B.2 Adding a `ContentBlock` type

- [ ] Is it actually a block? Charts, LaTeX, tables, terminal output and artifacts are all Markdown inside a `TextBlock` on purpose (§8.1)
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
- [ ] `bm25()` / `f.rank` ordering ascending, not descending
- [ ] `LIKE` parameters escaped with `ESCAPE`
- [ ] `hidden = 0` still in the predicate — a hit on a paged-away variant opens a conversation that does not contain the highlight (§14.3)
- [ ] Tag and project filters still applied to the results, not just to the list above them
- [ ] No `VACUUM`; if the table was rebuilt, FTS rebuilt in the same transaction (§12.1)
- [ ] Drift check still meaningful for the change made

### B.4 Reviewing anything that persists

- [ ] No API key, token, or `Authorization` value reachable from a Zustand slice
- [ ] `partialize` reviewed — everything it returns lands in plaintext AsyncStorage
- [ ] A store that can hold a credential is **not** `persist()`-wrapped at all (`useMcp`, §4.8)
- [ ] A credential goes to SecureStore under its own key, and the row keeps only the reference
- [ ] Anything logged passes through `redact()` at the **write** boundary
- [ ] New secret-bearing field name added to `SECRET_KEY_RE` in `src/lib/redact.ts`
- [ ] `clear all data`, if it exists by then, clears the new state too, including `clearRegisteredSecrets()` — see §13.3, there is no such action today
- [ ] If it writes a file, §12.5 read first: nothing deletes it for you

### B.5 Adding a table

- [ ] Does it need to be a table? `config` (§10.2), `meta`, or a file on disk (§4.11) may be enough
- [ ] Every user-facing name that another subsystem resolves has a UNIQUE index on it (§11.2)
- [ ] FK direction and `ON DELETE` action chosen deliberately: `CASCADE` for parts of a conversation, `SET NULL` for a container like `projects`, no FK at all for a record meant to outlive its source (§5.2)
- [ ] Added to §5.3's blast-radius table — what happens to these rows on a bulk delete
- [ ] Added to the ownership matrix (§13.1) with its store and its kind
- [ ] Added to the backup projection, or deliberately excluded — and if it can hold a credential, excluded (§4.8)
- [ ] Secondary indexes justified by a query that exists, not by symmetry (§11.1)

## Appendix C — Glossary

| Term | Meaning here |
|---|---|
| **Anchor** | The user message carrying `answers_id` with `turn_id` NULL: the slot the variants answer (§14.4) |
| **Block** | One element of `ContentBlock[]`; the atom of message content |
| **bm25** | FTS5 relevance function; more negative = more relevant |
| **Denormalisation ledger** | §6.5 — the list of stored-derived columns and their writers |
| **Drift check** | Startup comparison of `messages_fts` and `messages` row counts |
| **Ephemeral store** | A Zustand store deliberately not persisted: queue, reachability, log (§13.1) |
| **External-content FTS** | FTS5 mode storing only the index, reading column data from a real table |
| **Flatten** | `flattenContent()`: `ContentBlock[]` → searchable prose |
| **Fork** | A new conversation copying a prefix of another, remembering its origin |
| **Fingerprint** | `keyFingerprint()`: `abcd…wxyz (51 chars)` — identifies a key without revealing it |
| **Hydration** | Zustand `persist` restoring AsyncStorage into a store at boot |
| **Keyset paging** | Paging by the sort key rather than `OFFSET`; the only paging this schema supports (§14.1) |
| **Partialize** | The `persist` option selecting which fields are written to disk |
| **Preview** | `previewOf(text)`: first non-empty line, ≤160 chars, for list rows |
| **Progressive disclosure** | A skill's `body` reaching the model only when invoked, never in the tool list (§4.7) |
| **Raw key** | `PRAGMA key = "x'<64 hex>'"`: key material handed to SQLCipher without PBKDF2 |
| **Rowid** | SQLite's implicit integer row key; unstable across `VACUUM` (§12.1) |
| **seq** | `REAL` position of a message within a conversation (§7) |
| **Signature** | Opaque Anthropic thinking-block token; must be echoed verbatim on replay |
| **Slot** | One question and every answer generated for it; identified by `answers_id` (§4.2) |
| **Soft reference** | A stored id with no foreign key, by design (§5.2) |
| **SQLCipher** | The AES-256 SQLite build behind `expo-sqlite`; §12.7 for what it costs |
| **throughSeq** | The `seq` the rolling summary already covers |
| **Tier** | One of the four places state lives: SQLite / AsyncStorage / SecureStore / the document directory (§2) |
| **Turn** | One generation pass over a slot; every row it produced shares a `turn_id` (§4.2) |
| **user_version** | SQLite pragma holding the applied migration number — currently 8 |
| **Variant** | One turn among a slot's siblings; all but one carry `hidden = 1` |
| **WAL** | Write-ahead logging journal mode; concurrent read during write |

---

## Ownership and maintenance

| | |
|---|---|
| **Owner** | Whoever owns `src/db/` — currently the sole maintainer (`Suke2004`) |
| **Reviewers required** | Any change to §4 (DDL), §5 (integrity), §10 (migrations) or §12 (hazards) |
| **Update when** | A migration is added · a column or index changes · a `ContentBlock` type is added · a JSON field is added to `config`/`meta` · a tier boundary moves · a hazard in §12 is fixed · a store changes kind in §13.1 |
| **Do not update for** | Query tuning that changes no schema · UI changes · transport changes that do not alter the stored form |
| **Verification before merge** | Appendix B checklist for the relevant change type; `pnpm run gates` |
| **Staleness signal** | If `SCHEMA_VERSION` in `src/db/ddl.ts` exceeds the version in this document's header table, this document is out of date |

Cross-references: sprint sequencing and the debt items raised here are tracked in [06_Eng_Plan.md](06_Eng_Plan.md); build and release mechanics in [07_Deployment.md](07_Deployment.md); product rationale in [PRD.md](PRD.md); wire protocols and transport contracts in [TRD.md](TRD.md); layer boundaries in [ARCHITECTURE.md](../ARCHITECTURE.md); coding conventions in [GUIDELINES.md](GUIDELINES.md); known defects in [flaws.md](flaws.md); phase status in [progress.md](../progress.md).

## Document history

| Version | Date | Author | Change summary |
|---|---|---|---|
| 1.0 | 2026-08-29 | Architecture review | Initial issue. Documents schema `user_version = 1` as shipped in Phase 1: full ER diagram and cardinalities, DDL reference, enforced and deliberately unenforced constraints, 1NF→3NF walkthrough with the four intentional violations, floating-point `seq` rationale including the precision limit and the redundant `Number.EPSILON`, JSON schemas for all five JSON columns, the cross-wire content-block encoding matrix, migration strategy for both SQL and JSON evolution, index rationale plus one identified gap, the three-tier synchronisation map, a query cookbook with anti-patterns, and four schema-level hazards (FTS/`VACUUM` desynchronisation, preview drift, mid-stream loss, hydration race). Appendix D corrects three stale entries in `progress.md`. |
| 1.1 – 1.2 | 2026-08-30 | Phase 2 | Not written up as separate rows at the time; recorded here for completeness. `user_version` 1 → 2 replaced `conversations_order` with the composite `conversations_list` index that the list query actually uses, and 2 → 3 added the `memories` table (§4.6) with its soft, deliberately unenforced reference to `conversations` — a memory is meant to outlive the conversation it was learned from. |
| 1.3 | 2026-08-30 | Sprint 6 | **§5.3 The blast radius of a bulk delete** — the table of what cascades and what deliberately survives, the load-bearing `PRAGMA foreign_keys = ON`, one-transaction-or-nothing as a correctness requirement, and `BULK_CHUNK` against `SQLITE_MAX_VARIABLE_NUMBER`. **§9.1 The export projection** — `ContentBlock[]`'s third destination, base64 never leaving, `signature` never exported, double redaction and why the artefact is greped rather than the call site checked, and `EXPORT_SCHEMA_VERSION` being independent of `user_version`. §11.1 and §11.3 corrected: `conversations_order` was replaced by `conversations_list (archived, pinned DESC, updated_at DESC, id DESC)` in migration 1 → 2, so the "known index gap" is closed and the planner assertion that proves it is named. No schema change; `user_version` remains 3. |
| 1.4 | 2026-08-30 | Phase 3 | No schema change; `user_version` remains 3. §8.3 rewritten against the shipped code: the projection's source of truth moved to `src/db/content.ts` (split out of `conversations.ts`, which re-exports all three names, because that module's top-level `expo-sqlite` import makes it unreachable under Jest's node environment), and the block table corrected — a document contributes its **name first and always** then its extracted text, an image contributes the `[image]` marker rather than being dropped, and `tool_use` contributes `[tool <name>]`. §7 correspondingly no longer claims non-textual blocks are dropped entirely; what it guarantees is that base64 never reaches the index, which is now an assertion in `src/db/content.test.ts`. §12.2 (preview drift) marked **fixed** — the store calls `previewOf()`, closing D-04. |
| 1.5 | 2026-09-02 | Documentation reconciliation | **`user_version` 3 → 8**, and the document caught up with all five steps in one pass. New sections: §4.7 `skills` (progressive disclosure — only `name` and `description` reach a prompt), §4.8 `mcp_servers` (**no token column**, and why that absence is the design), §4.9 `prompts`, §4.10 `projects` (`SET NULL`, and `knowledge` as extracted text rather than bytes), §4.11 the files the model writes — the tier with no table. §4.2 gained the regeneration columns `turn_id`/`answers_id`/`hidden`; §4.6 gained `approved`, which stops an instruction being *obeyed* where `isSafeToRemember()` stops a secret being *stored*. §2 rewritten around four tiers rather than three, naming SQLCipher and `src/db/cipher.ts`, and §13.1's ownership matrix rebuilt around persisted / SQLite-backed / ephemeral stores. §10.1 now lists all eight migrations with what each one is an example of, and records that all eight are rollback-safe. §11.1 gained the eight indexes the table was missing and corrected four names (`tags`→`conversation_tags`, `usage_day`→`usage_events_day`, and their siblings). New hazards §12.5 (nothing cascades to the filesystem), §12.6 (a project's knowledge cannot be re-extracted) and §12.7 (encryption trades recoverable data for unrecoverable, and the mitigation is that nothing is backed up). Corrections: `usage_events`' DDL (id type and every aggregate column name), `ToolResultBlock.content` is a `string` with a separate `images` array — not `ContentBlock[]`, so the "recursion" rationale built on that is gone and §8.1 now says what is deliberately *not* a block type — `ConversationConfig` replaced with the shipped interface (no `systemPrompt`, which is a column), and §14's cookbook rewritten against the real statements including keyset paging, the four variant statements and the `hidden = 0` filters. Appendix D removed: its three corrections were absorbed or superseded, and its "the gates were never run here" caveat is no longer true. New Appendix B.5 for adding a table. |


