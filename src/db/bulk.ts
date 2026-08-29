/**
 * The SQL behind bulk operations on the conversation list, as pure functions.
 *
 * Split out of `conversations.ts` for the same reason `ddl.ts` and
 * `list-query.ts` are split out: these statements are the ones that destroy
 * fifty rows at a time, so the tests need to run *the statements that ship*
 * against a real SQLite rather than a hand-copied approximation of them. Nothing
 * here imports `expo-sqlite`, which is what lets `__tests__/bulk.test.ts` build
 * a database with `node:sqlite` and check what actually survived a delete.
 *
 * Two decisions are encoded here rather than at the call site:
 *
 * 1. **One statement per chunk, not one per id.** A `DELETE … WHERE id IN (?,?,…)`
 *    is a single pass; fifty separate deletes are fifty statement preparations,
 *    fifty index descents, and — the part that matters — fifty chances for the
 *    caller to get the transaction wrapping wrong.
 * 2. **Chunking exists because SQLite has a parameter ceiling**, not because it
 *    is faster. `SQLITE_MAX_VARIABLE_NUMBER` is 32,766 on anything modern but
 *    999 on older builds, and Android ships whatever the OS image ships. A
 *    selection large enough to hit that is a selection that must not fail.
 */

/**
 * Parameters per statement.
 *
 * Well under the 999 of the oldest builds we could plausibly meet, because the
 * caller may add its own bound parameters (`archived = ?`, a tag) alongside the
 * id list. Raising this buys nothing measurable: the cost of a bulk delete is
 * dominated by the cascade into `messages`, not by statement count.
 */
export const BULK_CHUNK = 400;

/**
 * Splits a list into runs of at most `size`.
 *
 * Returns an empty array for empty input rather than one empty chunk — a caller
 * that loops over the result then issues no statements at all, which is the
 * correct behaviour for "delete nothing".
 */
export function chunk<T>(items: readonly T[], size: number = BULK_CHUNK): T[][] {
  if (size < 1) throw new RangeError(`chunk size must be at least 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * `?, ?, ?` for an `IN` list.
 *
 * Placeholders, always — never interpolated ids. These ids come from our own
 * rows today, but "the values are trusted" is a property that decays the moment
 * something imports a conversation from a file, and a bulk delete is the worst
 * statement in the app to be wrong about.
 */
export function placeholders(count: number): string {
  if (count < 1) throw new RangeError(`an IN list needs at least one placeholder, got ${count}`);
  return new Array(count).fill('?').join(', ');
}

/**
 * De-duplicates and drops blanks, preserving first-seen order.
 *
 * Order is preserved so a failure part-way through a chunked run is
 * reproducible: the same selection produces the same chunks in the same
 * sequence, which makes "it deleted the first 400 and then threw" a debuggable
 * statement rather than a mystery.
 */
export function normaliseIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Deletes conversations by id.
 *
 * `messages` and `conversation_tags` carry `ON DELETE CASCADE`, so they go with
 * the row — `PRAGMA foreign_keys = ON` is set at open time, and without it this
 * statement silently orphans both. `usage_events.conversation_id` is
 * deliberately *not* a foreign key, so spend history survives: it is an
 * accounting record of money already spent, and deleting the conversation does
 * not unspend it. `__tests__/bulk.test.ts` asserts exactly that asymmetry.
 */
export function deleteConversationsSql(count: number): string {
  return `DELETE FROM conversations WHERE id IN (${placeholders(count)})`;
}

/**
 * Archives or restores conversations by id.
 *
 * `updated_at` is left alone on purpose, matching `setPinned` and for the same
 * reason: archiving changes which list a row appears in, not when it last had
 * something said in it. Bumping the timestamp would reorder the archive by when
 * you tidied up rather than by when you last used the thread.
 *
 * The `archived <> ?` guard makes the statement's `changes` count meaningful —
 * it reports how many rows actually moved, so the confirmation can say "12
 * archived" rather than "12 selected, some of which were already archived".
 */
export function setArchivedSql(count: number): string {
  return `UPDATE conversations SET archived = ? WHERE archived <> ? AND id IN (${placeholders(count)})`;
}

/** Adds one tag to many conversations, ignoring the ones that already carry it. */
export function addTagSql(count: number): string {
  // `OR IGNORE` rather than a `WHERE NOT EXISTS`: the primary key on
  // (conversation_id, tag) already states the rule, so the conflict clause is
  // the whole implementation of "adding a tag twice is not an error".
  return `
    INSERT OR IGNORE INTO conversation_tags (conversation_id, tag)
    SELECT id, ? FROM conversations WHERE id IN (${placeholders(count)})
  `;
}

/** Removes one tag from many conversations. */
export function removeTagSql(count: number): string {
  return `DELETE FROM conversation_tags WHERE tag = ? AND conversation_id IN (${placeholders(count)})`;
}

/** Removes every tag from many conversations — the first half of a replace. */
export function clearTagsSql(count: number): string {
  return `DELETE FROM conversation_tags WHERE conversation_id IN (${placeholders(count)})`;
}
