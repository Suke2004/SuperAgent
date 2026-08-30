/**
 * The prompt library.
 *
 * A thin store over `@/db/prompts`, in the shape the skills store already uses:
 * `loaded`, actions returning `{ok}` or `{ok:false,reason}`, and the ranking left to
 * SQL. The `{{variable}}` substitution is pure and lives in `@/chat/prompts`.
 */

import { create } from 'zustand';

import { addPrompt, deletePrompt, listPrompts, notePromptUsed, updatePrompt } from '@/db/prompts';
import { validatePrompt } from '@/chat/prompts';
import type { Prompt, PromptDraft } from '@/chat/prompts';
import { log } from '@/lib/log';

export interface PromptState {
  prompts: Prompt[];
  loaded: boolean;
  load(): Promise<void>;
  create(draft: PromptDraft): Promise<{ ok: true } | { ok: false; reason: string }>;
  save(id: string, draft: PromptDraft): Promise<{ ok: true } | { ok: false; reason: string }>;
  remove(id: string): Promise<void>;
  /** Called when a template is inserted into a draft, which is what the ranking is. */
  noteUsed(id: string): Promise<void>;
}

export const usePrompts = create<PromptState>()((set, get) => ({
  prompts: [],
  loaded: false,

  async load() {
    try {
      set({ prompts: await listPrompts(), loaded: true });
    } catch (error) {
      log.error('prompts', 'Could not load the prompt library', error);
      set({ loaded: true });
    }
  },

  async create(draft) {
    const problem = validatePrompt(draft);
    if (problem) return { ok: false, reason: problem };
    const prompt = await addPrompt(draft);
    set((state) => ({ prompts: [prompt, ...state.prompts] }));
    return { ok: true };
  },

  async save(id, draft) {
    const problem = validatePrompt(draft);
    if (problem) return { ok: false, reason: problem };
    await updatePrompt(id, draft);
    set((state) => ({
      prompts: state.prompts.map((prompt) =>
        prompt.id === id ? { ...prompt, ...draft, updatedAt: Date.now() } : prompt,
      ),
    }));
    return { ok: true };
  },

  async remove(id) {
    await deletePrompt(id);
    set((state) => ({ prompts: state.prompts.filter((prompt) => prompt.id !== id) }));
  },

  async noteUsed(id) {
    await notePromptUsed(id);
    // Re-read rather than re-sort here: the order is `uses DESC, updated_at DESC` in
    // SQL, and duplicating that comparator is how the two drift apart.
    await get().load();
  },
}));
