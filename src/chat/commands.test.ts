import {
  APP_COMMANDS,
  buildCommandIndex,
  buildMentionIndex,
  commandName,
  commandQuery,
  mentionQuery,
  rankCommands,
  replaceMention,
  uniqueNames,
} from '@/chat/commands';
import type { CommandItem } from '@/chat/commands';

describe('commandQuery', () => {
  it('is null for an ordinary draft', () => {
    expect(commandQuery('review this diff')).toBeNull();
    expect(commandQuery('')).toBeNull();
  });

  it('opens the full list on a bare slash', () => {
    expect(commandQuery('/')).toBe('');
  });

  it('reads the word after the slash, lowercased', () => {
    expect(commandQuery('/Model')).toBe('model');
  });

  it('stops being a command once there is a space', () => {
    // The failure this prevents: a menu covering the keyboard while someone types
    // "/usr/local/bin is on my path".
    expect(commandQuery('/model please')).toBeNull();
    expect(commandQuery('/usr/local/bin is on my path')).toBeNull();
  });

  it('stops at a newline', () => {
    expect(commandQuery('/model\n')).toBeNull();
  });

  it('gives up on something too long to be a command', () => {
    expect(commandQuery(`/${'a'.repeat(60)}`)).toBeNull();
  });
});

describe('rankCommands', () => {
  const items: CommandItem[] = [
    { kind: 'prompt', id: 'p1', name: 'model-notes', label: 'Model notes' },
    { kind: 'app', id: 'model', name: 'model', label: 'Model' },
    { kind: 'skill', id: 's1', name: 'pdf-processing', label: 'pdf-processing' },
  ];

  it('returns everything for an empty query', () => {
    expect(rankCommands(items, '')).toHaveLength(3);
  });

  it('puts an exact name match first', () => {
    expect(rankCommands(items, 'model')[0]?.id).toBe('model');
  });

  it('prefers a prefix over a substring', () => {
    const ranked = rankCommands(items, 'pdf');
    expect(ranked[0]?.id).toBe('s1');
  });

  it('excludes what does not match at all', () => {
    expect(rankCommands(items, 'zzz')).toEqual([]);
  });

  it('breaks a tie by kind, app commands first', () => {
    const tied: CommandItem[] = [
      { kind: 'prompt', id: 'p', name: 'export-notes', label: 'Export notes' },
      { kind: 'app', id: 'export', name: 'export', label: 'Export' },
    ];
    expect(rankCommands(tied, 'expo').map((item) => item.id)).toEqual(['export', 'p']);
  });

  it('honours the limit', () => {
    expect(rankCommands(items, '', 2)).toHaveLength(2);
  });
});

describe('commandName', () => {
  it('slugifies a free-text title', () => {
    expect(commandName('Review this diff (strict)')).toBe('review-this-diff-strict');
  });

  it('never returns an empty name', () => {
    expect(commandName('!!!')).toBe('untitled');
  });
});

describe('uniqueNames', () => {
  it('suffixes a collision rather than shadowing it', () => {
    const items: CommandItem[] = [
      { kind: 'prompt', id: 'a', name: 'review', label: 'Review' },
      { kind: 'prompt', id: 'b', name: 'review', label: 'Review' },
      { kind: 'prompt', id: 'c', name: 'review', label: 'Review' },
    ];
    expect(uniqueNames(items).map((item) => item.name)).toEqual(['review', 'review-2', 'review-3']);
  });

  it('leaves a unique index untouched by identity', () => {
    const items: CommandItem[] = [{ kind: 'app', id: 'model', name: 'model', label: 'Model' }];
    expect(uniqueNames(items)[0]).toBe(items[0]);
  });
});

describe('buildCommandIndex', () => {
  const index = buildCommandIndex({
    prompts: [{ id: 'p1', title: 'Review this diff', body: '\nReview {{diff}} for correctness.\n' }],
    skills: [{ name: 'pdf-processing', description: 'Extracts tables from a PDF.' }],
    mcpPrompts: [{ serverId: 's', serverName: 'Notes', name: 'daily', description: '' }],
  });

  it('carries every source', () => {
    expect(index.filter((item) => item.kind === 'prompt')).toHaveLength(1);
    expect(index.filter((item) => item.kind === 'skill')).toHaveLength(1);
    expect(index.filter((item) => item.kind === 'mcp-prompt')).toHaveLength(1);
    expect(index.filter((item) => item.kind === 'app')).toHaveLength(APP_COMMANDS.length);
  });

  it('previews a template with its first non-blank line', () => {
    expect(index.find((item) => item.id === 'p1')?.hint).toBe('Review {{diff}} for correctness.');
  });

  it('falls back to the server name when an MCP prompt has no description', () => {
    expect(index.find((item) => item.kind === 'mcp-prompt')?.hint).toBe('Notes');
  });

  it('keeps app commands first so a learned name always wins', () => {
    expect(index[0]?.kind).toBe('app');
  });
});

describe('mentionQuery', () => {
  it('is null for a draft with no mention', () => {
    expect(mentionQuery('summarise the report')).toBeNull();
    expect(mentionQuery('')).toBeNull();
  });

  it('opens the full list on a bare at-sign', () => {
    expect(mentionQuery('@')).toBe('');
    expect(mentionQuery('summarise @')).toBe('');
  });

  it('reads the word being typed at the end of a sentence, lowercased', () => {
    expect(mentionQuery('summarise @Report')).toBe('report');
  });

  it('leaves an email address alone', () => {
    // The failure this prevents: a list opening over the keyboard every time someone
    // types an address into a message.
    expect(mentionQuery('write to ada@example')).toBeNull();
  });

  it('closes once the mention is finished', () => {
    expect(mentionQuery('summarise @report.md and stop')).toBeNull();
  });

  it('gives up on something too long to be a name', () => {
    expect(mentionQuery(`@${'a'.repeat(60)}`)).toBeNull();
  });
});

describe('replaceMention', () => {
  it('completes the token in place and keeps the sentence', () => {
    expect(replaceMention('summarise @rep', 'report-md')).toBe('summarise @report-md ');
  });

  it('completes a bare at-sign', () => {
    expect(replaceMention('@', 'report-md')).toBe('@report-md ');
  });

  it('leaves a draft with no mention untouched', () => {
    expect(replaceMention('summarise the report', 'report-md')).toBe('summarise the report');
  });
});

describe('buildMentionIndex', () => {
  const index = buildMentionIndex({
    files: [{ name: 'Q3 report.pdf', uri: 'file:///docs/q3.pdf', hint: '412 kB' }],
    skills: [{ name: 'pdf-processing', description: 'Extracts tables from a PDF.' }],
    servers: [{ id: 'notes', name: 'notes', hint: 'https://mcp.example/notes' }],
  });

  it('carries every source', () => {
    expect(index.map((item) => item.kind)).toEqual(['file', 'skill', 'server']);
  });

  it('makes a file name typeable but keeps the real one on the row', () => {
    expect(index[0]?.name).toBe('q3-report-pdf');
    expect(index[0]?.label).toBe('Q3 report.pdf');
  });

  it('dispatches a file on its uri and a server on its name', () => {
    // `config.servers` stores names, so the id has to be the name and not a row id.
    expect(index[0]?.id).toBe('file:///docs/q3.pdf');
    expect(index[2]?.id).toBe('notes');
  });

  it('is ranked by the same function the slash list uses', () => {
    expect(rankCommands(index, 'pdf')[0]?.kind).toBe('skill');
  });
});
