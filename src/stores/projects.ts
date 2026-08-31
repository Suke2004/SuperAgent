/**
 * Projects.
 *
 * Same shape as the prompts and skills stores: `loaded`, actions that return
 * `{ok}` or `{ok:false,reason}`, ordering left to SQL. Held whole so a send can turn
 * `conversation.projectId` into a system prompt without touching the database on the
 * turn's hot path.
 */

import { create } from 'zustand';

import { validateProject } from '@/chat/project';
import type { Project, ProjectDraft } from '@/chat/project';
import { addProject, deleteProject, listProjects, projectCounts, updateProject } from '@/db/projects';
import { log } from '@/lib/log';

export interface ProjectState {
  projects: Project[];
  /** Conversation count per project id, for the list. Unarchived only. */
  counts: Record<string, number>;
  loaded: boolean;
  load(): Promise<void>;
  create(draft: ProjectDraft): Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
  save(id: string, draft: ProjectDraft): Promise<{ ok: true } | { ok: false; reason: string }>;
  remove(id: string): Promise<void>;
  /** The project a conversation belongs to, or undefined. Never queries. */
  byId(id: string | undefined): Project | undefined;
}

export const useProjects = create<ProjectState>()((set, get) => ({
  projects: [],
  counts: {},
  loaded: false,

  async load() {
    try {
      const [projects, counts] = await Promise.all([listProjects(), projectCounts()]);
      set({ projects, counts, loaded: true });
    } catch (error) {
      log.error('projects', 'Could not load projects', error);
      set({ loaded: true });
    }
  },

  async create(draft) {
    const problem = validateProject(draft);
    if (problem) return { ok: false, reason: problem };
    const project = await addProject(draft);
    // Re-sorted rather than prepended: the list is `ORDER BY name`, and a store that
    // puts the newest first would disagree with what the next load returns.
    set((state) => ({ projects: [...state.projects, project].sort((a, b) => a.name.localeCompare(b.name)) }));
    return { ok: true, id: project.id };
  },

  async save(id, draft) {
    const problem = validateProject(draft);
    if (problem) return { ok: false, reason: problem };
    await updateProject(id, draft);
    set((state) => ({
      projects: state.projects
        .map((project) => (project.id === id ? { ...project, ...draft, updatedAt: Date.now() } : project))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
    return { ok: true };
  },

  async remove(id) {
    await deleteProject(id);
    set((state) => ({ projects: state.projects.filter((project) => project.id !== id) }));
  },

  byId(id) {
    return id ? get().projects.find((project) => project.id === id) : undefined;
  },
}));
