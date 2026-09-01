/**
 * The conversation list query, as a pure string builder.
 *
 * Two reasons this is not inlined in `conversations.ts`:
 *
 * 1. **Paging has to be keyset paging.** `LIMIT ? OFFSET ?` makes SQLite walk
 *    and discard every skipped row, so page 10 costs ten times page 1 and — the
 *    part that actually bites — a conversation whose `updated_at` changes while
 *    the user is paging shifts the window, so a row is shown twice or skipped.
 *    A cursor built from the sort key has neither problem.
 *
 * 2. **The planner is worth asserting on.** Keyset paging is only fast when the
 *    index spells out the whole `ORDER BY`; miss a column and SQLite silently
 *    falls back to sorting the result in a TEMP B-TREE, which is correct, fast
 *    at ten conversations, and quadratic at five hundred. Building the SQL as a
 *    value lets a test hand the real query to `EXPLAIN QUERY PLAN` and fail when
 *    that happens, rather than waiting for someone to notice the list is slow.
 *
 * The sort key is `(pinned DESC, updated_at DESC, id DESC)`. `id` is not there
 * for ordering anyone cares about — it is there because two conversations can
 * share a millisecond, and a cursor over a non-unique key either loops or drops
 * rows.
 */

/** One page's worth. Tuned to overfill a phone screen so the first page never leaves a gap. */
export const DEFAULT_PAGE_SIZE = 40;

/**
 * Where the previous page stopped: the sort key of its last row.
 *
 * Not an index into the result set, so rows arriving or being edited between
 * pages cannot shift it.
 */
export interface ListCursor {
  pinned: boolean;
  updatedAt: number;
  id: string;
}

export interface ListQueryOptions {
  archived?: boolean;
  tag?: string;
  profileId?: string;
  /** Only this project's conversations. `null` means only the ones in no project. */
  projectId?: string | null;
  limit?: number;
  /** Omit or pass `null` for the first page. */
  after?: ListCursor | null;
}

export interface SqlQuery {
  sql: string;
  params: (string | number)[];
}

/** The projection is shared with {@link buildListQuery} so a test can assert on either. */
const SELECT_LIST = `SELECT c.*,
       (SELECT group_concat(tag, char(1)) FROM conversation_tags WHERE conversation_id = c.id) AS tags,
       (SELECT count(*) FROM messages WHERE conversation_id = c.id AND hidden = 0) AS message_count
  FROM conversations c`;

/** The one true ordering. Every clause that pages over this list has to agree with it. */
export const LIST_ORDER = 'ORDER BY c.pinned DESC, c.updated_at DESC, c.id DESC';

/**
 * The list query and its parameters.
 *
 * Tags and message counts are correlated subqueries rather than joins, so a
 * conversation with three tags stays one row and the outer loop can still be
 * driven by `conversations_list`.
 */
export function buildListQuery(options: ListQueryOptions = {}): SqlQuery {
  const where: string[] = ['c.archived = ?'];
  const params: (string | number)[] = [options.archived ? 1 : 0];

  if (options.profileId) {
    where.push('c.profile_id = ?');
    params.push(options.profileId);
  }
  if (options.tag) {
    where.push('EXISTS (SELECT 1 FROM conversation_tags t WHERE t.conversation_id = c.id AND t.tag = ?)');
    params.push(options.tag);
  }
  // `null` is a filter, not "no filter": the main list wants the chats that are in no
  // project, so an absent key and an explicit null cannot mean the same thing.
  if (options.projectId !== undefined) {
    if (options.projectId === null) {
      where.push('c.project_id IS NULL');
    } else {
      where.push('c.project_id = ?');
      params.push(options.projectId);
    }
  }
  if (options.after) {
    // A row-value comparison rather than the expanded `a < ? OR (a = ? AND …)`
    // nest: SQLite turns the row-value form into a range constraint on
    // `conversations_list` and seeks straight to the cursor, whereas the OR nest
    // is opaque to the planner and scans from the top of the index every page.
    where.push('(c.pinned, c.updated_at, c.id) < (?, ?, ?)');
    params.push(options.after.pinned ? 1 : 0, options.after.updatedAt, options.after.id);
  }

  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE_SIZE));
  params.push(limit);

  return {
    sql: `${SELECT_LIST}
 WHERE ${where.join(' AND ')}
 ${LIST_ORDER}
 LIMIT ?`,
    params,
  };
}

/**
 * The cursor for the page after `rows`, or `null` when the page was the last one.
 *
 * A short page means the end of the list: asking for one more row to be sure
 * would double the queries to save one.
 */
export function nextCursor<T extends ListCursor>(rows: readonly T[], limit: number): ListCursor | null {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1];
  if (!last) return null;
  return { pinned: last.pinned, updatedAt: last.updatedAt, id: last.id };
}
