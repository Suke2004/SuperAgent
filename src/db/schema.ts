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

import { FTS_DDL, MIGRATIONS, SCHEMA_VERSION } from './ddl';

const DATABASE_NAME = 'agentrouter.db';

export { FTS_DDL, MIGRATIONS, SCHEMA_VERSION };

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
 * The DDL itself lives in `./ddl` so a test can build the same database without
 * `expo-sqlite`.
 */
async function ensureFts(db: SQLite.SQLiteDatabase): Promise<boolean> {
  try {
    await db.execAsync(FTS_DDL);

    // A database created before the index existed — or one whose triggers were
    // absent for a version — holds rows the index disagrees with. FTS5's own
    // `integrity-check` is what decides; see {@link ftsIsConsistent} for why the
    // check is spelled the way it is. This used to compare row counts (debt
    // D-03), which only caught rows missing outright: an edit that changed a
    // message's text while the update trigger was absent leaves the count
    // identical and the index wrong, so search kept matching words the message
    // no longer contained. Rebuilding is cheap at personal scale and idempotent.
    if (!(await ftsIsConsistent(db))) {
      await db.execAsync("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
      const stored = await db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM messages');
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
 * Whether the FTS index still agrees with the `messages` table.
 *
 * Two details that are easy to get wrong:
 *
 * 1. **The `rank = 1` argument is the whole point.** A bare `integrity-check`
 *    only verifies that the index is internally well formed, which a stale index
 *    over an external-content table always is — it is a perfectly consistent
 *    index of what the table *used to say*. Passing 1 asks FTS5 to re-tokenise
 *    the content table and compare checksums, which is the only form that
 *    detects drift. Verified against SQLite 3.53: the bare form returns success
 *    on a table this test deliberately corrupts.
 * 2. **A throw is not necessarily drift.** The argument arrived in SQLite 3.41,
 *    so an older build rejects the statement outright. That reads as a syntax or
 *    "no such cursor" error rather than a checksum mismatch, and treating it as
 *    drift would rebuild the entire index on every single launch. So the error is
 *    inspected: only a corruption report means rebuild, and anything else falls
 *    back to the bare check.
 *
 * Separate from {@link ensureFts} so a failed check stays distinguishable from a
 * missing FTS5 module — the first is repaired by rebuilding, the second means
 * the build has no FTS5 at all and the caller must degrade to `LIKE`.
 */
async function ftsIsConsistent(db: SQLite.SQLiteDatabase): Promise<boolean> {
  try {
    await db.execAsync("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)");
    return true;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (message.includes('checksum') || message.includes('corrupt')) return false;

    log.warn('db', 'Could not run the strict search-index check; falling back to the basic one', { error: message });
    try {
      await db.execAsync("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')");
      return true;
    } catch {
      return false;
    }
  }
}

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
