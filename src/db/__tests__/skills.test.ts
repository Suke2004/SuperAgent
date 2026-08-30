/**
 * The skills table, against real SQLite.
 *
 * The migration is what is worth testing rather than the CRUD: a user upgrading
 * into this build runs step 4 against a database that already holds their
 * conversations, and the unique index on `name` is the one thing the store relies
 * on SQL for — `ConversationConfig.skills` stores names, so two skills answering to
 * one name would make an enabled toggle ambiguous.
 */

import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS, SCHEMA_VERSION } from '@/db/ddl';

/** The version whose step creates the skills table. */
const SKILLS_VERSION = 4;

function migrated(upTo: number = MIGRATIONS.length): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of MIGRATIONS.slice(0, upTo)) db.exec(migration);
  return db;
}

function insert(db: DatabaseSync, id: string, name: string): void {
  db.prepare(
    'INSERT INTO skills (id, created_at, updated_at, name, description, body) VALUES (?, 1, 1, ?, ?, ?)',
  ).run(id, name, `Does ${name}.`, 'Instructions.');
}

describe('the skills migration', () => {
  it('is a step in the chain, and the chain matches the recorded version', () => {
    expect(MIGRATIONS).toHaveLength(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(SKILLS_VERSION);
  });

  it('adds the table to a database that already holds conversations', () => {
    const db = migrated(SKILLS_VERSION - 1);
    db.exec(
      `INSERT INTO conversations (id, title, created_at, updated_at, profile_id, model)
       VALUES ('c1', 'Existing work', 100, 100, 'p1', 'claude-opus-5')`,
    );
    expect(() => db.exec(MIGRATIONS[SKILLS_VERSION - 1] as string)).not.toThrow();

    insert(db, 'skl_1', 'pdf-processing');
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversations').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM skills').get()).toEqual({ n: 1 });
    db.close();
  });

  it('is idempotent, so a half-applied upgrade can be retried', () => {
    const db = migrated();
    expect(() => db.exec(MIGRATIONS[SKILLS_VERSION - 1] as string)).not.toThrow();
    db.close();
  });

  it('refuses a second skill under the same name', () => {
    const db = migrated();
    insert(db, 'skl_1', 'review');
    expect(() => insert(db, 'skl_2', 'review')).toThrow();
    db.close();
  });
});
