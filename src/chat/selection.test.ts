/**
 * Multi-select bookkeeping, and the sentences a bulk confirmation says.
 *
 * The interesting tests here are the boring-looking ones. `describeDelete` is
 * the last thing between a tap and fifty irrecoverable conversations, so what it
 * asserts is not "the string is formed" but that it *cannot understate the
 * damage*: the message count is present, pinned rows are called out, and the
 * reversible alternative is mentioned. A dialog that said "Delete 12
 * conversations?" would pass a test for well-formed output and still be the
 * wrong dialog.
 *
 * `pruneSelection` gets the other half of the attention, because it guards the
 * one way a truthful dialog can still do the wrong thing: ids left selected
 * against rows that have scrolled, filtered or archived out of the list.
 */

import {
  archiveEffect,
  plural,
  pruneSelection,
  sampleTitles,
  selectAll,
  summariseSelection,
  toggleSelected,
  describeDelete,
} from '@/chat/selection';
import type { Conversation } from '@/db/conversations';

function conversation(over: Partial<Conversation> & { id: string }): Conversation {
  return {
    title: `Thread ${over.id}`,
    createdAt: 1000,
    updatedAt: 1000,
    pinned: false,
    archived: false,
    systemPrompt: null,
    profileId: 'p1',
    model: 'claude-opus-5',
    config: {},
    tags: [],
    messageCount: 0,
    ...over,
  } as Conversation;
}

const LIST: Conversation[] = [
  conversation({ id: 'a', title: 'Kestrel notes', pinned: true, messageCount: 12, tags: ['work'] }),
  conversation({ id: 'b', title: 'Tax return', messageCount: 40, tags: ['work', 'admin'] }),
  conversation({ id: 'c', title: 'Idle thoughts', messageCount: 3, archived: true }),
];

describe('toggling and clearing a selection', () => {
  it('adds on the first tap and removes on the second', () => {
    const once = toggleSelected(new Set(), 'a');
    expect([...once]).toEqual(['a']);
    expect([...toggleSelected(once, 'a')]).toEqual([]);
  });

  it('returns a new set rather than mutating the old one', () => {
    // Not pedantry: React compares state by identity, so a mutated-and-re-set
    // `Set` renders nothing and the ticks never appear.
    const before = new Set(['a']);
    const after = toggleSelected(before, 'b');
    expect(after).not.toBe(before);
    expect([...before]).toEqual(['a']);
  });

  it('selects everything visible, which is only ever the loaded page', () => {
    expect([...selectAll(LIST)]).toEqual(['a', 'b', 'c']);
    expect([...selectAll([])]).toEqual([]);
  });
});

describe('pruning a selection against what is on screen', () => {
  it('drops ids that have left the list', () => {
    // The archiving case: the rows are gone from the query, and a bulk action
    // that still held their ids would reach conversations the user cannot see.
    const kept = pruneSelection(new Set(['a', 'b', 'gone']), LIST);
    expect([...kept].sort()).toEqual(['a', 'b']);
  });

  it('empties entirely when nothing is visible', () => {
    expect([...pruneSelection(new Set(['a', 'b']), [])]).toEqual([]);
  });

  it('keeps a fully-visible selection unchanged in content', () => {
    expect([...pruneSelection(new Set(['a', 'c']), LIST)].sort()).toEqual(['a', 'c']);
  });
});

describe('what is in the selection', () => {
  it('totals the messages, not just the rows', () => {
    const summary = summariseSelection(new Set(['a', 'b']), LIST);
    expect(summary.count).toBe(2);
    expect(summary.messages).toBe(52);
  });

  it('counts pinned and archived rows separately', () => {
    const summary = summariseSelection(new Set(['a', 'b', 'c']), LIST);
    expect(summary.pinned).toBe(1);
    expect(summary.archived).toBe(1);
  });

  it('gathers every tag the selection carries, de-duplicated and sorted', () => {
    expect(summariseSelection(new Set(['a', 'b']), LIST).tags).toEqual(['admin', 'work']);
  });

  it('lists titles in list order rather than tap order', () => {
    // Iterating the visible rows rather than the selection set. A `Set` would
    // give the order the user happened to tap in, and the dialog would sample
    // titles that read as unrelated to what is on screen.
    expect(summariseSelection(new Set(['c', 'a']), LIST).titles).toEqual(['Kestrel notes', 'Idle thoughts']);
  });

  it('treats a missing message count as zero rather than NaN', () => {
    // `messageCount` is a derived column and can be absent on a freshly created
    // conversation. `undefined` propagating into the total would put "NaN
    // messages" into a delete confirmation.
    const list = [conversation({ id: 'x' })];
    delete (list[0] as { messageCount?: number }).messageCount;
    expect(summariseSelection(new Set(['x']), list).messages).toBe(0);
  });

  it('is all zeroes for an empty selection', () => {
    const summary = summariseSelection(new Set(), LIST);
    expect(summary).toEqual({ count: 0, messages: 0, pinned: 0, archived: 0, tags: [], titles: [] });
  });
});

describe('counting things in prose', () => {
  it('gets the singular right, which is the only way to get it wrong', () => {
    expect(plural(1, 'conversation')).toBe('1 conversation');
    expect(plural(2, 'conversation')).toBe('2 conversations');
    expect(plural(0, 'conversation')).toBe('0 conversations');
  });

  it('takes an irregular plural for the words that need one', () => {
    expect(plural(3, 'memory', 'memories')).toBe('3 memories');
  });

  it('samples at most three titles and says how many it did not show', () => {
    expect(sampleTitles(['a', 'b'])).toBe('“a”, “b”');
    expect(sampleTitles(['a', 'b', 'c', 'd', 'e'])).toBe('“a”, “b”, “c”, and 2 more');
    expect(sampleTitles([])).toBe('');
  });
});

describe('the delete confirmation', () => {
  it('names the message count, because the row count understates the damage', () => {
    const body = describeDelete(summariseSelection(new Set(['a', 'b']), LIST));
    expect(body).toContain('2 conversations');
    expect(body).toContain('52 messages');
  });

  it('calls out pinned rows, since pinning is the signal they matter', () => {
    const body = describeDelete(summariseSelection(new Set(['a', 'b']), LIST));
    expect(body).toContain('1 of them is pinned');
  });

  it('says nothing about pinning when nothing is pinned', () => {
    expect(describeDelete(summariseSelection(new Set(['b']), LIST))).not.toContain('pinned');
  });

  it('offers the reversible alternative and admits there is no undo', () => {
    const body = describeDelete(summariseSelection(new Set(['a']), LIST));
    expect(body).toContain('cannot be undone');
    expect(body).toContain('archiving');
  });

  it('promises that usage history survives', () => {
    // Pre-empting a real worry: the usage dashboard is the only record of money
    // spent, and a user who thinks deleting a thread falsifies it will not
    // delete anything.
    expect(describeDelete(summariseSelection(new Set(['a']), LIST))).toContain('Usage history is kept');
  });

  it('uses singular verbs for a single pinned conversation and plural for several', () => {
    const one = describeDelete(summariseSelection(new Set(['a']), LIST));
    const list = [
      conversation({ id: 'p', pinned: true, messageCount: 1 }),
      conversation({ id: 'q', pinned: true, messageCount: 1 }),
    ];
    const two = describeDelete(summariseSelection(new Set(['p', 'q']), list));
    expect(one).toContain('1 of them is pinned');
    expect(two).toContain('2 of them are pinned');
  });
});

describe('what archiving the selection would actually do', () => {
  it('separates the rows that would move from the ones already there', () => {
    // A selection can span both states, because the archive is multi-selectable
    // too. The button must not promise a number that includes rows it will not
    // touch.
    const summary = summariseSelection(new Set(['a', 'b', 'c']), LIST);
    expect(archiveEffect(summary, true)).toEqual({ changing: 2, already: 1 });
    expect(archiveEffect(summary, false)).toEqual({ changing: 1, already: 2 });
  });

  it('reports nothing to do when the whole selection is already in that state', () => {
    const summary = summariseSelection(new Set(['c']), LIST);
    expect(archiveEffect(summary, true)).toEqual({ changing: 0, already: 1 });
  });
});
