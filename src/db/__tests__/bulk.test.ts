/**
 * Bulk operations on the conversation list, against real SQLite.
 *
 * The thing under test is not "does `DELETE` delete". It is the **blast radius**
 * of a bulk delete, which is decided by the schema rather than by the statement:
 * `messages` and `conversation_tags` cascade away with their conversation,
 * `usage_events` deliberately do not, and `messages_fts` only stays in step
 * because a trigger fires on the cascaded delete. Those three facts are what a
 * user is trusting when they select fifty rows and confirm, and none of them is
 * visible from reading `deleteConversationsSql`.
 *
 * Everything here runs the SQL the app ships — `@/db/bulk` and `@/db/ddl` import
 * nothing from `expo-sqlite`, which is what makes that possible. A test with its
 * own copy of the DDL would prove that the copy cascades correctly.
 */

import { DatabaseSync } from 'node:sqlite';

import {
  addTagSql,
  BULK_CHUNK,
  chunk,
  clearTagsSql,
  deleteConversationsSql,
  normaliseIds,
  placeholders,
  removeTagSql,
  setArchivedSql,
} from '@/db/bulk';
import { FTS_DDL, MIGRATIONS } from '@/db/ddl';

interface CountRow {
  n: number;
}

function build(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // Load-bearing, and the single most important line in this file: without it
  // SQLite parses `ON DELETE CASCADE` and then ignores it, so every assertion
  // about messages disappearing would pass for the wrong reason on a device
  // where the app forgot the pragma. The app sets it at open time.
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of MIGRATIONS) db.exec(migration);
  db.exec(FTS_DDL);
  return db;
}

function count(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  return (db.prepare(sql).get(...params) as CountRow).n;
}

/**
 * `n` conversations, each with two messages, one tag and one usage event.
 *
 * Every row type that references a conversation is represented, because the
 * point of the test is which of them survive.
 */
function seed(db: DatabaseSync, n: number, prefix = 'c'): string[] {
  const ids: string[] = [];
  const conversation = db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at, profile_id, model, archived, pinned)
     VALUES (?, ?, ?, ?, 'p1', 'claude-opus-5', ?, ?)`,
  );
  const message = db.prepare(
    `INSERT INTO messages (id, conversation_id, seq, role, created_at, content, text)
     VALUES (?, ?, ?, ?, ?, '[]', ?)`,
  );
  const tag = db.prepare('INSERT INTO conversation_tags (conversation_id, tag) VALUES (?, ?)');
  const usage = db.prepare(
    `INSERT INTO usage_events (at, day, profile_id, model, input, output, cost, conversation_id)
     VALUES (?, '2026-08-30', 'p1', 'claude-opus-5', 100, 200, 0.5, ?)`,
  );

  for (let i = 0; i < n; i += 1) {
    const id = `${prefix}${i}`;
    ids.push(id);
    conversation.run(id, `Thread ${i}`, 1000 + i, 1000 + i, i % 5 === 0 ? 1 : 0, i % 7 === 0 ? 1 : 0);
    message.run(`${id}-m1`, id, 1, 'user', 1000 + i, `question number ${i} about kestrels`);
    message.run(`${id}-m2`, id, 2, 'assistant', 1001 + i, `answer number ${i} about kestrels`);
    tag.run(id, i % 2 === 0 ? 'work' : 'drafts');
    usage.run(1000 + i, id);
  }
  return ids;
}

describe('the pure SQL builders', () => {
  it('chunks to a size SQLite can bind in one statement', () => {
    // The ceiling this exists for is SQLITE_MAX_VARIABLE_NUMBER, which is 999 on
    // older builds. Leaving headroom because callers bind their own parameters
    // alongside the id list.
    expect(BULK_CHUNK).toBeLessThan(999 - 8);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('produces no chunks at all for an empty selection', () => {
    // So a caller that loops over the result issues zero statements, rather than
    // one statement with an empty IN list — which is a syntax error.
    expect(chunk([])).toEqual([]);
  });

  it('refuses a chunk size or placeholder count that cannot mean anything', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => placeholders(0)).toThrow(RangeError);
  });

  it('binds ids as placeholders rather than interpolating them', () => {
    expect(placeholders(3)).toBe('?, ?, ?');
    expect(deleteConversationsSql(2)).toContain('IN (?, ?)');
    expect(deleteConversationsSql(2)).not.toMatch(/'/);
  });

  it('de-duplicates and drops blanks while keeping first-seen order', () => {
    expect(normaliseIds([' a ', 'b', 'a', '', '   ', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });
});

describe('deleting many conversations', () => {
  it('takes their messages and tags with them', () => {
    const db = build();
    const ids = seed(db, 10);
    const doomed = ids.slice(0, 6);

    db.prepare(deleteConversationsSql(doomed.length)).run(...doomed);

    expect(count(db, 'SELECT count(*) AS n FROM conversations')).toBe(4);
    expect(count(db, 'SELECT count(*) AS n FROM messages')).toBe(8);
    expect(count(db, 'SELECT count(*) AS n FROM conversation_tags')).toBe(4);
  });

  it('leaves usage events standing, because spend already happened', () => {
    // The asymmetry the whole feature rests on. `usage_events.conversation_id` is
    // a plain column, not a foreign key, so tidying up the list cannot make the
    // usage dashboard disagree with what was actually billed.
    const db = build();
    const ids = seed(db, 10);
    db.prepare(deleteConversationsSql(ids.length)).run(...ids);

    expect(count(db, 'SELECT count(*) AS n FROM conversations')).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM messages')).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM usage_events')).toBe(10);
    // And the totals the dashboard reads are unchanged.
    const totals = db.prepare('SELECT sum(input) + sum(output) AS n FROM usage_events').get() as CountRow;
    expect(totals.n).toBe(3000);
  });

  it('removes the deleted messages from the full-text index', () => {
    // Via the AFTER DELETE trigger, firing on rows deleted by the *cascade*
    // rather than by the statement. If it did not, a search would keep returning
    // hits pointing at conversations that no longer exist.
    const db = build();
    const ids = seed(db, 6);
    expect(count(db, `SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'kestrels'`)).toBe(12);

    db.prepare(deleteConversationsSql(3)).run(...ids.slice(0, 3));

    expect(count(db, `SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'kestrels'`)).toBe(6);
    // And the index still agrees with the content table, which is the check the
    // app runs at boot.
    expect(() =>
      db.exec(`INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)`),
    ).not.toThrow();
  });

  it('deletes fifty conversations as one transaction, or not at all', () => {
    // The requirement in its own words. The rollback is what is being tested: a
    // partial delete has no undo and no way for the user to say which half went,
    // so the only acceptable outcomes are all and nothing.
    const db = build();
    const ids = seed(db, 50);
    expect(count(db, 'SELECT count(*) AS n FROM messages')).toBe(100);

    db.exec('BEGIN');
    for (const batch of chunk(ids, 20)) {
      db.prepare(deleteConversationsSql(batch.length)).run(...batch);
    }
    db.exec('ROLLBACK');

    expect(count(db, 'SELECT count(*) AS n FROM conversations')).toBe(50);
    expect(count(db, 'SELECT count(*) AS n FROM messages')).toBe(100);

    db.exec('BEGIN');
    for (const batch of chunk(ids, 20)) {
      db.prepare(deleteConversationsSql(batch.length)).run(...batch);
    }
    db.exec('COMMIT');

    expect(count(db, 'SELECT count(*) AS n FROM conversations')).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM usage_events')).toBe(50);
  });

  it('reports how many rows it removed, not how many were asked for', () => {
    // A selection is made against a list that can be a few seconds stale, so an
    // id that no longer exists is normal rather than an error — but the number
    // shown afterwards has to be the truth.
    const db = build();
    const ids = seed(db, 3);
    const result = db.prepare(deleteConversationsSql(4)).run(...ids, 'never-existed');
    expect(Number(result.changes)).toBe(3);
  });
});

describe('archiving many conversations', () => {
  it('counts only the rows that actually moved', () => {
    const db = build();
    const ids = seed(db, 10);
    // The seed archives every fifth row: c0 and c5.
    expect(count(db, 'SELECT count(*) AS n FROM conversations WHERE archived = 1')).toBe(2);

    const result = db.prepare(setArchivedSql(ids.length)).run(1, 1, ...ids);
    expect(Number(result.changes)).toBe(8);
    expect(count(db, 'SELECT count(*) AS n FROM conversations WHERE archived = 1')).toBe(10);

    // Running it again moves nothing, and says so.
    expect(Number(db.prepare(setArchivedSql(ids.length)).run(1, 1, ...ids).changes)).toBe(0);
  });

  it('leaves updated_at alone, so the archive is not reordered by tidying up', () => {
    const db = build();
    const ids = seed(db, 4);
    const before = db.prepare('SELECT id, updated_at FROM conversations ORDER BY id').all();
    db.prepare(setArchivedSql(ids.length)).run(1, 1, ...ids);
    expect(db.prepare('SELECT id, updated_at FROM conversations ORDER BY id').all()).toEqual(before);
  });
});

describe('retagging many conversations', () => {
  it('adds a tag without disturbing the ones already there', () => {
    const db = build();
    const ids = seed(db, 4);
    db.prepare(addTagSql(ids.length)).run('urgent', ...ids);

    expect(count(db, `SELECT count(*) AS n FROM conversation_tags WHERE tag = 'urgent'`)).toBe(4);
    expect(count(db, `SELECT count(*) AS n FROM conversation_tags WHERE tag = 'work'`)).toBe(2);
    expect(count(db, `SELECT count(*) AS n FROM conversation_tags WHERE tag = 'drafts'`)).toBe(2);
  });

  it('treats adding the same tag twice as a no-op rather than an error', () => {
    const db = build();
    const ids = seed(db, 4);
    db.prepare(addTagSql(ids.length)).run('urgent', ...ids);
    expect(() => db.prepare(addTagSql(ids.length)).run('urgent', ...ids)).not.toThrow();
    expect(count(db, `SELECT count(*) AS n FROM conversation_tags WHERE tag = 'urgent'`)).toBe(4);
  });

  it('ignores ids that are not conversations', () => {
    // `addTagSql` inserts from a SELECT over `conversations`, so a stale id
    // contributes no row — rather than inserting a tag against a conversation
    // that does not exist, which the foreign key would reject and which would
    // take the whole transaction with it.
    const db = build();
    const ids = seed(db, 2);
    expect(() => db.prepare(addTagSql(3)).run('urgent', ...ids, 'never-existed')).not.toThrow();
    expect(count(db, `SELECT count(*) AS n FROM conversation_tags WHERE tag = 'urgent'`)).toBe(2);
  });

  it('removes one tag and leaves the rest', () => {
    const db = build();
    const ids = seed(db, 4);
    db.prepare(addTagSql(ids.length)).run('urgent', ...ids);
    db.prepare(removeTagSql(ids.length)).run('urgent', ...ids);

    expect(count(db, `SELECT count(*) AS n FROM conversation_tags WHERE tag = 'urgent'`)).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM conversation_tags')).toBe(4);
  });

  it('clears every tag on the selection and nothing outside it', () => {
    const db = build();
    const ids = seed(db, 6);
    db.prepare(clearTagsSql(3)).run(...ids.slice(0, 3));

    expect(count(db, 'SELECT count(*) AS n FROM conversation_tags')).toBe(3);
    expect(count(db, 'SELECT count(*) AS n FROM conversations')).toBe(6);
  });
});
