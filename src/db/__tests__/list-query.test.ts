/**
 * Planner assertions for the conversation list.
 *
 * These build a real database from the shipped DDL using Node's built-in
 * `node:sqlite` and ask SQLite what it intends to do. That matters because the
 * things Phase 2 promises here — a list that opens in well under half a second
 * at 500 conversations, paging that costs the same on page 12 as on page 1 — are
 * not properties of the SQL text. They are properties of the plan the SQL text
 * produces, and the plan changes silently when an index loses a column.
 *
 * `expo-sqlite` is not importable under Jest's node environment, hence the DDL
 * and the query builder living in modules that do not import it.
 */

import { DatabaseSync } from 'node:sqlite';

import { FTS_DDL, MIGRATIONS, SCHEMA_VERSION } from '@/db/ddl';
import { buildListQuery, DEFAULT_PAGE_SIZE, nextCursor } from '@/db/list-query';
import type { ListCursor } from '@/db/list-query';

interface Row {
  id: string;
  pinned: number;
  updated_at: number;
}

function migrated(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of MIGRATIONS) db.exec(migration);
  db.exec(FTS_DDL);
  return db;
}

/** `n` conversations, deliberately including ties on `updated_at`. */
function seed(db: DatabaseSync, n: number): void {
  const insert = db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at, pinned, archived, profile_id, model, preview)
     VALUES (?, ?, ?, ?, ?, ?, 'p1', 'claude-opus-5', ?)`,
  );
  db.exec('BEGIN');
  for (let i = 0; i < n; i += 1) {
    // Every third conversation shares a timestamp with its neighbour, so a
    // cursor that only knows `updated_at` will visibly loop or skip.
    const updatedAt = 1_700_000_000_000 + Math.floor(i / 3) * 1000;
    insert.run(`c${String(i).padStart(4, '0')}`, `Conversation ${i}`, updatedAt, updatedAt, i % 7 === 0 ? 1 : 0, i % 11 === 0 ? 1 : 0, `preview ${i}`);
  }
  db.exec('COMMIT');
}

function plan(db: DatabaseSync, sql: string, params: readonly (string | number)[]): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
  return rows.map((r) => r.detail).join('\n');
}

/** Pages through the whole list with the real query, returning ids in order. */
function pageThrough(db: DatabaseSync, limit: number): string[] {
  const ids: string[] = [];
  let cursor: ListCursor | null = null;
  let pages = 0;
  for (;;) {
    const { sql, params } = buildListQuery({ limit, after: cursor });
    const rows = db.prepare(sql).all(...params) as unknown as Row[];
    ids.push(...rows.map((r) => r.id));
    cursor = nextCursor(
      rows.map((r) => ({ id: r.id, pinned: r.pinned === 1, updatedAt: r.updated_at })),
      limit,
    );
    pages += 1;
    if (!cursor) break;
    // A guard rather than a `while (true)`: the failure mode of a broken cursor
    // is an endless loop, and a test that hangs tells you much less than one
    // that fails.
    expect(pages).toBeLessThan(200);
  }
  return ids;
}

describe('the shipped schema', () => {
  it('has one migration per version', () => {
    expect(MIGRATIONS).toHaveLength(SCHEMA_VERSION);
  });

  it('replaces the pinned-first index with the archived-first one', () => {
    const db = migrated();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(names).toContain('conversations_list');
    expect(names).not.toContain('conversations_order');
    db.close();
  });
});

describe('the list query plan', () => {
  it('drives the outer loop from conversations_list', () => {
    const db = migrated();
    seed(db, 500);
    db.exec('ANALYZE');
    const { sql, params } = buildListQuery({});
    const detail = plan(db, sql, params);
    expect(detail).toMatch(/SEARCH c USING INDEX conversations_list/);
    db.close();
  });

  it('does not sort — the index spells out the whole ORDER BY', () => {
    const db = migrated();
    seed(db, 500);
    db.exec('ANALYZE');
    for (const options of [{}, { archived: true }, { after: { pinned: false, updatedAt: 1_700_000_100_000, id: 'c0100' } }]) {
      const { sql, params } = buildListQuery(options);
      // A TEMP B-TREE here means SQLite is materialising the whole filtered set
      // and sorting it on every page, which is the exact cost keyset paging
      // exists to avoid.
      expect(plan(db, sql, params)).not.toMatch(/TEMP B-TREE/);
    }
    db.close();
  });

  it('seeks to the cursor rather than scanning from the top', () => {
    const db = migrated();
    seed(db, 500);
    db.exec('ANALYZE');
    const { sql, params } = buildListQuery({ after: { pinned: false, updatedAt: 1_700_000_100_000, id: 'c0100' } });
    // The row value appearing *inside* the index's constraint list is SQLite
    // reporting a range seek: it starts at the cursor. If the optimisation ever
    // stops applying, the comparison moves out of the parentheses and becomes a
    // filter over a full scan of the index — same answer, cost proportional to
    // how far down the list the user has paged.
    expect(plan(db, sql, params)).toMatch(
      /SEARCH c USING INDEX conversations_list \(archived=\? AND \(pinned,updated_at,id\)<\(\?,\?,\?\)\)/,
    );
    db.close();
  });

  it('never emits OFFSET', () => {
    for (const options of [{}, { limit: 10 }, { after: { pinned: true, updatedAt: 1, id: 'x' } }, { tag: 'work' }]) {
      expect(buildListQuery(options).sql).not.toMatch(/OFFSET/i);
    }
  });
});

describe('paging with a cursor', () => {
  it('visits every unarchived conversation exactly once, in list order', () => {
    const db = migrated();
    seed(db, 500);

    const expected = (
      db
        .prepare('SELECT id FROM conversations WHERE archived = 0 ORDER BY pinned DESC, updated_at DESC, id DESC')
        .all() as { id: string }[]
    ).map((r) => r.id);

    const paged = pageThrough(db, 40);
    expect(paged).toEqual(expected);
    expect(new Set(paged).size).toBe(paged.length);
    db.close();
  });

  it('agrees with itself at any page size', () => {
    const db = migrated();
    seed(db, 137);
    const byOne = pageThrough(db, 1);
    expect(pageThrough(db, 40)).toEqual(byOne);
    expect(pageThrough(db, 500)).toEqual(byOne);
    db.close();
  });

  it('opens 500 conversations well inside the 400 ms budget', () => {
    const db = migrated();
    seed(db, 500);
    db.exec('ANALYZE');

    const { sql, params } = buildListQuery({});
    const statement = db.prepare(sql);
    const started = performance.now();
    const rows = statement.all(...params) as unknown as Row[];
    const elapsed = performance.now() - started;

    expect(rows).toHaveLength(DEFAULT_PAGE_SIZE);
    // Generous by two orders of magnitude on purpose. This is a regression guard
    // against a plan that starts sorting or scanning, not a benchmark: the real
    // device number is a manual gate, and CI runners are too noisy for a tight
    // bound to mean anything.
    expect(elapsed).toBeLessThan(200);
    db.close();
  });

  it('stops at the end of the list rather than repeating the last page', () => {
    const db = migrated();
    seed(db, 5);
    const { sql, params } = buildListQuery({ limit: 40 });
    const rows = db.prepare(sql).all(...params) as unknown as Row[];
    expect(nextCursor(rows.map((r) => ({ id: r.id, pinned: r.pinned === 1, updatedAt: r.updated_at })), 40)).toBeNull();
    db.close();
  });
});
