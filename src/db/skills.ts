/**
 * Skill persistence.
 *
 * A thin table: the interesting parts of a skill — parsing, validation, the
 * catalogue — are pure and live in `@/chat/skill`. This module only reads and
 * writes rows, and enforces the one invariant SQL can enforce: names are unique,
 * because `ConversationConfig.skills` stores names rather than ids.
 */

import { database } from '@/db/schema';
import { newId } from '@/lib/id';

import type { Skill, SkillDraft } from '@/chat/skill';

interface SkillRow {
  id: string;
  created_at: number;
  updated_at: number;
  name: string;
  description: string;
  body: string;
}

function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    name: row.name,
    description: row.description,
    body: row.body,
  };
}

/**
 * Every skill, alphabetically.
 *
 * Unpaged and body-included: the store holds the whole set so that resolving an
 * `invoke_skill` call is a lookup rather than a query on the turn's hot path, and
 * the count is bounded by how many instruction files a person writes.
 */
export async function listSkills(): Promise<Skill[]> {
  const { db } = await database();
  const rows = await db.getAllAsync<SkillRow>('SELECT * FROM skills ORDER BY name');
  return rows.map(toSkill);
}

/** Writes a new skill. Throws on a duplicate name — the caller offers a rename. */
export async function addSkill(draft: SkillDraft): Promise<Skill> {
  const { db } = await database();
  const at = Date.now();
  const id = newId('skl_');
  await db.runAsync(
    'INSERT INTO skills (id, created_at, updated_at, name, description, body) VALUES (?, ?, ?, ?, ?, ?)',
    [id, at, at, draft.name, draft.description, draft.body],
  );
  return { id, createdAt: at, updatedAt: at, ...draft };
}

export async function updateSkill(id: string, draft: SkillDraft): Promise<void> {
  const { db } = await database();
  await db.runAsync('UPDATE skills SET name = ?, description = ?, body = ?, updated_at = ? WHERE id = ?', [
    draft.name,
    draft.description,
    draft.body,
    Date.now(),
    id,
  ]);
}

export async function deleteSkill(id: string): Promise<void> {
  const { db } = await database();
  await db.runAsync('DELETE FROM skills WHERE id = ?', [id]);
}

/**
 * A free name based on `name`: `review`, then `review-2`, `review-3`.
 *
 * Here rather than in the pure module because it is a question about what is
 * stored. Used by duplicate, and by import when the file collides with something
 * already installed — renaming is friendlier than refusing, and the alternative
 * (overwriting) loses work silently.
 */
export async function freeSkillName(name: string): Promise<string> {
  const { db } = await database();
  const rows = await db.getAllAsync<{ name: string }>('SELECT name FROM skills');
  const taken = new Set(rows.map((row) => row.name));
  if (!taken.has(name)) return name;
  // ponytail: linear probe. Fine for the tens of skills a person writes; if that
  // ever becomes thousands, ask SQL for the max suffix instead.
  for (let n = 2; ; n += 1) {
    const candidate = `${name}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
