/**
 * Database connection, schema and migrations.
 *
 * One connection for the whole app, created once and shared through a module
 * promise: `expo-sqlite` serialises statements per connection, so a second
 * connection would buy nothing and cost WAL contention.
 *
 * Two things here are less obvious than they look:
 *
 * 1. **Full-text search is probed, not assumed.** Expo's SQLite build ships FTS5
 *    today, but that is a build-time flag rather than an API contract, and a
 *    missing module surfaces as an exception from `CREATE VIRTUAL TABLE` rather
 *    than anything catchable at compile time. Losing search entirely on a future
 *    SDK bump would be a bad trade for a fifteen-line fallback, so the failure is
 *    caught and recorded and the data access layer degrades to `LIKE`.
 *
 * 2. **`messages.text` is denormalised on purpose.** Content is stored as a JSON
 *    array of blocks, which FTS cannot index and a list preview cannot cheaply
 *    read. The flattened text is written alongside it by the same statement, so
 *    the two can't drift.
 */

import * as SQLite from 'expo-sqlite';

import { log } from '@/lib/log';

const DATABASE_NAME = 'agentrouter.db';

/** Bumped whenever {@link MIGRATIONS} grows. Stored in SQLite's `user_version`. */
const SCHEMA_VERSION = 1;

export interface DatabaseHandle {
  db: SQLite.SQLiteDatabase;
  /**
   * False when `CREATE VIRTUAL TABLE ... USING fts5` failed. The data access
   * layer checks this rather than catching per query.
   */
  ftsAvailable: boolean;
}

let handle: Promise<DatabaseHandle> | null = null;

/**
 * The shared connection, opening and migrating on first call.
 *
 * A rejected promise is discarded so a transient failure — a locked file during
 * a restore, say — doesn't poison every later call for the life of the process.
 */
export function database(): Promise<DatabaseHandle> {
  if (!handle) {
    handle = open().catch((error: unknown) => {
      handle = null;
      throw error;
    });
  }
  return handle;
}

async function open(): Promise<DatabaseHandle> {
  const db = await SQLite.openDatabaseAsync(DATABASE_NAME);

  // WAL lets a read run while a write is in flight, which matters because the
  // conversation list re-queries while a stream is appending deltas.
  // `foreign_keys` is off by default in SQLite and the cascades below rely on it.
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const from = row?.user_version ?? 0;

  if (from < SCHEMA_VERSION) {
    for (let version = from; version < SCHEMA_VERSION; version += 1) {
      const migration = MIGRATIONS[version];
      if (!migration) throw new Error(`No migration from schema version ${version}`);
      await db.withTransactionAsync(async () => {
        await db.execAsync(migration);
      });
      // `PRAGMA user_version` cannot be parameterised, and `version + 1` is a
      // loop counter rather than anything reachable from user input.
      await db.execAsync(`PRAGMA user_version = ${version + 1}`);
    }
    log.info('db', `Migrated schema ${from} → ${SCHEMA_VERSION}`);
  }

  const ftsAvailable = await ensureFts(db);
  return { db, ftsAvailable };
}

/**
 * Creates the FTS index and its synchronisation triggers, reporting whether the
 * build supports it.
 *
 * Kept out of the numbered migrations so a build without FTS5 still gets a
 * working database: a failed `CREATE VIRTUAL TABLE` inside migration 0 would
 * roll back the tables the app cannot run without.
 */
async function ensureFts(db: SQLite.SQLiteDatabase): Promise<boolean> {
  try {
    await db.execAsync(`
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
    `);

    // A database created before the index existed — or one whose triggers were
    // absent for a version — has rows the index has never seen. Rebuilding is
    // cheap at personal scale and idempotent.
    const indexed = await db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM messages_fts');
    const stored = await db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM messages');
    if ((indexed?.n ?? 0) !== (stored?.n ?? 0)) {
      await db.execAsync("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
      log.info('db', `Rebuilt the search index over ${stored?.n ?? 0} message(s)`);
    }

    return true;
  } catch (error) {
    log.warn('db', 'FTS5 is unavailable in this build; search will use a slower LIKE scan', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Schema migrations, indexed by the version they upgrade *from*.
 *
 * Append only. Editing an existing entry changes the schema of databases that
 * have already run it, which is how a migration silently stops matching the
 * table it created.
 */
const MIGRATIONS: readonly string[] = [
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
    -- the query is an index scan rather than a sort.
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
];

/**
 * Drops every row without dropping the schema.
 *
 * Used by the "delete all conversations" action and by settings restore, which
 * needs an empty database to import into.
 */
export async function resetDatabase(): Promise<void> {
  const { db } = await database();
  await db.withTransactionAsync(async () => {
    // `messages` and `conversation_tags` cascade from `conversations`.
    await db.execAsync('DELETE FROM conversations; DELETE FROM usage_events;');
  });
  const { ftsAvailable } = await database();
  if (ftsAvailable) {
    await db.execAsync("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
  }
  log.info('db', 'Database cleared');
}

/** Local calendar day as `YYYY-MM-DD`, for the usage dashboard's grouping. */
export function localDay(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
