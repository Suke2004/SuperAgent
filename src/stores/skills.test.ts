/**
 * The skills store.
 *
 * Two things here are worth pinning: a name collision must be *refused* on a manual
 * save (silently overwriting the skill someone spent an evening writing is the worst
 * possible answer) but *renamed* on an import (refusing makes them edit a file by
 * hand to get it in), and `enabledFor` must drop names that no longer resolve rather
 * than throwing — a skill deleted in settings should not break every conversation
 * that once used it.
 *
 * `@/db/skills` is mocked with an in-memory table; the SQL has its own coverage.
 */

jest.mock('@/db/skills', () => {
  const mockRows: { id: string; createdAt: number; updatedAt: number; name: string; description: string; body: string }[] =
    [];
  let mockSeq = 0;
  return {
    listSkills: async () => [...mockRows].sort((a, b) => a.name.localeCompare(b.name)),
    addSkill: async (draft: { name: string; description: string; body: string }) => {
      if (mockRows.some((row) => row.name === draft.name)) throw new Error('UNIQUE constraint failed');
      const at = 1000 + mockSeq;
      const skill = { id: `skl_${(mockSeq += 1)}`, createdAt: at, updatedAt: at, ...draft };
      mockRows.push(skill);
      return skill;
    },
    updateSkill: async (id: string, draft: { name: string; description: string; body: string }) => {
      const row = mockRows.find((entry) => entry.id === id);
      if (row) Object.assign(row, draft);
    },
    deleteSkill: async (id: string) => {
      const at = mockRows.findIndex((row) => row.id === id);
      if (at >= 0) mockRows.splice(at, 1);
    },
    freeSkillName: async (name: string) => {
      let candidate = name;
      let n = 2;
      while (mockRows.some((row) => row.name === candidate)) candidate = `${name} ${n++}`;
      return candidate;
    },
    __rows: mockRows,
  };
});

import { strToU8, zipSync } from 'fflate';

import { packSkills } from '@/chat/skillZip';
import { useSkills } from './skills';

const DRAFT = { name: 'code-review', description: 'Reviews a diff.', body: 'Read the diff, then comment.' };

const GOOD_FILE = ['---', 'name: imported-one', 'description: An imported skill.', '---', '', 'Follow these steps.'].join(
  '\n',
);

/** The store's own list, indexed without `noUncheckedIndexedAccess` noise in every test. */
function at(index: number) {
  const skill = useSkills.getState().skills[index];
  if (!skill) throw new Error(`no skill at ${index}`);
  return skill;
}

beforeEach(async () => {
  for (const skill of useSkills.getState().skills) await useSkills.getState().remove(skill.id);
  useSkills.setState({ skills: [], loaded: false });
});

test('a saved skill lands in the store, sorted, and a second one with the same name is refused', async () => {
  expect(await useSkills.getState().create({ ...DRAFT, name: 'zebra' })).toMatchObject({ ok: true });
  expect(await useSkills.getState().create(DRAFT)).toMatchObject({ ok: true });
  expect(useSkills.getState().skills.map((skill) => skill.name)).toEqual(['code-review', 'zebra']);

  const clash = await useSkills.getState().create({ ...DRAFT, body: 'different body entirely' });
  expect(clash).toEqual({ ok: false, reason: 'There is already a skill called “code-review”.' });
  expect(useSkills.getState().skills).toHaveLength(2);
});

test('an invalid draft is refused with a reason rather than saved', async () => {
  const result = await useSkills.getState().create({ name: '', description: '', body: '' });
  expect(result.ok).toBe(false);
  expect(useSkills.getState().skills).toEqual([]);
});

test('an edit can keep its own name but cannot take a name another skill holds', async () => {
  await useSkills.getState().create(DRAFT);
  await useSkills.getState().create({ ...DRAFT, name: 'other' });
  const first = at(0);

  expect(await useSkills.getState().save(first.id, { ...DRAFT, description: 'Reviews a diff, carefully.' })).toEqual({
    ok: true,
  });
  expect(at(0).description).toBe('Reviews a diff, carefully.');

  expect(await useSkills.getState().save(first.id, { ...DRAFT, name: 'other' })).toMatchObject({ ok: false });
});

test('a duplicate is renamed rather than colliding, and a delete removes only its own', async () => {
  await useSkills.getState().create(DRAFT);
  const original = at(0);

  await useSkills.getState().duplicate(original.id);
  expect(useSkills.getState().skills.map((skill) => skill.name)).toEqual(['code-review', 'code-review 2']);
  // A duplicate of something that is gone is a no-op, not a throw.
  await useSkills.getState().duplicate('skl_nope');

  await useSkills.getState().remove(original.id);
  expect(useSkills.getState().skills.map((skill) => skill.name)).toEqual(['code-review 2']);
});

test('an imported file is renamed on a collision instead of clobbering what is there', async () => {
  await useSkills.getState().create(DRAFT);
  const file = ['---', 'name: code-review', 'description: A different reviewer.', '---', '', 'Do it differently.'].join(
    '\n',
  );

  const imported = await useSkills.getState().importFile(file);
  expect(imported).toMatchObject({ ok: true });
  expect(useSkills.getState().skills.map((skill) => skill.name)).toEqual(['code-review', 'code-review 2']);
  expect(at(0).body).toBe(DRAFT.body);

  expect(await useSkills.getState().importFile('not a skill file')).toMatchObject({ ok: false });
});

test('enabledFor resolves the names a conversation switched on and ignores the rest', async () => {
  await useSkills.getState().create(DRAFT);
  await useSkills.getState().create({ ...DRAFT, name: 'other' });

  expect(useSkills.getState().enabledFor(undefined)).toEqual([]);
  expect(useSkills.getState().enabledFor([])).toEqual([]);
  expect(useSkills.getState().enabledFor(['code-review', 'deleted-last-week']).map((skill) => skill.name)).toEqual([
    'code-review',
  ]);
});

test('load reads the table into the store', async () => {
  await useSkills.getState().create(DRAFT);
  useSkills.setState({ skills: [], loaded: false });

  await useSkills.getState().load();
  expect(useSkills.getState().loaded).toBe(true);
  expect(useSkills.getState().skills.map((skill) => skill.name)).toEqual(['code-review']);
});

test('a zip import takes the members it can and reports the ones it cannot', async () => {
  await useSkills.getState().create(DRAFT);
  const bytes = packSkills([
    { name: 'code-review', description: 'A different reviewer.', body: 'Do it differently.' },
    { name: 'commit-messages', description: 'Writes commit messages.', body: 'Imperative mood.' },
  ]);

  const result = await useSkills.getState().importZip(bytes);
  // The collision is renamed, as with a single file — the archive is usually
  // somebody else's folder, and one clash must not cost the rest of it.
  expect(result.added.sort()).toEqual(['code-review 2', 'commit-messages']);
  expect(result.skipped).toEqual([]);
  expect(at(0).body).toBe(DRAFT.body);

  // A member that is not a skill is counted, not thrown, and does not stop the rest.
  const mixed = zipSync({ 'notes.md': strToU8('no frontmatter here'), 'ok.SKILL.md': strToU8(GOOD_FILE) });
  const second = await useSkills.getState().importZip(mixed);
  expect(second.added).toEqual(['imported-one']);
  expect(second.skipped).toHaveLength(1);
});
