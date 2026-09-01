/**
 * Regenerate keeps the old answer.
 *
 * The claim is not "a column exists" but the three things that make the feature
 * safe, against a real database built from the shipped migrations:
 *
 *   1. The transcript shows exactly one variant, so the request builder — which
 *      reads the same rows — cannot send two answers to one question.
 *   2. Paging a reply away takes its `tool_result` rows with it. A variant that
 *      lost them would leave a `tool_use` unanswered, and every later request
 *      built from that history is rejected outright.
 *   3. The earlier attempt is still there afterwards, which is the whole point.
 */

import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS } from '@/db/ddl';
import {
  ANCHOR_SLOT_SQL,
  DROP_HIDDEN_SQL,
  HIDE_TURN_SQL,
  LIST_TURNS_SQL,
  NEWEST_SLOT_SQL,
  SELECT_TURN_SQL,
  stampTurnSql,
} from '@/db/variants';

function migrated(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const migration of MIGRATIONS) db.exec(migration);
  db.exec(
    `INSERT INTO conversations (id, title, created_at, updated_at, profile_id, model)
     VALUES ('c1', 'Test', 0, 0, 'p1', 'claude-opus-5')`,
  );
  return db;
}

function add(db: DatabaseSync, id: string, seq: number, role: string, text: string): void {
  db.prepare(
    `INSERT INTO messages (id, conversation_id, seq, role, created_at, content, text)
     VALUES (?, 'c1', ?, ?, 0, ?, ?)`,
  ).run(id, seq, role, JSON.stringify([{ type: 'text', text }]), text);
}

/** What `listMessages` returns. */
function transcript(db: DatabaseSync): string[] {
  return (
    db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND hidden = 0 ORDER BY seq ASC').all('c1') as {
      id: string;
    }[]
  ).map((r) => r.id);
}

function variants(db: DatabaseSync): { turnId: string; hidden: number }[] {
  const slot = db.prepare(NEWEST_SLOT_SQL).get('c1') as { answersId: string } | undefined;
  if (!slot) return [];
  const rows = db.prepare(LIST_TURNS_SQL).all('c1', slot.answersId) as { turnId: string; hidden: number }[];
  return rows.map(({ turnId, hidden }) => ({ turnId, hidden }));
}

/** The store's `setTurnAside`, without `expo-sqlite`. */
function setAside(db: DatabaseSync, seq: number, inclusive: boolean, answersId: string, turnId: string): void {
  db.prepare(stampTurnSql(inclusive)).run(turnId, answersId, 'c1', seq);
  db.prepare(HIDE_TURN_SQL).run('c1', turnId);
  db.prepare(ANCHOR_SLOT_SQL).run(answersId, 'c1', answersId);
}

describe('reply variants', () => {
  it('keeps the replaced answer and shows only the new one', () => {
    const db = migrated();
    add(db, 'u1', 1, 'user', 'What is 2 + 2?');
    add(db, 'a1', 2, 'assistant', 'Four.');

    setAside(db, 2, true, 'u1', 'turn_a');
    expect(transcript(db)).toEqual(['u1']);

    // The regenerated pass, written by `appendMessage` with the grouping columns.
    db.prepare(
      `INSERT INTO messages (id, conversation_id, seq, role, created_at, content, text, turn_id, answers_id)
       VALUES ('a2', 'c1', 3, 'assistant', 0, '[]', 'It is four.', 'turn_b', 'u1')`,
    ).run();

    expect(transcript(db)).toEqual(['u1', 'a2']);
    expect(variants(db)).toEqual([
      { turnId: 'turn_a', hidden: 1 },
      { turnId: 'turn_b', hidden: 0 },
    ]);

    // Back to the first answer, and the second is what is now set aside.
    db.prepare(SELECT_TURN_SQL).run('turn_a', 'c1', 'u1');
    expect(transcript(db)).toEqual(['u1', 'a1']);

    db.close();
  });

  it('takes the whole generation pass, tool rows included', () => {
    const db = migrated();
    add(db, 'u1', 1, 'user', 'Run this');
    add(db, 'a1', 2, 'assistant', 'Calling the tool');
    add(db, 'r1', 3, 'user', 'tool output'); // a tool_result row: role user, not a question
    add(db, 'a2', 4, 'assistant', 'The answer is 4');

    setAside(db, 2, true, 'u1', 'turn_a');

    // All four of the pass's rows left together — a transcript ending in `a1` with
    // no results would poison every later request.
    expect(transcript(db)).toEqual(['u1']);
    expect(variants(db)).toEqual([{ turnId: 'turn_a', hidden: 1 }]);

    db.close();
  });

  it('does not re-stamp an existing variant when regenerating again', () => {
    const db = migrated();
    add(db, 'u1', 1, 'user', 'Again');
    add(db, 'a1', 2, 'assistant', 'First');
    setAside(db, 2, true, 'u1', 'turn_a');
    add(db, 'a2', 3, 'assistant', 'Second');
    setAside(db, 3, true, 'u1', 'turn_b');

    // Two distinct attempts, not one merged group: `stampTurnSql` only labels
    // visible rows, so the first variant kept its own id.
    expect(variants(db).map((v) => v.turnId)).toEqual(['turn_a', 'turn_b']);
    expect(transcript(db)).toEqual(['u1']);

    db.close();
  });

  it('drops the alternatives when the conversation moves on', () => {
    const db = migrated();
    add(db, 'u1', 1, 'user', 'Hello');
    add(db, 'a1', 2, 'assistant', 'First');
    setAside(db, 2, true, 'u1', 'turn_a');
    db.prepare(
      `INSERT INTO messages (id, conversation_id, seq, role, created_at, content, text, turn_id, answers_id)
       VALUES ('a2', 'c1', 3, 'assistant', 0, '[]', 'Second', 'turn_b', 'u1')`,
    ).run();

    db.prepare(DROP_HIDDEN_SQL).run('c1');

    expect(transcript(db)).toEqual(['u1', 'a2']);
    expect((db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n).toBe(2);

    db.close();
  });

  it('leaves rows written before the migration alone', () => {
    // A database that has just upgraded: NULL grouping, nothing hidden, no slot.
    const db = migrated();
    add(db, 'u1', 1, 'user', 'Old');
    add(db, 'a1', 2, 'assistant', 'Old answer');

    expect(transcript(db)).toEqual(['u1', 'a1']);
    expect(variants(db)).toEqual([]);

    db.close();
  });
});
