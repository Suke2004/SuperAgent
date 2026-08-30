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
 *
 * 3. **The file is encrypted.** `expo-sqlite` vendors SQLCipher and switches to it
 *    when `expo.sqlite.useSQLCipher` is set, which `app.json` now does, so the whole
 *    database — conversations, memories, MCP server rows — is AES-256 at rest under
 *    a key that lives in the Android Keystore and nowhere else. See {@link unlock}
 *    for what that does and does not buy.
 */

import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';

import { log } from '@/lib/log';

import { attachKeyClause, isKeyHex, KEY_BYTES, keyHexFrom, keyPragma } from './cipher';
import { FTS_DDL, MIGRATIONS, SCHEMA_VERSION } from './ddl';

const DATABASE_NAME = 'agentrouter.db';

/** Where the encrypted copy is built during the one-time conversion. */
const CONVERTING_NAME = 'agentrouter.converting.db';

/** Where the plaintext original is parked between the two moves that swap them. */
const SUPERSEDED_NAME = 'agentrouter.plaintext.db';

/** The Keystore slot holding the raw key. Losing it means losing the database. */
const KEY_SLOT = 'agentrouter.dbKey';

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
  const key = await databaseKey();
  if (key) await convertIfPlaintext(key);

  const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
  if (key) await unlock(db, key);

  // WAL lets a read run while a write is in flight, which matters because the
  // conversation list re-queries while a stream is appending deltas.
  // `foreign_keys` is off by default in SQLite and the cascades below rely on it.
  //
  // After `PRAGMA key`, never before: on an encrypted database every statement
  // before the key is set fails, including this one.
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const from = row?.user_version ?? 0;

  if (from < SCHEMA_VERSION) {
    for (let version = from; version < SCHEMA_VERSION; version += 1) {
      const migration = MIGRATIONS[version];
      if (!migration) throw new Error(`No migration from schema version ${version}`);
      await db.withTransactionAsync(async () => {
        await db.execAsync(migration);
        // Inside the transaction, not after it. `PRAGMA user_version` is itself
        // transactional, so committing the two together is what makes a migration
        // exactly-once — the app killed between the DDL and the bump used to re-run
        // the step, which every earlier step survives only because it is written
        // `IF NOT EXISTS`. Migration 5 → 6 is an `ALTER TABLE ADD COLUMN`, and
        // SQLite has no `IF NOT EXISTS` for that.
        //
        // Cannot be parameterised, and `version + 1` is a loop counter rather than
        // anything reachable from user input.
        await db.execAsync(`PRAGMA user_version = ${version + 1}`);
      });
    }
    log.info('db', `Migrated schema ${from} → ${SCHEMA_VERSION}`);
  }

  const ftsAvailable = await ensureFts(db);
  return { db, ftsAvailable };
}

/** The absolute path `expo-sqlite` would use for a database of this name. */
function databasePath(name: string): string {
  return `${String(SQLite.defaultDatabaseDirectory).replace(/\/+$/, '')}/${name}`;
}

function databaseFile(name: string): File {
  return new File(`file://${databasePath(name)}`);
}

/**
 * The raw key for the database, minted on first launch and kept in the Keystore.
 *
 * `null` on web, where there is no Keystore to hold a key and no SQLCipher in the
 * wasm build to use one — the same split as `lib/secureKey`, and for the same
 * reason: Android is the supported target.
 *
 * A key that cannot be read back is not recoverable. That is the deliberate cost of
 * encrypting at all, and it is bounded: `android.allowBackup` is false and
 * `plugins/with-no-backup.js` excludes the database from both cloud backup and
 * device transfer, so there is no path by which the database file arrives on a
 * device whose Keystore never held its key. Uninstalling clears both together.
 */
async function databaseKey(): Promise<string | null> {
  if (Platform.OS === 'web') return null;

  const existing = await SecureStore.getItemAsync(KEY_SLOT);
  if (existing && isKeyHex(existing)) return existing;
  if (existing) log.warn('db', 'The stored database key was malformed; minting a new one');

  const minted = keyHexFrom(Crypto.getRandomBytes(KEY_BYTES));
  await SecureStore.setItemAsync(KEY_SLOT, minted, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
  return minted;
}

/**
 * Applies the key and proves it worked.
 *
 * What this buys: the file is useless off the device. `adb backup`, a recovery-mode
 * pull, a stolen phone image, or anything that reaches the app's data directory
 * without also reaching its Keystore entry gets AES-256 ciphertext.
 *
 * What it does not buy: protection from root, or from a compromised copy of this
 * app. The key is deliberately *not* behind `requireAuthentication` — that would be
 * stronger, and it would also mean no database access while the device is locked,
 * which breaks the offline send queue and any background work. The app lock covers
 * the borrowed-phone case at the UI layer instead.
 */
async function unlock(db: SQLite.SQLiteDatabase, key: string): Promise<void> {
  await db.execAsync(keyPragma(key));
  try {
    // The first read is what actually verifies the key: `PRAGMA key` never fails.
    await db.getFirstAsync('SELECT count(*) FROM sqlite_master');
  } catch (error) {
    throw new Error(
      'The database could not be decrypted. Its key is missing or does not match, which happens ' +
        'if the app data was moved from another device. Clearing app storage will start a new, empty ' +
        `database. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * Converts a pre-encryption database in place, once.
 *
 * The path is: read the plaintext file, `sqlcipher_export` it into a fresh encrypted
 * one, then swap the two files. SQLCipher cannot re-key a plaintext database — the
 * page format differs — so a copy is the only route.
 *
 * The swap is two moves rather than a delete-then-move so that no window exists in
 * which the data is only in a file that is about to be replaced. If the process dies
 * between them the next launch finds the parked original and the missing main file,
 * and puts it back.
 */
async function convertIfPlaintext(key: string): Promise<void> {
  const main = databaseFile(DATABASE_NAME);
  const superseded = databaseFile(SUPERSEDED_NAME);

  if (superseded.exists && !main.exists) {
    // A conversion that died mid-swap. The parked file is the only copy.
    await superseded.move(main);
    log.warn('db', 'Recovered the database from an interrupted encryption pass');
  }
  if (!main.exists) return; // Nothing to convert; a new file is born encrypted.
  if (await opens(key)) return; // Already ours.
  if (!(await opens(null))) return; // Neither keyed nor plaintext — let `unlock` report it.

  log.info('db', 'Encrypting the existing database; this happens once');

  const converting = databaseFile(CONVERTING_NAME);
  if (converting.exists) converting.delete(); // Leftover from an attempt that failed earlier.

  const plain = await SQLite.openDatabaseAsync(DATABASE_NAME);
  try {
    const row = await plain.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    // Not parameterisable: `ATTACH` takes no bindings. The path is built from a
    // module constant and the key clause is validated in `./cipher`.
    await plain.execAsync(`ATTACH DATABASE '${databasePath(CONVERTING_NAME)}' AS enc ${attachKeyClause(key)}`);
    // `sqlcipher_export` is a function, so it has to be selected rather than exec'd.
    await plain.getFirstAsync("SELECT sqlcipher_export('enc')");
    // Copied page by page, so the schema version is not among the copied data.
    await plain.execAsync(`PRAGMA enc.user_version = ${row?.user_version ?? 0}`);
    await plain.execAsync('DETACH DATABASE enc');
  } finally {
    await plain.closeAsync().catch(() => undefined);
  }

  await main.move(superseded);
  await databaseFile(CONVERTING_NAME).move(databaseFile(DATABASE_NAME));

  // The plaintext journal siblings would otherwise be read as belonging to the
  // encrypted file that just took its name, which is a corrupt-database report.
  for (const suffix of ['-wal', '-shm']) {
    const stale = databaseFile(`${DATABASE_NAME}${suffix}`);
    if (stale.exists) stale.delete();
  }
  databaseFile(SUPERSEDED_NAME).delete();
  log.info('db', 'The database is now encrypted');
}

/** Whether the database on disk can be read with this key, or without one. */
async function opens(key: string | null): Promise<boolean> {
  const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
  try {
    if (key) await db.execAsync(keyPragma(key));
    await db.getFirstAsync('SELECT count(*) FROM sqlite_master');
    return true;
  } catch {
    return false;
  } finally {
    await db.closeAsync().catch(() => undefined);
  }
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
