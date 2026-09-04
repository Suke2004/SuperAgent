import { database } from '@/db/schema';
import { newId } from '@/lib/id';

export interface PersonalTask {
  id: string;
  title: string;
  notes: string;
  dueAt?: number;
  status: 'open' | 'done';
  priority: number;
  sourceConversationId?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

interface TaskRow { id: string; title: string; notes: string; due_at: number | null; status: string; priority: number; source_conversation_id: string | null; created_at: number; updated_at: number; completed_at: number | null }
function toTask(row: TaskRow): PersonalTask {
  return { id: row.id, title: row.title, notes: row.notes, ...(row.due_at !== null ? { dueAt: row.due_at } : {}), status: row.status === 'done' ? 'done' : 'open', priority: row.priority, ...(row.source_conversation_id ? { sourceConversationId: row.source_conversation_id } : {}), createdAt: row.created_at, updatedAt: row.updated_at, ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}) };
}

export async function createTask(input: { title: string; notes?: string; dueAt?: number; priority?: number; sourceConversationId?: string }): Promise<PersonalTask> {
  const { db } = await database(); const now = Date.now(); const id = newId('task_');
  await db.runAsync('INSERT INTO personal_tasks (id,title,notes,due_at,status,priority,source_conversation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', [id, input.title.trim(), input.notes?.trim() ?? '', input.dueAt ?? null, 'open', input.priority ?? 0, input.sourceConversationId ?? null, now, now]);
  const row = await db.getFirstAsync<TaskRow>('SELECT * FROM personal_tasks WHERE id = ?', [id]);
  if (!row) throw new Error('Task was not persisted'); return toTask(row);
}

export async function listTasks(options: { includeDone?: boolean; limit?: number } = {}): Promise<PersonalTask[]> {
  const { db } = await database(); const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const sql = options.includeDone ? 'SELECT * FROM personal_tasks ORDER BY status, due_at IS NULL, due_at, priority DESC, updated_at DESC LIMIT ?' : "SELECT * FROM personal_tasks WHERE status = 'open' ORDER BY due_at IS NULL, due_at, priority DESC, updated_at DESC LIMIT ?";
  return (await db.getAllAsync<TaskRow>(sql, [limit])).map(toTask);
}

export async function completeTask(id: string): Promise<boolean> {
  const { db } = await database(); const result = await db.runAsync("UPDATE personal_tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'", [Date.now(), Date.now(), id]);
  return result.changes > 0;
}
