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

import type {
  Memory,
  MemoryCandidate,
  MemoryKind,
  MemoryNode,
  MemoryNodeType,
  MemoryRelation,
} from '@/chat/memory';

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
  // Every approved memory also has a graph node. The node is deliberately
  // lightweight; relationships can be added later without changing prompts.
  await upsertMemoryNode({
    memoryId: row.id,
    nodeType: candidate.kind,
    label: candidate.text,
    normalized: candidate.text.toLowerCase().replace(/\s+/g, ' ').trim(),
    approved: row.approved === 1,
  });
  return toMemory(row);
}

interface MemoryNodeRow {
  id: string; memory_id: string | null; node_type: string; label: string; normalized: string;
  confidence: number; importance: number; sensitivity: string; approved: number;
  expires_at: number | null; created_at: number; updated_at: number;
}

function toNode(row: MemoryNodeRow): MemoryNode {
  return {
    id: row.id,
    ...(row.memory_id ? { memoryId: row.memory_id } : {}),
    nodeType: row.node_type as MemoryNodeType,
    label: row.label,
    normalized: row.normalized,
    confidence: row.confidence,
    importance: row.importance,
    sensitivity: row.sensitivity === 'sensitive' ? 'sensitive' : 'normal',
    approved: row.approved === 1,
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listMemoryNodes(): Promise<MemoryNode[]> {
  const { db } = await database();
  const rows = await db.getAllAsync<MemoryNodeRow>('SELECT * FROM memory_nodes ORDER BY importance DESC, confidence DESC, updated_at DESC');
  return rows.map(toNode);
}

export async function upsertMemoryNode(input: {
  id?: string; memoryId?: string; nodeType: MemoryNodeType; label: string; normalized?: string;
  confidence?: number; importance?: number; sensitivity?: 'normal' | 'sensitive'; approved?: boolean; expiresAt?: number;
}): Promise<MemoryNode> {
  const { db } = await database();
  const at = Date.now();
  const normalized = input.normalized ?? input.label.toLowerCase().replace(/\s+/g, ' ').trim();
  await db.runAsync(
    `INSERT INTO memory_nodes (id, memory_id, node_type, label, normalized, confidence, importance, sensitivity, approved, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (node_type, normalized) DO UPDATE SET label = excluded.label, confidence = MAX(memory_nodes.confidence, excluded.confidence),
       importance = MAX(memory_nodes.importance, excluded.importance), approved = MAX(memory_nodes.approved, excluded.approved), updated_at = excluded.updated_at`,
    [input.id ?? newId('mnode_'), input.memoryId ?? null, input.nodeType, input.label, normalized, input.confidence ?? 0.5,
      input.importance ?? 0, input.sensitivity ?? 'normal', input.approved === false ? 0 : 1, input.expiresAt ?? null, at, at],
  );
  const row = await db.getFirstAsync<MemoryNodeRow>('SELECT * FROM memory_nodes WHERE node_type = ? AND normalized = ?', [input.nodeType, normalized]);
  if (!row) throw new Error('Memory graph node disappeared immediately after being written');
  return toNode(row);
}

export async function addMemoryEdge(input: { fromNodeId: string; toNodeId: string; relation: MemoryRelation; confidence?: number }): Promise<void> {
  const { db } = await database();
  const at = Date.now();
  await db.runAsync(
    `INSERT INTO memory_edges (id, from_node_id, to_node_id, relation, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (from_node_id, to_node_id, relation) DO UPDATE SET confidence = MAX(memory_edges.confidence, excluded.confidence), updated_at = excluded.updated_at`,
    [newId('medge_'), input.fromNodeId, input.toNodeId, input.relation, input.confidence ?? 0.5, at, at],
  );
}

/** Daily maintenance is intentionally bounded and idempotent. */
export async function maintainMemoryGraph(now = Date.now()): Promise<{ expired: number; pruned: number }> {
  const { db } = await database();
  const expired = await db.runAsync('UPDATE memory_nodes SET approved = 0 WHERE expires_at IS NOT NULL AND expires_at <= ? AND approved = 1', [now]);
  const count = await db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM memory_nodes');
  const excess = Math.max(0, (count?.n ?? 0) - 500);
  if (excess) {
    await db.runAsync(
      `DELETE FROM memory_nodes WHERE id IN (SELECT id FROM memory_nodes WHERE approved = 0 ORDER BY importance ASC, confidence ASC, updated_at ASC LIMIT ?)`,
      [excess],
    );
  }
  return { expired: expired.changes, pruned: excess };
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
  await db.runAsync('UPDATE memory_nodes SET approved = 1, updated_at = ? WHERE memory_id = ?', [Date.now(), id]);
}

/** Corrects a memory in place. Resets nothing: a corrected memory is still the same memory. */
export async function editMemory(id: string, text: string): Promise<void> {
  const { db } = await database();
  await db.runAsync('UPDATE memories SET text = ?, updated_at = ? WHERE id = ?', [text, Date.now(), id]);
  await db.runAsync('UPDATE memory_nodes SET label = ?, normalized = ?, updated_at = ? WHERE memory_id = ?', [text, text.toLowerCase().replace(/\s+/g, ' ').trim(), Date.now(), id]);
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

export async function deleteMemoryNode(id: string): Promise<void> {
  const { db } = await database();
  await db.runAsync('DELETE FROM memory_nodes WHERE id = ?', [id]);
}
