/**
 * The search index's drift check.
 *
 * The app rebuilds the FTS index at startup when it no longer matches the
 * `messages` table. What "no longer matches" means used to be "has a different
 * number of rows" (debt D-03), which is a weaker claim than it looks: an edit
 * that changes a message's text while the update trigger is absent leaves the
 * counts identical and the index wrong, so search keeps matching words that are
 * no longer in the message and misses the ones that are.
 *
 * This test reproduces exactly that shape of damage and asserts that FTS5's own
 * `integrity-check` catches what counting could not.
 */

import { DatabaseSync } from 'node:sqlite';

import { FTS_DDL, MIGRATIONS } from '@/db/ddl';

function migrated(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const migration of MIGRATIONS) db.exec(migration);
  db.exec(FTS_DDL);
  db.exec(
    `INSERT INTO conversations (id, title, created_at, updated_at, profile_id, model)
     VALUES ('c1', 'Test', 0, 0, 'p1', 'claude-opus-5')`,
  );
  return db;
}

function addMessage(db: DatabaseSync, id: string, seq: number, text: string): void {
  db.prepare(
    `INSERT INTO messages (id, conversation_id, seq, role, created_at, content, text)
     VALUES (?, 'c1', ?, 'user', 0, ?, ?)`,
  ).run(id, seq, JSON.stringify([{ type: 'text', text }]), text);
}

/** The check the app runs. `rank = 1` is what makes it compare against `messages`. */
function integrityCheck(db: DatabaseSync): boolean {
  try {
    db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)");
    return true;
  } catch {
    return false;
  }
}

/** The form without the argument, kept only to document what it fails to notice. */
function bareIntegrityCheck(db: DatabaseSync): boolean {
  try {
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')");
    return true;
  } catch {
    return false;
  }
}

function search(db: DatabaseSync, term: string): string[] {
  return (
    db
      .prepare(
        `SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
          WHERE messages_fts MATCH ? ORDER BY m.seq`,
      )
      .all(term) as { id: string }[]
  ).map((r) => r.id);
}

function counts(db: DatabaseSync): { indexed: number; stored: number } {
  const indexed = (db.prepare('SELECT count(*) AS n FROM messages_fts').get() as { n: number }).n;
  const stored = (db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n;
  return { indexed, stored };
}

describe('the FTS index', () => {
  it('is consistent after ordinary writes', () => {
    const db = migrated();
    addMessage(db, 'm1', 1, 'the quick brown fox');
    addMessage(db, 'm2', 2, 'lazy dog');
    db.prepare("UPDATE messages SET text = 'a sleeping dog' WHERE id = 'm2'").run();
    db.prepare("DELETE FROM messages WHERE id = 'm1'").run();

    expect(integrityCheck(db)).toBe(true);
    expect(search(db, 'sleeping')).toEqual(['m2']);
    db.close();
  });

  it('reports drift that row counts cannot see', () => {
    const db = migrated();
    addMessage(db, 'm1', 1, 'the quick brown fox');

    // The damage a missing trigger does: the row is still there, still one row,
    // and the index still describes what it used to say.
    db.exec('DROP TRIGGER messages_fts_update');
    db.prepare("UPDATE messages SET text = 'a slow green turtle' WHERE id = 'm1'").run();

    const { indexed, stored } = counts(db);
    expect(indexed).toBe(stored);
    expect(integrityCheck(db)).toBe(false);

    // Both of the weaker checks pass here, which is why neither is what the app
    // runs: counting sees one row and one row, and a bare `integrity-check` sees
    // an index that is internally immaculate — it is a correct index of what the
    // message used to say.
    expect(bareIntegrityCheck(db)).toBe(true);

    // And the user-visible symptom the check exists to prevent.
    expect(search(db, 'turtle')).toEqual([]);
    expect(search(db, 'fox')).toEqual(['m1']);
    db.close();
  });

  it('is repaired by a rebuild', () => {
    const db = migrated();
    addMessage(db, 'm1', 1, 'the quick brown fox');
    db.exec('DROP TRIGGER messages_fts_update');
    db.prepare("UPDATE messages SET text = 'a slow green turtle' WHERE id = 'm1'").run();

    db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");

    expect(integrityCheck(db)).toBe(true);
    expect(search(db, 'turtle')).toEqual(['m1']);
    expect(search(db, 'fox')).toEqual([]);
    db.close();
  });
});
