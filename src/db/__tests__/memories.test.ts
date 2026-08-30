/**
 * The memories table, against real SQLite.
 *
 * Two things here are worth a test rather than a reading of the DDL.
 *
 * The first is the migration chain. A user upgrading into this build runs
 * migration 3 against a database that already has conversations and messages in
 * it, and a migration that only works on an empty file is a migration that only
 * works in development.
 *
 * The second is the UPSERT. Deduplication is enforced in two places — Jaccard
 * folding in `@/chat/memory` catches rewordings, and `(kind, text)` uniqueness
 * catches the exact restatement that folding is not needed for. The second is the
 * one that has to hold under concurrency, because two distillation passes from two
 * conversations can produce the identical sentence, and the failure mode is either
 * a crashed write or two rows saying the same thing forever.
 */

import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS, SCHEMA_VERSION } from '@/db/ddl';

interface CountRow {
  n: number;
}

interface MemoryRow {
  id: string;
  kind: string;
  text: string;
  hits: number;
  pinned: number;
  updated_at: number;
  source_conversation_id: string | null;
}

/** Applies the chain the way the app does: one statement block per version step. */
function migrated(upTo: number = MIGRATIONS.length): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of MIGRATIONS.slice(0, upTo)) db.exec(migration);
  return db;
}

function seedConversation(db: DatabaseSync, id: string): void {
  db.exec(
    `INSERT INTO conversations (id, title, created_at, updated_at, profile_id, model)
     VALUES ('${id}', 'Existing work', 100, 100, 'p1', 'claude-opus-5')`,
  );
}

const UPSERT = `
  INSERT INTO memories (id, created_at, updated_at, kind, text, source_conversation_id, hits, pinned)
  VALUES (?, ?, ?, ?, ?, ?, 1, 0)
  ON CONFLICT (kind, text) DO UPDATE SET hits = hits + 1, updated_at = excluded.updated_at
`;

function upsert(db: DatabaseSync, id: string, kind: string, text: string, at: number, source?: string): void {
  db.prepare(UPSERT).run(id, at, at, kind, text, source ?? null);
}

function rows(db: DatabaseSync): MemoryRow[] {
  return db.prepare('SELECT * FROM memories ORDER BY id').all() as unknown as MemoryRow[];
}

/** The version whose step creates the memories table. Later steps append after it. */
const MEMORY_VERSION = 3;

describe('the memory migration', () => {
  it('is a step in the chain, and the chain matches the recorded version', () => {
    expect(MIGRATIONS).toHaveLength(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(MEMORY_VERSION);
  });

  it('adds the table to a database that already holds conversations', () => {
    // Stop one version short, put data in, then upgrade — the real path.
    const db = migrated(MEMORY_VERSION - 1);
    seedConversation(db, 'c1');
    expect(() => db.exec(MIGRATIONS[MEMORY_VERSION - 1] as string)).not.toThrow();

    const kept = db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as unknown as CountRow;
    expect(kept.n).toBe(1);
    upsert(db, 'm1', 'fact', 'runs Postgres 16', 1_000, 'c1');
    expect(rows(db)).toHaveLength(1);
    db.close();
  });

  it('is idempotent, so a half-applied upgrade can be retried', () => {
    const db = migrated();
    expect(() => db.exec(MIGRATIONS[MEMORY_VERSION - 1] as string)).not.toThrow();
    db.close();
  });

  it('uses its ranking index rather than sorting the whole table', () => {
    const db = migrated();
    for (let i = 0; i < 200; i += 1) upsert(db, `m${i}`, 'fact', `fact number ${i}`, 1_000 + i);

    const plan = (
      db
        .prepare('EXPLAIN QUERY PLAN SELECT * FROM memories ORDER BY pinned DESC, hits DESC, updated_at DESC')
        .all() as unknown as { detail: string }[]
    )
      .map((r) => r.detail)
      .join('\n');

    expect(plan).toContain('memories_rank');
    expect(plan).not.toContain('TEMP B-TREE');
    db.close();
  });
});

describe('remembering the same thing twice', () => {
  it('bumps the hit count instead of adding a row', () => {
    const db = migrated();
    upsert(db, 'm1', 'preference', 'prefers TypeScript over JavaScript', 1_000);
    upsert(db, 'm2', 'preference', 'prefers TypeScript over JavaScript', 2_000);
    upsert(db, 'm3', 'preference', 'prefers TypeScript over JavaScript', 3_000);

    const all = rows(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe('m1'); // The first id wins; the row is the same memory.
    expect(all[0]?.hits).toBe(3);
    expect(all[0]?.updated_at).toBe(3_000); // Recency follows the restatement.
    db.close();
  });

  it('keeps the same sentence under two kinds as two memories', () => {
    const db = migrated();
    upsert(db, 'm1', 'style', 'writes terse commit messages', 1_000);
    upsert(db, 'm2', 'fact', 'writes terse commit messages', 1_000);
    expect(rows(db)).toHaveLength(2);
    db.close();
  });

  it('does not reset a pin when the memory is restated', () => {
    const db = migrated();
    upsert(db, 'm1', 'fact', 'runs Postgres 16', 1_000);
    db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run('m1');
    upsert(db, 'm2', 'fact', 'runs Postgres 16', 2_000);
    expect(rows(db)[0]?.pinned).toBe(1);
    db.close();
  });
});

describe('the source conversation reference', () => {
  it('survives deleting the conversation it came from', () => {
    // Deliberately not a foreign key: a memory outliving its conversation is the
    // whole point of the feature, and ON DELETE CASCADE here would mean clearing
    // history silently rewrites what the app knows about the user.
    const db = migrated();
    seedConversation(db, 'c1');
    upsert(db, 'm1', 'fact', 'deploys from a laptop', 1_000, 'c1');
    db.prepare('DELETE FROM conversations WHERE id = ?').run('c1');

    const all = rows(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.source_conversation_id).toBe('c1');
    db.close();
  });
});

describe('forgetting everything', () => {
  it('removes every memory and leaves conversations alone', () => {
    const db = migrated();
    seedConversation(db, 'c1');
    for (let i = 0; i < 25; i += 1) upsert(db, `m${i}`, 'fact', `fact number ${i}`, 1_000 + i, 'c1');

    const before = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as unknown as CountRow;
    expect(before.n).toBe(25);

    db.exec('BEGIN');
    db.exec('DELETE FROM memories');
    db.exec('COMMIT');

    const after = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as unknown as CountRow;
    const conversations = db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as unknown as CountRow;
    expect(after.n).toBe(0);
    expect(conversations.n).toBe(1);
    db.close();
  });
});
