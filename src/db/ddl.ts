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
export const SCHEMA_VERSION = 4;

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
];
