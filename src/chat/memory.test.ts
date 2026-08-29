/**
 * Memory rules.
 *
 * The four failure modes the module was written against are the four groups
 * below, in the same order: unbounded prompt cost, untrusted model output, secret
 * leakage, and duplicate memories. Each group asserts the behaviour that keeps
 * the failure from happening rather than the implementation that achieves it.
 */

import {
  DISTIL_EVERY_TURNS,
  MAX_MEMORY_CHARS,
  MAX_PER_TURN,
  MEMORY_BUDGET_CHARS,
  isSafeToRemember,
  mergeMemories,
  normaliseMemoryText,
  parseMemory,
  rankMemories,
  renderMemoryBlock,
  sameMemory,
  shouldDistil,
} from '@/chat/memory';
import type { Memory, MemoryKind } from '@/chat/memory';
import { clearRegisteredSecrets, registerSecret } from '@/lib/redact';

const NOW = 1_700_000_000_000;

function memory(overrides: Partial<Memory> & { text: string }): Memory {
  return {
    id: overrides.text.slice(0, 8),
    kind: 'fact' as MemoryKind,
    createdAt: NOW,
    updatedAt: NOW,
    hits: 1,
    pinned: false,
    ...overrides,
  };
}

describe('the distillation throttle', () => {
  it('never fires while memory is off', () => {
    for (let turns = 0; turns < 20; turns += 1) {
      expect(shouldDistil({ enabled: false, assistantTurns: turns })).toBe(false);
    }
  });

  it('never fires before the first assistant turn', () => {
    expect(shouldDistil({ enabled: true, assistantTurns: 0 })).toBe(false);
  });

  it('fires once every few turns rather than on every one', () => {
    const fired = [];
    for (let turns = 1; turns <= 20; turns += 1) {
      if (shouldDistil({ enabled: true, assistantTurns: turns })) fired.push(turns);
    }
    expect(fired).toEqual([DISTIL_EVERY_TURNS, DISTIL_EVERY_TURNS * 2, DISTIL_EVERY_TURNS * 3, DISTIL_EVERY_TURNS * 4, DISTIL_EVERY_TURNS * 5]);
  });
});

describe('parsing a distillation response', () => {
  it('reads a bare array', () => {
    const out = parseMemory('[{"kind":"preference","text":"prefers TypeScript over JavaScript"}]');
    expect(out).toEqual([{ kind: 'preference', text: 'prefers TypeScript over JavaScript' }]);
  });

  it('reads an array inside a fenced block with a preamble', () => {
    const raw = [
      'Sure! Here is what I learned:',
      '```json',
      '[{"kind": "fact", "text": "runs Postgres 16 in production"}]',
      '```',
      'Let me know if you want more.',
    ].join('\n');
    expect(parseMemory(raw)).toEqual([{ kind: 'fact', text: 'runs Postgres 16 in production' }]);
  });

  it('treats the empty array as the empty answer it is', () => {
    expect(parseMemory('[]')).toEqual([]);
    expect(parseMemory('Nothing durable came up. []')).toEqual([]);
  });

  it('yields nothing for prose, refusals and truncated JSON', () => {
    expect(parseMemory('I did not learn anything durable about the user.')).toEqual([]);
    expect(parseMemory('[{"kind":"fact","text":"runs Postgres')).toEqual([]);
    expect(parseMemory('')).toEqual([]);
  });

  it('stops at the array rather than swallowing trailing prose', () => {
    // The naive first-`[`-to-last-`]` scan would hand JSON.parse a fragment
    // ending in a sentence and get nothing at all.
    const raw = 'Here it is: [{"kind":"style","text":"wants short replies"}]. Anything else [maybe]?';
    expect(parseMemory(raw)).toEqual([{ kind: 'style', text: 'wants short replies' }]);
  });

  it('drops entries with an unknown kind or a missing text', () => {
    const raw = JSON.stringify([
      { kind: 'vibes', text: 'likes the colour blue' },
      { kind: 'fact' },
      { text: 'no kind at all' },
      null,
      'a bare string',
      { kind: 'project', text: 'is building a mobile chat client' },
    ]);
    expect(parseMemory(raw)).toEqual([{ kind: 'project', text: 'is building a mobile chat client' }]);
  });

  it('refuses a memory longer than one sentence rather than truncating it', () => {
    const long = 'x'.repeat(MAX_MEMORY_CHARS + 1);
    expect(parseMemory(JSON.stringify([{ kind: 'fact', text: long }]))).toEqual([]);
  });

  it('caps how much a single turn can learn', () => {
    // Deliberately unrelated sentences: near-duplicates would be folded by
    // `sameMemory` first, and then this would be testing the wrong limit.
    const subjects = [
      'runs Postgres in production',
      'commutes by bicycle every morning',
      'maintains an open source parser',
      'writes documentation before code',
      'reviews pull requests on Fridays',
      'keeps a paper notebook for design',
      'dislikes emoji in commit messages',
      'works from a coffee shop on Tuesdays',
      'has three monitors at their desk',
      'learned Rust last winter',
      'teaches an evening class',
    ];
    const many = subjects.map((text) => ({ kind: 'fact', text }));
    expect(many.length).toBeGreaterThan(MAX_PER_TURN);
    expect(parseMemory(JSON.stringify(many))).toHaveLength(MAX_PER_TURN);
  });

  it('normalises the wrapping a model puts around a sentence', () => {
    expect(normaliseMemoryText('  - "prefers   dark   mode"  ')).toBe('prefers dark mode');
    expect(normaliseMemoryText('1. works\nin\tEurope')).toBe('works in Europe');
    expect(normaliseMemoryText('* `uses pnpm`')).toBe('uses pnpm');
  });
});

describe('the secret screen', () => {
  afterEach(() => {
    clearRegisteredSecrets();
  });

  it('refuses anything redaction would alter', () => {
    registerSecret('sk-ant-supersecretvalue0123456789');
    expect(isSafeToRemember('prefers TypeScript')).toBe(true);
    expect(isSafeToRemember('the key is sk-ant-supersecretvalue0123456789')).toBe(false);
  });

  it('drops an unsafe candidate instead of storing it redacted', () => {
    registerSecret('sk-ant-supersecretvalue0123456789');
    const raw = JSON.stringify([
      { kind: 'fact', text: 'their API key is sk-ant-supersecretvalue0123456789' },
      { kind: 'fact', text: 'deploys from a laptop' },
    ]);
    const out = parseMemory(raw);
    expect(out).toEqual([{ kind: 'fact', text: 'deploys from a laptop' }]);
    // Not merely absent — no redacted stand-in was written either.
    expect(JSON.stringify(out)).not.toContain('REDACTED');
  });
});

describe('near-duplicate folding', () => {
  it('recognises the same statement in different words', () => {
    expect(sameMemory('prefers TypeScript over JavaScript', 'prefers TypeScript over JavaScript')).toBe(true);
    expect(sameMemory('prefers TypeScript over JavaScript', 'the user prefers TypeScript over JavaScript')).toBe(true);
  });

  it('keeps genuinely different statements apart', () => {
    expect(sameMemory('prefers TypeScript over JavaScript', 'runs Postgres 16 in production')).toBe(false);
    expect(sameMemory('prefers dark mode', 'prefers light mode')).toBe(false);
  });

  it('confirms an existing memory instead of adding a second row', () => {
    const existing = [memory({ id: 'm1', kind: 'preference', text: 'prefers TypeScript over JavaScript' })];
    const merge = mergeMemories(existing, [
      { kind: 'preference', text: 'the user prefers TypeScript over JavaScript' },
      { kind: 'fact', text: 'runs Postgres 16 in production' },
    ]);
    expect(merge.confirmed).toEqual(['m1']);
    expect(merge.additions).toEqual([{ kind: 'fact', text: 'runs Postgres 16 in production' }]);
  });

  it('does not add the same thing twice from one response', () => {
    const merge = mergeMemories([], [
      { kind: 'style', text: 'wants short replies without preamble' },
      { kind: 'style', text: 'wants replies that are short and without preamble' },
    ]);
    expect(merge.additions).toHaveLength(1);
  });

  it('treats the same sentence under two kinds as two memories', () => {
    // The store's uniqueness is (kind, text), and the distinction is meaningful:
    // "writes terse commits" as a style is an instruction, as a fact it is not.
    const merge = mergeMemories([], [
      { kind: 'style', text: 'writes terse commit messages' },
      { kind: 'fact', text: 'writes terse commit messages' },
    ]);
    expect(merge.additions).toHaveLength(2);
  });
});

describe('the prompt block', () => {
  it('says nothing when there is nothing to say', () => {
    const block = renderMemoryBlock([]);
    expect(block.text).toBeUndefined();
    expect(block.chars).toBe(0);
    expect(block.included).toEqual([]);
  });

  it('groups by kind and subordinates itself to the user', () => {
    const block = renderMemoryBlock([
      memory({ id: 'a', kind: 'preference', text: 'prefers TypeScript' }),
      memory({ id: 'b', kind: 'fact', text: 'runs Postgres 16' }),
      memory({ id: 'c', kind: 'style', text: 'wants short replies' }),
    ]);
    expect(block.text).toContain('# What you know about this user');
    expect(block.text).toContain('## Preferences');
    expect(block.text).toContain('## Facts');
    expect(block.text).toContain('- prefers TypeScript');
    // The line that stops a stale preference outranking today's instruction.
    expect(block.text).toContain('the notes lose');
    expect(block.dropped).toBe(0);
  });

  it('stays inside the budget and says how much it left out', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      memory({ id: `m${i}`, text: `holds opinion number ${i} about a tool they use daily` }),
    );
    const block = renderMemoryBlock(many);
    expect(block.included.length).toBeLessThan(many.length);
    expect(block.dropped).toBe(many.length - block.included.length);
    // The budget bounds the list, not the whole block: the heading and the
    // omission notice are fixed overhead on top.
    const listChars = block.included.reduce((sum, m) => sum + m.text.length + 3, 0);
    expect(listChars).toBeLessThanOrEqual(MEMORY_BUDGET_CHARS);
    expect(block.text).toContain('omitted to save space');
  });

  it('keeps pinned memories when the budget is tight', () => {
    const pinned = memory({ id: 'pin', text: 'is the one thing that must survive the budget', pinned: true });
    const filler = Array.from({ length: 200 }, (_, i) =>
      memory({ id: `m${i}`, text: `holds opinion number ${i} about a tool they use daily`, hits: 9 }),
    );
    const block = renderMemoryBlock([...filler, pinned]);
    expect(block.included.map((m) => m.id)).toContain('pin');
  });

  it('ranks by confirmation before recency', () => {
    const ranked = rankMemories([
      memory({ id: 'new', text: 'mentioned once last night', hits: 1, updatedAt: NOW + 1_000 }),
      memory({ id: 'often', text: 'has said this every week for a month', hits: 7, updatedAt: NOW }),
      memory({ id: 'pinned', text: 'was pinned by hand', hits: 1, updatedAt: NOW - 1_000, pinned: true }),
    ]);
    expect(ranked.map((m) => m.id)).toEqual(['pinned', 'often', 'new']);
  });

  it('is deterministic for memories that tie on every ranking key', () => {
    const a = memory({ id: 'a', text: 'one thing', updatedAt: NOW });
    const b = memory({ id: 'b', text: 'another thing', updatedAt: NOW });
    expect(rankMemories([b, a]).map((m) => m.id)).toEqual(rankMemories([a, b]).map((m) => m.id));
  });
});
