/**
 * The prompt library store.
 *
 * Thin over `@/db/prompts`, so the only things worth pinning are the ones the store
 * owns: a blank template is refused rather than stored, an edit updates the row in
 * place, and `noteUsed` re-reads the table instead of re-sorting in JS — the ranking
 * is `uses DESC, updated_at DESC` in SQL and a second comparator here would drift.
 */

jest.mock('@/db/prompts', () => {
  const mockRows: { id: string; createdAt: number; updatedAt: number; title: string; body: string; uses: number }[] = [];
  let mockSeq = 0;
  return {
    listPrompts: async () =>
      [...mockRows].sort((a, b) => b.uses - a.uses || b.updatedAt - a.updatedAt).map((row) => ({ ...row })),
    addPrompt: async (draft: { title: string; body: string }) => {
      const at = 1000 + (mockSeq += 1);
      const prompt = { id: `prm_${mockSeq}`, createdAt: at, updatedAt: at, uses: 0, ...draft };
      mockRows.push(prompt);
      return { ...prompt };
    },
    updatePrompt: async (id: string, draft: { title: string; body: string }) => {
      const row = mockRows.find((entry) => entry.id === id);
      if (row) Object.assign(row, draft, { updatedAt: row.updatedAt + 1 });
    },
    deletePrompt: async (id: string) => {
      const at = mockRows.findIndex((row) => row.id === id);
      if (at >= 0) mockRows.splice(at, 1);
    },
    notePromptUsed: async (id: string) => {
      const row = mockRows.find((entry) => entry.id === id);
      if (row) row.uses += 1;
    },
  };
});

import { usePrompts } from './prompts';

/** The store's own list, indexed without `noUncheckedIndexedAccess` noise in every test. */
function at(index: number) {
  const prompt = usePrompts.getState().prompts[index];
  if (!prompt) throw new Error(`no prompt at ${index}`);
  return prompt;
}

beforeEach(async () => {
  for (const prompt of usePrompts.getState().prompts) await usePrompts.getState().remove(prompt.id);
  usePrompts.setState({ prompts: [], loaded: false });
});

test('a new template goes to the top of the list, newest first', async () => {
  expect(await usePrompts.getState().create({ title: 'Review a diff', body: 'Review {{diff}}.' })).toEqual({ ok: true });
  expect(await usePrompts.getState().create({ title: 'Explain', body: 'Explain {{thing}}.' })).toEqual({ ok: true });
  expect(usePrompts.getState().prompts.map((prompt) => prompt.title)).toEqual(['Explain', 'Review a diff']);
});

test('a blank template is refused with a reason', async () => {
  const result = await usePrompts.getState().create({ title: '', body: '' });
  expect(result.ok).toBe(false);
  expect(usePrompts.getState().prompts).toEqual([]);
});

test('an edit rewrites the row in place, and a bad edit changes nothing', async () => {
  await usePrompts.getState().create({ title: 'Review a diff', body: 'Review {{diff}}.' });
  const prompt = at(0);

  expect(await usePrompts.getState().save(prompt.id, { title: 'Review a patch', body: 'Review {{patch}}.' })).toEqual({
    ok: true,
  });
  expect(at(0)).toMatchObject({ title: 'Review a patch', body: 'Review {{patch}}.' });

  expect(await usePrompts.getState().save(prompt.id, { title: '', body: '' })).toMatchObject({ ok: false });
  expect(at(0).title).toBe('Review a patch');
});

test('using a template reorders the library by use, not by hand', async () => {
  await usePrompts.getState().create({ title: 'Rarely', body: 'a' });
  await usePrompts.getState().create({ title: 'Often', body: 'b' });
  const often = usePrompts.getState().prompts.find((prompt) => prompt.title === 'Often');

  await usePrompts.getState().noteUsed(often?.id ?? '');

  expect(usePrompts.getState().prompts.map((prompt) => prompt.title)).toEqual(['Often', 'Rarely']);
  expect(at(0).uses).toBe(1);
});

test('a delete removes only its own row, and load reads the table back', async () => {
  await usePrompts.getState().create({ title: 'Keep', body: 'a' });
  await usePrompts.getState().create({ title: 'Drop', body: 'b' });
  const drop = usePrompts.getState().prompts.find((prompt) => prompt.title === 'Drop');

  await usePrompts.getState().remove(drop?.id ?? '');
  usePrompts.setState({ prompts: [], loaded: false });
  await usePrompts.getState().load();

  expect(usePrompts.getState().loaded).toBe(true);
  expect(usePrompts.getState().prompts.map((prompt) => prompt.title)).toEqual(['Keep']);
});
