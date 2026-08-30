/**
 * The skills store: the loaded set, CRUD over it, and the two things the turn needs.
 *
 * Those two are {@link SkillState.enabledFor} — which resolves the names a
 * conversation has switched on against what is actually installed — and the prompt
 * catalogue built from them. Everything else on here serves the settings screen.
 *
 * There is no global on/off switch, unlike memory: a skill is already off unless a
 * conversation names it, so the per-conversation toggle *is* the switch, and a
 * second one above it would only be a way to make an enabled skill silently do
 * nothing.
 */

import { create } from 'zustand';

import { normaliseSkill, parseSkill, validateSkill } from '@/chat/skill';
import type { Skill, SkillDraft } from '@/chat/skill';
import { unpackSkills } from '@/chat/skillZip';
import { addSkill, deleteSkill, freeSkillName, listSkills, updateSkill } from '@/db/skills';
import { log } from '@/lib/log';

export interface SkillState {
  skills: Skill[];
  loaded: boolean;

  load(): Promise<void>;
  /**
   * The installed skills a conversation has switched on, in catalogue order.
   *
   * Names that no longer resolve are dropped silently — a skill deleted from
   * settings should not break every conversation that once used it, and the
   * catalogue is rebuilt from this on every turn anyway.
   */
  enabledFor(names: readonly string[] | undefined): Skill[];
  /** Saves a new skill, or returns why it could not be saved. */
  create(draft: SkillDraft): Promise<{ ok: true; skill: Skill } | { ok: false; reason: string }>;
  save(id: string, draft: SkillDraft): Promise<{ ok: true } | { ok: false; reason: string }>;
  duplicate(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Imports a `SKILL.md`. Renames rather than clobbering on a name collision. */
  importFile(text: string): Promise<{ ok: true; skill: Skill } | { ok: false; reason: string }>;
  /**
   * Imports every skill in a zip, one member at a time.
   *
   * Per-member rather than all-or-nothing: an archive is usually a folder somebody
   * else assembled, and one file in it with a broken fence is not a reason to
   * refuse the other thirteen. The reasons come back so a partial import is
   * reported rather than looking like a success that lost things.
   */
  importZip(bytes: Uint8Array): Promise<{ added: string[]; skipped: string[] }>;
}

export const useSkills = create<SkillState>()((set, get) => ({
  skills: [],
  loaded: false,

  async load() {
    try {
      set({ skills: await listSkills(), loaded: true });
    } catch (error) {
      log.error('skills', 'Could not load skills', {
        error: error instanceof Error ? error.message : String(error),
      });
      set({ loaded: true });
    }
  },

  enabledFor(names) {
    if (!names?.length) return [];
    const wanted = new Set(names);
    return get().skills.filter((skill) => wanted.has(skill.name));
  },

  async create(draft) {
    const normalised = normaliseSkill(draft);
    const problem = validateSkill(normalised);
    if (problem) return { ok: false, reason: problem };
    if (get().skills.some((skill) => skill.name === normalised.name)) {
      return { ok: false, reason: `There is already a skill called “${normalised.name}”.` };
    }
    const skill = await addSkill(normalised);
    set((state) => ({ skills: [...state.skills, skill].sort(byName) }));
    return { ok: true, skill };
  },

  async save(id, draft) {
    const normalised = normaliseSkill(draft);
    const problem = validateSkill(normalised);
    if (problem) return { ok: false, reason: problem };
    if (get().skills.some((skill) => skill.name === normalised.name && skill.id !== id)) {
      return { ok: false, reason: `There is already a skill called “${normalised.name}”.` };
    }
    await updateSkill(id, normalised);
    const at = Date.now();
    set((state) => ({
      skills: state.skills.map((skill) => (skill.id === id ? { ...skill, ...normalised, updatedAt: at } : skill)).sort(byName),
    }));
    return { ok: true };
  },

  async duplicate(id) {
    const source = get().skills.find((skill) => skill.id === id);
    if (!source) return;
    const name = await freeSkillName(source.name);
    const skill = await addSkill({ name, description: source.description, body: source.body });
    set((state) => ({ skills: [...state.skills, skill].sort(byName) }));
  },

  async remove(id) {
    await deleteSkill(id);
    set((state) => ({ skills: state.skills.filter((skill) => skill.id !== id) }));
  },

  async importFile(text) {
    const parsed = parseSkill(text);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    // Renamed rather than refused or overwritten: refusing makes the user edit a
    // file by hand to get it in, and overwriting destroys the version they had.
    const name = await freeSkillName(parsed.skill.name);
    const skill = await addSkill({ ...parsed.skill, name });
    set((state) => ({ skills: [...state.skills, skill].sort(byName) }));
    return { ok: true, skill };
  },

  async importZip(bytes) {
    const { files, skipped } = unpackSkills(bytes);
    const added: string[] = [];
    const reasons = [...skipped];
    for (const text of files) {
      const result = await get().importFile(text);
      if (result.ok) added.push(result.skill.name);
      else reasons.push(result.reason);
    }
    return { added, skipped: reasons };
  },
}));

function byName(a: Skill, b: Skill): number {
  return a.name.localeCompare(b.name);
}
