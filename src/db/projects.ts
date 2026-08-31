/**
 * Project persistence.
 *
 * Thin, like `@/db/skills`: the rules — validation, how a project turns into a system
 * prompt, what happens when the knowledge does not fit — are pure and live in
 * `@/chat/project`. What is here is rows, plus the one thing SQL cannot be trusted to
 * do on its own (see `deleteProject`).
 */

import type { Project, ProjectDraft, ProjectKnowledge } from '@/chat/project';
import { database } from '@/db/schema';
import { newId } from '@/lib/id';
import { log } from '@/lib/log';

interface ProjectRow {
  id: string;
  created_at: number;
  updated_at: number;
  name: string;
  instructions: string;
  knowledge: string;
}

/**
 * Knowledge back out of its JSON column, defensively.
 *
 * A row that will not parse — a partial write, a hand-edited database — becomes a
 * project with no documents rather than an exception on the way into the list screen.
 */
function parseKnowledge(value: string, id: string): ProjectKnowledge[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is ProjectKnowledge =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as ProjectKnowledge).name === 'string' &&
        typeof (entry as ProjectKnowledge).text === 'string',
      )
      .map((entry) => ({ name: entry.name, text: entry.text }));
  } catch (error) {
    log.warn('projects', `Could not read the knowledge for ${id}`, error);
    return [];
  }
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    name: row.name,
    instructions: row.instructions,
    knowledge: parseKnowledge(row.knowledge, row.id),
  };
}

/**
 * Every project, alphabetically, documents included.
 *
 * Unpaged and whole, for the same reason skills are: a send has to turn a project id
 * into a system prompt without a query on the turn's hot path, and the count is
 * bounded by how many projects a person keeps.
 */
export async function listProjects(): Promise<Project[]> {
  const { db } = await database();
  const rows = await db.getAllAsync<ProjectRow>('SELECT * FROM projects ORDER BY name');
  return rows.map(toProject);
}

export async function addProject(draft: ProjectDraft): Promise<Project> {
  const { db } = await database();
  const at = Date.now();
  const id = newId('prj_');
  await db.runAsync(
    'INSERT INTO projects (id, created_at, updated_at, name, instructions, knowledge) VALUES (?, ?, ?, ?, ?, ?)',
    [id, at, at, draft.name, draft.instructions, JSON.stringify(draft.knowledge)],
  );
  return { id, createdAt: at, updatedAt: at, ...draft };
}

export async function updateProject(id: string, draft: ProjectDraft): Promise<void> {
  const { db } = await database();
  await db.runAsync(
    'UPDATE projects SET name = ?, instructions = ?, knowledge = ?, updated_at = ? WHERE id = ?',
    [draft.name, draft.instructions, JSON.stringify(draft.knowledge), Date.now(), id],
  );
}

/**
 * Deletes the project and releases its conversations.
 *
 * The conversations survive: a project is a grouping, and deleting a folder should not
 * delete the work in it. The `UPDATE` is explicit rather than left to
 * `ON DELETE SET NULL` because `PRAGMA foreign_keys` is per connection — a build that
 * ever opens the database without it would leave every one of those chats pointing at
 * a project that no longer exists.
 */
export async function deleteProject(id: string): Promise<void> {
  const { db } = await database();
  await db.runAsync('UPDATE conversations SET project_id = NULL WHERE project_id = ?', [id]);
  await db.runAsync('DELETE FROM projects WHERE id = ?', [id]);
}

/** How many conversations are in each project, for the list. */
export async function projectCounts(): Promise<Record<string, number>> {
  const { db } = await database();
  const rows = await db.getAllAsync<{ project_id: string; n: number }>(
    'SELECT project_id, COUNT(*) AS n FROM conversations WHERE project_id IS NOT NULL AND archived = 0 GROUP BY project_id',
  );
  return Object.fromEntries(rows.map((row) => [row.project_id, row.n]));
}
