/**
 * The schema, as SQL text and nothing else.
 *
 * Split out of `schema.ts` so it can be loaded without `expo-sqlite`. The
 * planner assertions in `__tests__/list-query.test.ts` build a real database
 * from these strings using Node's built-in `node:sqlite` and then check what
 * SQLite actually decides to do with the list query. A test that kept its own
 * copy of the DDL would prove only that the copy is well formed — the index it
 * asserts on has to be the index the app ships.
 */

/** Bumped whenever {@link MIGRATIONS} grows. Stored in SQLite's `user_version`. */
export const SCHEMA_VERSION = 9;

/**
 * The FTS index and the three triggers that keep it in step with `messages`.
 *
 * Kept out of the numbered migrations so a build without FTS5 still gets a
 * working database: a failed `CREATE VIRTUAL TABLE` inside migration 0 would
 * roll back the tables the app cannot run without.
 */
export const FTS_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text,
    content = 'messages',
    content_rowid = 'rowid',
    tokenize = "unicode61 remove_diacritics 2"
  );

  CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
`;

/**
 * Schema migrations, indexed by the version they upgrade *from*.
 *
 * Append only. Editing an existing entry changes the schema of databases that
 * have already run it, which is how a migration silently stops matching the
 * table it created.
 */
export const MIGRATIONS: readonly string[] = [
  /* 0 → 1 */ `
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
      -- Sampling params, reasoning config, enabled skills and MCP servers, as
      -- JSON. A column per knob would mean a migration for every new control,
      -- and nothing queries them.
      config                 TEXT    NOT NULL DEFAULT '{}',
      forked_from_id         TEXT,
      forked_from_message_id TEXT,
      last_message_at        INTEGER,
      -- First line of the newest message, for the list. Denormalised so the list
      -- is one query rather than one query per row.
      preview                TEXT
    );

    -- Pinned first, then most recent: the exact order the list renders in, so
    -- the query is an index scan rather than a sort. Superseded in migration
    -- 1 → 2, which puts \`archived\` in front of it.
    CREATE INDEX conversations_order ON conversations (pinned DESC, updated_at DESC);
    CREATE INDEX conversations_profile ON conversations (profile_id);

    CREATE TABLE conversation_tags (
      conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      tag             TEXT NOT NULL,
      PRIMARY KEY (conversation_id, tag)
    );

    CREATE INDEX conversation_tags_tag ON conversation_tags (tag);

    CREATE TABLE messages (
      id              TEXT    PRIMARY KEY NOT NULL,
      conversation_id TEXT    NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      -- REAL rather than INTEGER so a message can be inserted between two others
      -- by averaging their keys, without rewriting every following row.
      seq             REAL    NOT NULL,
      role            TEXT    NOT NULL,
      created_at      INTEGER NOT NULL,
      -- JSON ContentBlock[]. The source of truth for what gets sent.
      content         TEXT    NOT NULL,
      -- Flattened text of the blocks above: what FTS indexes and what the list
      -- preview reads. Written by the same statement as the content column.
      text            TEXT    NOT NULL DEFAULT '',
      model           TEXT,
      -- JSON TokenUsage, read from the response. Never estimated.
      usage           TEXT,
      stop_reason     TEXT,
      -- The gateway's own error text, verbatim, when the turn failed.
      error           TEXT,
      -- JSON: dropped params, effort, thinking budget, skill invocations.
      meta            TEXT,
      -- Set when the context strategy omitted this turn from the request. The
      -- message stays visible and marked rather than disappearing.
      excluded        INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX messages_conversation ON messages (conversation_id, seq);

    CREATE TABLE usage_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      at              INTEGER NOT NULL,
      -- Local YYYY-MM-DD, computed on write. Grouping by day in SQL from a UTC
      -- epoch would bucket by UTC days and split the user's evening in two.
      day             TEXT    NOT NULL,
      profile_id      TEXT    NOT NULL,
      model           TEXT    NOT NULL,
      input           INTEGER NOT NULL DEFAULT 0,
      output          INTEGER NOT NULL DEFAULT 0,
      thinking        INTEGER,
      cache_read      INTEGER,
      cache_write     INTEGER,
      -- NULL when the model has no pricing set, so the dashboard can report
      -- "cost unknown" rather than implying zero.
      cost            REAL,
      conversation_id TEXT
    );

    CREATE INDEX usage_events_day ON usage_events (day);
    CREATE INDEX usage_events_model ON usage_events (model);
  `,
  /* 1 → 2 */ `
    -- The list has always been "unarchived, pinned first, newest first", but the
    -- index it was meant to serve started at \`pinned\`, so every query had to
    -- test \`archived\` row by row and — because the cursor's tie-break column
    -- was not in the index — sort the survivors in a TEMP B-TREE. Leading with
    -- \`archived\` turns that test into an equality constraint, and carrying
    -- \`id\` makes the index spell out the whole ORDER BY, so paging becomes a
    -- range seek instead of a scan-and-sort. Debt D-02.
    DROP INDEX IF EXISTS conversations_order;

    CREATE INDEX IF NOT EXISTS conversations_list
      ON conversations (archived, pinned DESC, updated_at DESC, id DESC);
  `,
  /* 2 → 3 */ `
    -- Long-term memory: the handful of durable things about the user that are
    -- worth carrying into a conversation that has never met them.
    CREATE TABLE IF NOT EXISTS memories (
      id             TEXT    PRIMARY KEY NOT NULL,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      -- 'preference' | 'fact' | 'project' | 'style'. Decides the heading it is
      -- written under, which is what stops a stylistic note from reading like a
      -- statement of fact.
      kind           TEXT    NOT NULL,
      text           TEXT    NOT NULL,
      -- Where it was learned. Deliberately *not* a foreign key: deleting the
      -- conversation that revealed a preference should not delete the preference,
      -- and a cascade here would make tidying up the list quietly amnesiac.
      source_conversation_id TEXT,
      -- How many separate turns have restated it. The eviction order when the
      -- prompt budget cannot fit everything, on the theory that something said
      -- three times is likelier to be a standing preference than a one-off.
      hits           INTEGER NOT NULL DEFAULT 1,
      last_used_at   INTEGER,
      -- User-pinned memories are exempt from budget eviction.
      pinned         INTEGER NOT NULL DEFAULT 0
    );

    -- The uniqueness that makes "remember this" idempotent: re-learning the same
    -- fact bumps \`hits\` instead of adding a second copy, so the prompt never
    -- contains the same sentence twice.
    --
    -- \`IF NOT EXISTS\` throughout this step, like the one before it: a migration
    -- interrupted part-way — the app killed while upgrading — has to be safe to
    -- run again, and \`user_version\` is only bumped once the whole step commits.
    CREATE UNIQUE INDEX IF NOT EXISTS memories_unique ON memories (kind, text);

    -- The order the prompt builder reads them in.
    CREATE INDEX IF NOT EXISTS memories_rank ON memories (pinned DESC, hits DESC, updated_at DESC);
  `,
  /* 3 → 4 */ `
    -- Skills: instruction bundles the user writes or imports, switched on per
    -- conversation. Only \`name\` and \`description\` ever reach a prompt; \`body\`
    -- is fetched by the \`invoke_skill\` tool, which is the whole reason a phone
    -- can afford several of these at once.
    CREATE TABLE IF NOT EXISTS skills (
      id          TEXT    PRIMARY KEY NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      -- A slug, because it is the tool argument's enum value: the model has to
      -- type it back verbatim, so a name with spaces or case is a name it will
      -- get wrong.
      name        TEXT    NOT NULL,
      description TEXT    NOT NULL,
      body        TEXT    NOT NULL
    );

    -- Unique because \`ConversationConfig.skills\` stores names, not ids, and two
    -- skills answering to one name would make an enabled toggle ambiguous.
    -- \`IF NOT EXISTS\` throughout, like the steps before it: an interrupted
    -- migration must be safe to re-run.
    CREATE UNIQUE INDEX IF NOT EXISTS skills_name ON skills (name);
  `,
  /* 4 → 5 */ `
    -- MCP servers, and the prompt library, which arrive together because both are
    -- small user-authored tables and a migration is a migration.
    --
    -- No token column, deliberately. A bearer token and an OAuth access token are
    -- credentials, so they live in expo-secure-store under \`mcp.<id>\` beside the
    -- API key — a database file is backed up, copied to a computer, and read by
    -- anything with the file, and the app's own backup/restore would carry it.
    -- What is stored here is the non-secret half: where the server is, what it
    -- said it can do, and what the user decided about it.
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id          TEXT    PRIMARY KEY NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      name        TEXT    NOT NULL,
      url         TEXT    NOT NULL,
      -- 'http' (Streamable HTTP) | 'sse' (the 2024-11-05 transport). Never stdio:
      -- a phone has no child process to speak it to.
      transport   TEXT    NOT NULL DEFAULT 'http',
      -- 'none' | 'bearer' | 'oauth'. The token itself is in the Keystore.
      auth_kind   TEXT    NOT NULL DEFAULT 'none',
      -- JSON: user-configured static headers, e.g. an X-Api-Key. Never a bearer
      -- token — that has a Keystore slot, and this column is in the backup.
      headers     TEXT    NOT NULL DEFAULT '{}',
      -- JSON: OAuth client id, endpoints and token expiry. No secrets.
      oauth       TEXT,
      -- JSON McpTool[] from the last discovery, so the app can build a request
      -- without a round trip on the turn's hot path.
      tools       TEXT    NOT NULL DEFAULT '[]',
      -- JSON: resources and prompts the server advertises, for the settings screen.
      catalogue   TEXT    NOT NULL DEFAULT '{}',
      -- JSON string[]: which tool names are switched on at all. A server with
      -- forty tools would otherwise put 8-15k tokens of schema in every request.
      enabled     TEXT    NOT NULL DEFAULT '[]',
      -- JSON Record<string, 'ask' | 'always' | 'deny'>: the standing decision per
      -- tool, from the approval sheet.
      approvals   TEXT    NOT NULL DEFAULT '{}',
      -- What the last connection attempt said, so the row can be honest about it.
      last_error  TEXT,
      last_seen_at INTEGER
    );

    -- Names are what the conversation config stores, same reasoning as skills.
    CREATE UNIQUE INDEX IF NOT EXISTS mcp_servers_name ON mcp_servers (name);

    -- The prompt library: reusable message templates with {{variables}}.
    CREATE TABLE IF NOT EXISTS prompts (
      id         TEXT    PRIMARY KEY NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      title      TEXT    NOT NULL,
      body       TEXT    NOT NULL,
      -- Bumped on use, so the list can put what you actually use at the top.
      uses       INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS prompts_rank ON prompts (uses DESC, updated_at DESC);
  `,
  /* 5 → 6 */ `
    -- A review gate on distilled memories.
    --
    -- Model-authored text was going straight into the system prompt of every later
    -- conversation, which makes anything the distiller picks up — including a line
    -- from an attached document that reads like a preference — persistent
    -- cross-conversation prompt injection that outlives the chat it entered
    -- through. An unapproved memory is stored but never sent.
    --
    -- \`DEFAULT 1\` so anything already in the table stays in use: those rows were
    -- learned under the old contract, they are already visible and editable in
    -- Settings → Memory, and re-reviewing them buys nothing. Only new distillations
    -- insert a 0.
    ALTER TABLE memories ADD COLUMN approved INTEGER NOT NULL DEFAULT 1;
  `,
  /* 6 → 7 */ `
    -- Projects: a group of conversations that share instructions and documents.
    --
    -- A table rather than a reuse of \`conversation_tags\` because a project carries
    -- content of its own. A tag is a label with nothing behind it; this has a prompt
    -- every chat in the group inherits and a document set they all read, and hanging
    -- those off a string in a join table would mean a second table anyway.
    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT    PRIMARY KEY NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      name         TEXT    NOT NULL,
      -- Prepended to the system prompt of every conversation in the project, above
      -- the conversation's own prompt. See \`@/chat/project\`.
      instructions TEXT    NOT NULL DEFAULT '',
      -- JSON [{name, text}]: reference documents, as already-extracted text. The
      -- bytes of the original file are not kept — only what a model can read.
      knowledge    TEXT    NOT NULL DEFAULT '[]'
    );

    -- Nullable, and the app clears it on delete rather than relying on the cascade:
    -- \`PRAGMA foreign_keys\` is a per-connection setting, so a schema that only
    -- enforces this in SQL would leave dangling ids on any connection that forgot.
    ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES projects (id) ON DELETE SET NULL;

    -- The project's own conversation list: newest first, same shape as the main list.
    CREATE INDEX IF NOT EXISTS conversations_project
      ON conversations (project_id, updated_at DESC, id DESC);
  `,
  /* 7 → 8 */ `
    -- Regenerating a reply keeps the old one instead of deleting it.
    --
    -- Three columns rather than the parent-pointer tree this would be if the app
    -- branched everywhere: the transcript stays one linear path, and only the
    -- newest reply has alternatives. That keeps the request builder, the trim
    -- ladder and the exporters reading a flat list, which is where a subtle bug
    -- would cost money.
    --
    -- Every existing row keeps NULLs and \`hidden = 0\`, which reads as "a turn of
    -- its own, with no siblings" — so nothing has to be rewritten to migrate.

    -- All the rows one generation pass wrote. A turn that called tools writes an
    -- assistant row *and* a \`tool_result\` row per round, and paging away from that
    -- reply has to take all of them, so the group is keyed by the pass rather than
    -- by a message id.
    ALTER TABLE messages ADD COLUMN turn_id TEXT;

    -- The user message this turn answers: the slot the variants compete for.
    ALTER TABLE messages ADD COLUMN answers_id TEXT;

    -- An unselected variant. Filtered out of the transcript, the preview and
    -- search, and dropped outright by the next send — the invariant is that hidden
    -- rows only ever exist for the turn at the end of the conversation.
    ALTER TABLE messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

    CREATE INDEX IF NOT EXISTS messages_variants
      ON messages (conversation_id, answers_id, turn_id);
  `,
  /* 8 → 9 */ `
    -- Bounded local knowledge graph for Jarvis-style personalization. The
    -- existing memories table remains the review-gated prompt source; these
    -- tables add relationships and provenance without changing that contract.
    CREATE TABLE IF NOT EXISTS memory_nodes (
      id TEXT PRIMARY KEY NOT NULL,
      memory_id TEXT REFERENCES memories (id) ON DELETE CASCADE,
      node_type TEXT NOT NULL,
      label TEXT NOT NULL,
      normalized TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      importance INTEGER NOT NULL DEFAULT 0,
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      approved INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS memory_nodes_unique ON memory_nodes (node_type, normalized);
    CREATE INDEX IF NOT EXISTS memory_nodes_rank ON memory_nodes (approved, importance DESC, confidence DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_edges (
      id TEXT PRIMARY KEY NOT NULL,
      from_node_id TEXT NOT NULL REFERENCES memory_nodes (id) ON DELETE CASCADE,
      to_node_id TEXT NOT NULL REFERENCES memory_nodes (id) ON DELETE CASCADE,
      relation TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS memory_edges_unique ON memory_edges (from_node_id, to_node_id, relation);
    CREATE INDEX IF NOT EXISTS memory_edges_from ON memory_edges (from_node_id);
    CREATE INDEX IF NOT EXISTS memory_edges_to ON memory_edges (to_node_id);

    CREATE TABLE IF NOT EXISTS memory_evidence (
      id TEXT PRIMARY KEY NOT NULL,
      node_id TEXT NOT NULL REFERENCES memory_nodes (id) ON DELETE CASCADE,
      conversation_id TEXT,
      excerpt TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_evidence_node ON memory_evidence (node_id, created_at DESC);

    INSERT OR IGNORE INTO memory_nodes
      (id, memory_id, node_type, label, normalized, confidence, importance, sensitivity, approved, created_at, updated_at)
      SELECT 'mnode_' || id, id, kind, text, lower(trim(text)), 0.7, 0, 'normal', approved, created_at, updated_at
      FROM memories;
  `,
];
