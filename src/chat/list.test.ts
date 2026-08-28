import {
  buildRows,
  filterConversations,
  matchesQuery,
  parseTags,
  PINNED_LABEL,
  rowTime,
  tagCounts,
} from '@/chat/list';
import type { Conversation } from '@/db/conversations';

function noon(year: number, month: number, day: number): number {
  return new Date(year, month, day, 12, 0, 0, 0).getTime();
}

const NOW = noon(2026, 5, 15);

let nextId = 0;

function conv(over: Partial<Conversation> = {}): Conversation {
  nextId += 1;
  return {
    id: `c${nextId}`,
    title: 'New conversation',
    createdAt: NOW,
    updatedAt: NOW,
    pinned: false,
    archived: false,
    profileId: 'agentrouter-anthropic',
    model: 'claude-opus-4-6',
    config: {},
    tags: [],
    ...over,
  };
}

/** The conversation ids of the conversation rows, in order. */
function ids(rows: ReturnType<typeof buildRows>): string[] {
  return rows.flatMap((row) => (row.kind === 'conversation' ? [row.conversation.id] : []));
}

function headers(rows: ReturnType<typeof buildRows>): { label: string; count: number }[] {
  return rows.flatMap((row) => (row.kind === 'header' ? [{ label: row.label, count: row.count }] : []));
}

describe('matchesQuery', () => {
  it('matches an empty query against everything', () => {
    expect(matchesQuery(conv(), '')).toBe(true);
    expect(matchesQuery(conv(), '   ')).toBe(true);
  });

  it('searches the fields the row displays', () => {
    const c = conv({
      title: 'Context window maths',
      preview: 'How many tokens does a thinking block cost?',
      model: 'claude-opus-4-8',
      tags: ['research', 'Billing'],
    });
    expect(matchesQuery(c, 'context')).toBe(true);
    expect(matchesQuery(c, 'thinking')).toBe(true);
    expect(matchesQuery(c, '4-8')).toBe(true);
    expect(matchesQuery(c, 'billing')).toBe(true);
    expect(matchesQuery(c, 'nowhere')).toBe(false);
  });

  it('does not search the system prompt', () => {
    // Deliberate: a hit with nothing on the row to justify it looks like a bug.
    const c = conv({ systemPrompt: 'You are a helpful assistant' });
    expect(matchesQuery(c, 'helpful')).toBe(false);
  });

  it('is case-insensitive in both directions', () => {
    const c = conv({ title: 'Gateway Quirks' });
    expect(matchesQuery(c, 'gateway')).toBe(true);
    expect(matchesQuery(c, 'GATEWAY')).toBe(true);
    expect(matchesQuery(c, 'QuIrKs')).toBe(true);
  });

  it('ANDs separate terms across fields', () => {
    const c = conv({ title: 'Retry policy', preview: 'exponential backoff', tags: ['transport'] });
    expect(matchesQuery(c, 'retry backoff')).toBe(true);
    expect(matchesQuery(c, 'retry transport')).toBe(true);
    expect(matchesQuery(c, 'retry missing')).toBe(false);
  });

  it('honours a quoted phrase', () => {
    const c = conv({ preview: 'the context window is not the output limit' });
    expect(matchesQuery(c, '"context window"')).toBe(true);
    expect(matchesQuery(c, '"window context"')).toBe(false);
  });

  it('ignores punctuation-only input rather than matching nothing', () => {
    // `highlightTerms` drops fragments with no letter or digit, so a query of `?`
    // has no needles and must not filter the list to empty.
    expect(matchesQuery(conv({ title: 'anything' }), '???')).toBe(true);
  });

  it('does not match across a field boundary', () => {
    // Fields are joined with a newline so a term cannot span two of them.
    const c = conv({ title: 'alpha', preview: 'beta' });
    expect(matchesQuery(c, 'alphabeta')).toBe(false);
  });
});

describe('filterConversations', () => {
  it('returns a copy when there is nothing to filter by', () => {
    const list = [conv(), conv()];
    const out = filterConversations(list);
    expect(out).toEqual(list);
    expect(out).not.toBe(list);
  });

  it('filters by tag exactly, ignoring case', () => {
    const work = conv({ tags: ['Work'] });
    const workshop = conv({ tags: ['workshop'] });
    const none = conv();
    const out = filterConversations([work, workshop, none], { tag: 'work' });
    expect(out.map((c) => c.id)).toEqual([work.id]);
  });

  it('combines tag and query', () => {
    const a = conv({ title: 'retry policy', tags: ['transport'] });
    const b = conv({ title: 'retry policy', tags: ['ui'] });
    const c = conv({ title: 'theme colours', tags: ['transport'] });
    const out = filterConversations([a, b, c], { tag: 'transport', query: 'retry' });
    expect(out.map((x) => x.id)).toEqual([a.id]);
  });

  it('preserves input order', () => {
    const a = conv({ title: 'one alpha' });
    const b = conv({ title: 'two alpha' });
    const c = conv({ title: 'three alpha' });
    const out = filterConversations([c, a, b], { query: 'alpha' });
    expect(out.map((x) => x.id)).toEqual([c.id, a.id, b.id]);
  });
});

describe('rowTime', () => {
  it('uses updatedAt, so headings agree with the database ordering', () => {
    const c = conv({ updatedAt: 500, lastMessageAt: 100 });
    expect(rowTime(c)).toBe(500);
  });
});

describe('buildRows', () => {
  it('is empty for no conversations', () => {
    expect(buildRows([], NOW)).toEqual([]);
  });

  it('heads each group and counts it', () => {
    const rows = buildRows(
      [
        conv({ updatedAt: NOW }),
        conv({ updatedAt: NOW - 60_000 }),
        conv({ updatedAt: noon(2026, 5, 14) }),
        conv({ updatedAt: noon(2026, 5, 11) }),
        conv({ updatedAt: noon(2026, 2, 1) }),
      ],
      NOW,
    );
    expect(headers(rows)).toEqual([
      { label: 'Today', count: 2 },
      { label: 'Yesterday', count: 1 },
      { label: 'Earlier this week', count: 1 },
      { label: 'Older', count: 1 },
    ]);
  });

  it('omits a heading for an empty group', () => {
    const rows = buildRows([conv({ updatedAt: noon(2026, 0, 1) })], NOW);
    expect(headers(rows)).toEqual([{ label: 'Older', count: 1 }]);
  });

  it('puts pinned conversations first whatever their age', () => {
    const oldPin = conv({ updatedAt: noon(2020, 0, 1), pinned: true });
    const today = conv({ updatedAt: NOW });
    const rows = buildRows([today, oldPin], NOW);
    expect(headers(rows)[0]).toEqual({ label: PINNED_LABEL, count: 1 });
    expect(ids(rows)).toEqual([oldPin.id, today.id]);
  });

  it('emits one heading per group even when the input is unsorted', () => {
    // A header-on-change scan would print "Today" twice here. The rows are ordered
    // by the caller's SQL, and a config write that did not bump `updated_at` can
    // leave two rows out of order without it being a bug worth reordering around.
    const a = conv({ updatedAt: NOW });
    const old = conv({ updatedAt: noon(2020, 0, 1) });
    const b = conv({ updatedAt: NOW - 1_000 });
    const rows = buildRows([a, old, b], NOW);
    expect(headers(rows)).toEqual([
      { label: 'Today', count: 2 },
      { label: 'Older', count: 1 },
    ]);
    expect(ids(rows)).toEqual([a.id, b.id, old.id]);
  });

  it('preserves relative order inside a group', () => {
    const first = conv({ updatedAt: NOW - 1_000 });
    const second = conv({ updatedAt: NOW - 9_000 });
    const third = conv({ updatedAt: NOW - 5_000 });
    const rows = buildRows([first, second, third], NOW);
    expect(ids(rows)).toEqual([first.id, second.id, third.id]);
  });

  it('gives every row a distinct key', () => {
    const rows = buildRows(
      [conv({ pinned: true }), conv(), conv({ updatedAt: noon(2026, 5, 14) })],
      NOW,
    );
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('tagCounts', () => {
  it('counts by use, then alphabetically', () => {
    const list = [
      conv({ tags: ['work', 'zeta'] }),
      conv({ tags: ['work', 'alpha'] }),
      conv({ tags: ['work'] }),
    ];
    expect(tagCounts(list)).toEqual([
      { tag: 'work', count: 3 },
      { tag: 'alpha', count: 1 },
      { tag: 'zeta', count: 1 },
    ]);
  });

  it('is empty when nothing is tagged', () => {
    expect(tagCounts([conv(), conv()])).toEqual([]);
  });
});

describe('parseTags', () => {
  it('splits on commas and trims', () => {
    expect(parseTags('work, research ,  billing')).toEqual(['work', 'research', 'billing']);
  });

  it('collapses inner whitespace', () => {
    expect(parseTags('context   window')).toEqual(['context window']);
  });

  it('drops empties', () => {
    expect(parseTags('')).toEqual([]);
    expect(parseTags(' , , ')).toEqual([]);
    expect(parseTags('work,,research')).toEqual(['work', 'research']);
  });

  it('deduplicates case-insensitively, keeping the first spelling', () => {
    expect(parseTags('Work, work, WORK')).toEqual(['Work']);
  });
});
