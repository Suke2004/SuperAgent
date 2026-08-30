/**
 * Memory persistence.
 *
 * Separate from `conversations.ts` because memories deliberately outlive the
 * conversations that produced them: `source_conversation_id` is a note about
 * provenance, not a foreign key, so deleting a thread never silently forgets what
 * it taught the app. See `@/chat/memory` for what a memory is and why.
 */

import { database } from '@/db/schema';
import { newId } from '@/lib/id';
import { log } from '@/lib/log';

import type { Memory, MemoryCandidate, MemoryKind } from '@/chat/memory';

interface MemoryRow {
  id: string;
  created_at: number;
  updated_at: number;
  kind: string;
  text: string;
  source_conversation_id: string | null;
  hits: number;
  last_used_at: number | null;
  pinned: number;
  approved: number;
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Cast rather than validate: the column is only ever written from
    // `MemoryCandidate`, and a row with an unknown kind would have to have been
    // put there by hand.
    kind: row.kind as MemoryKind,
    text: row.text,
    hits: row.hits,
    pinned: row.pinned === 1,
    approved: row.approved === 1,
    ...(row.source_conversation_id ? { sourceConversationId: row.source_conversation_id } : {}),
    ...(row.last_used_at !== null ? { lastUsedAt: row.last_used_at } : {}),
  };
}

/**
 * Every memory, ranked the way the prompt builder wants them.
 *
 * Unpaged on purpose: the store is bounded by what a person actually restates —
 * tens of rows, not thousands — and the prompt builder needs to see all of them to
 * decide which fit the budget.
 */
export async function listMemories(): Promise<Memory[]> {
  const { db } = await database();
  const rows = await db.getAllAsync<MemoryRow>(
    'SELECT * FROM memories ORDER BY pinned DESC, hits DESC, updated_at DESC',
  );
  return rows.map(toMemory);
}

export async function countMemories(): Promise<number> {
  const { db } = await database();
  const row = await db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM memories');
  return row?.n ?? 0;
}

/**
 * Writes a memory, or bumps the one that already says this.
 *
 * The uniqueness is `(kind, text)` in SQL, which catches the exact restatement;
 * near-duplicates are folded earlier by `mergeMemories`, before this is called.
 * Both layers exist because the SQL one is what makes a retry idempotent.
 *
 * `approved` defaults to true because the callers who pass nothing are the user
 * typing a memory in settings and a restore; the distiller passes false. Note what
 * the conflict clause leaves alone: a restated memory bumps `hits` but does not
 * become approved, so re-learning something the user declined does not sneak it in.
 */
export async function addMemory(
  candidate: MemoryCandidate,
  sourceConversationId?: string,
  approved = true,
): Promise<Memory> {
  const { db } = await database();
  const at = Date.now();
  const id = newId('mem_');

  await db.runAsync(
    `INSERT INTO memories (id, created_at, updated_at, kind, text, source_conversation_id, hits, pinned, approved)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)
     ON CONFLICT (kind, text) DO UPDATE SET hits = hits + 1, updated_at = excluded.updated_at`,
    [id, at, at, candidate.kind, candidate.text, sourceConversationId ?? null, approved ? 1 : 0],
  );

  const row = await db.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE kind = ? AND text = ?', [
    candidate.kind,
    candidate.text,
  ]);
  if (!row) throw new Error('Memory disappeared immediately after being written');
  return toMemory(row);
}

/** Records that a memory was restated, which is what keeps it near the top of the budget. */
export async function confirmMemory(id: string): Promise<void> {
  const { db } = await database();
  await db.runAsync('UPDATE memories SET hits = hits + 1, updated_at = ? WHERE id = ?', [Date.now(), id]);
}

/** The user agreeing that a distilled memory may be carried into future conversations. */
export async function approveMemory(id: string): Promise<void> {
  const { db } = await database();
  await db.runAsync('UPDATE memories SET approved = 1, updated_at = ? WHERE id = ?', [Date.now(), id]);
}

/** Corrects a memory in place. Resets nothing: a corrected memory is still the same memory. */
export async function editMemory(id: string, text: string): Promise<void> {
  const { db } = await database();
  await db.runAsync('UPDATE memories SET text = ?, updated_at = ? WHERE id = ?', [text, Date.now(), id]);
}

export async function setMemoryPinned(id: string, pinned: boolean): Promise<void> {
  const { db } = await database();
  await db.runAsync('UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?', [pinned ? 1 : 0, Date.now(), id]);
}

export async function deleteMemory(id: string): Promise<void> {
  const { db } = await database();
  await db.runAsync('DELETE FROM memories WHERE id = ?', [id]);
}

/** Notes that a set of memories was actually sent, so the list can show what is in use. */
export async function markMemoriesUsed(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const { db } = await database();
  const at = Date.now();
  // One statement rather than a loop: this runs on the hot path of every send.
  const placeholders = ids.map(() => '?').join(', ');
  await db.runAsync(`UPDATE memories SET last_used_at = ? WHERE id IN (${placeholders})`, [at, ...ids]);
}

/**
 * Forgets everything.
 *
 * One statement inside a transaction, so a cancelled or crashed "forget
 * everything" cannot leave a partly-forgotten user — which would be worse than
 * either outcome, because the remaining half looks intentional.
 */
export async function clearMemories(): Promise<number> {
  const { db } = await database();
  const before = await countMemories();
  await db.withTransactionAsync(async () => {
    await db.execAsync('DELETE FROM memories');
  });
  log.info('memory', `Deleted every memory (${before})`);
  return before;
}
