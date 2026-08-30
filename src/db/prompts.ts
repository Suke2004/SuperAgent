/**
 * Prompt template persistence.
 *
 * Ranked by use rather than alphabetically: a library of thirty templates where the
 * three you actually use are at the top is a library you keep using. The substitution
 * itself is pure and lives in `@/chat/prompts`.
 */

import { database } from '@/db/schema';
import { newId } from '@/lib/id';

import type { Prompt, PromptDraft } from '@/chat/prompts';

interface PromptRow {
  id: string;
  created_at: number;
  updated_at: number;
  title: string;
  body: string;
  uses: number;
  last_used_at: number | null;
}

function toPrompt(row: PromptRow): Prompt {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: row.title,
    body: row.body,
    uses: row.uses,
    ...(row.last_used_at !== null ? { lastUsedAt: row.last_used_at } : {}),
  };
}

export async function listPrompts(): Promise<Prompt[]> {
  const { db } = await database();
  const rows = await db.getAllAsync<PromptRow>('SELECT * FROM prompts ORDER BY uses DESC, updated_at DESC');
  return rows.map(toPrompt);
}

export async function addPrompt(draft: PromptDraft): Promise<Prompt> {
  const { db } = await database();
  const at = Date.now();
  const id = newId('prm_');
  await db.runAsync('INSERT INTO prompts (id, created_at, updated_at, title, body) VALUES (?, ?, ?, ?, ?)', [
    id,
    at,
    at,
    draft.title,
    draft.body,
  ]);
  return { id, createdAt: at, updatedAt: at, uses: 0, ...draft };
}

export async function updatePrompt(id: string, draft: PromptDraft): Promise<void> {
  const { db } = await database();
  await db.runAsync('UPDATE prompts SET title = ?, body = ?, updated_at = ? WHERE id = ?', [
    draft.title,
    draft.body,
    Date.now(),
    id,
  ]);
}

export async function deletePrompt(id: string): Promise<void> {
  const { db } = await database();
  await db.runAsync('DELETE FROM prompts WHERE id = ?', [id]);
}

/**
 * Records that a template was inserted into a draft.
 *
 * `updated_at` is deliberately left alone: using a prompt is not editing it, and
 * bumping it would make the secondary sort meaningless.
 */
export async function notePromptUsed(id: string): Promise<void> {
  const { db } = await database();
  await db.runAsync('UPDATE prompts SET uses = uses + 1, last_used_at = ? WHERE id = ?', [Date.now(), id]);
}
